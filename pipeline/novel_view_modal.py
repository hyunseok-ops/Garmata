"""Novel-view generation on Modal with Stable Virtual Camera (SEVA) — docs/PLAN.md §8-§11.

Input on the `gi-splats` volume:  novel/<listingId>/scene/{images/NNN.png, transforms.json, train_test_split_<N>.json}
  (written by the desktop app's GI_NOVEL_PREP: real photos at their ring slots, generated slots with file_path null)
Output:                           novel/<listingId>/posed/{input/, samples-rgb/, transforms.json}  (Nerfstudio-ready)
                                  novel/<listingId>/generated/NNN.png                              (one image per azimuth)

SEVA renders every null-path frame from the exact camera we asked for, conditioned on the real photos, so the posed
dataset needs no feature matching. Weights are gated (Stability AI Non-Commercial License): the Hugging Face account
behind the Modal `huggingface` secret must accept the license at https://huggingface.co/stabilityai/stable-virtual-camera.

  uvx modal deploy pipeline/novel_view_modal.py
  uvx modal run pipeline/novel_view_modal.py --check          # is the gated model reachable?
"""
import json
import os
import pathlib
import shutil
import subprocess
import threading
import time

import modal

SEVA_COMMIT = "fe19948e9b7bea261ab2db780a59656131404a83"  # ponytail: pinned; bump deliberately
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.6.0", "torchvision==0.21.0", index_url="https://download.pytorch.org/whl/cu124")
    .run_commands(
        f"git clone https://github.com/Stability-AI/stable-virtual-camera.git /seva && cd /seva && git checkout {SEVA_COMMIT}",
        "cd /seva && pip install -e .",
        # Imported at module load by seva/geometry.py and seva/data_io.py but missing from SEVA's pyproject.
        'pip install "numpy==1.24.4" "scipy<1.14" "opencv-python-headless<4.11"',
        # stabilityai/stable-diffusion-2-1-base was removed from Hugging Face. SEVA only needs its VAE; this mirror's
        # vae/diffusion_pytorch_model.safetensors has the same sha256 (a1d99348...) as an independent second mirror.
        "sed -i 's#stabilityai/stable-diffusion-2-1-base#sd2-community/stable-diffusion-2-1-base#' /seva/seva/modules/autoencoder.py",
        "grep -q sd2-community /seva/seva/modules/autoencoder.py",
    )
)
app = modal.App("garage-intelligence-novel-view", image=image)
# Separate image for matting so rembg's dependencies can't disturb SEVA's pinned stack (numpy 1.24, torch 2.6).
matte_image = modal.Image.debian_slim(python_version="3.11").pip_install("rembg[cpu]==2.0.67", "pillow", "numpy")
vol = modal.Volume.from_name("gi-splats", create_if_missing=True)
progress = modal.Dict.from_name("gi-progress", create_if_missing=True)
DATA = pathlib.Path("/data")
# Deploy with GI_HF_SECRET=gi-huggingface to use your own token (an account that accepted the SEVA license).
HF = modal.Secret.from_name(os.environ.get("GI_HF_SECRET", "huggingface"))


def _report(key: str, stage: str, current: int | None = None, total: int | None = None, message: str | None = None) -> None:
    if key:
        progress[key] = json.dumps({"stage": stage, "current": current, "total": total, "message": message, "at": time.time()})


@app.function(secrets=[HF], timeout=120)
def check_access() -> str:
    import os

    from huggingface_hub import get_hf_file_metadata, hf_hub_url

    try:
        meta = get_hf_file_metadata(hf_hub_url("stabilityai/stable-virtual-camera", "model.safetensors"), token=os.environ.get("HF_TOKEN"))
        return f"ok: model.safetensors {meta.size / 1e9:.1f} GB"
    except Exception as e:
        return f"no access: {type(e).__name__}: {str(e)[:200]}"


@app.function(gpu="H100", timeout=3600, volumes={str(DATA): vol}, secrets=[HF])
def generate_views(listing_id: str, progress_key: str = "", cfg: float = 2.0, seed: int = 23) -> dict:
    t0 = time.time()
    try:
        vol.reload()
        root = DATA / "novel" / listing_id
        scene_src = root / "scene"
        splits = sorted(scene_src.glob("train_test_split_*.json"))
        if len(splits) != 1:
            raise RuntimeError(f"expected exactly one train_test_split file, found {[p.name for p in splits]}")
        split_file = splits[0]
        num_inputs = int(split_file.stem.rsplit("_", 1)[-1])
        split = json.loads(split_file.read_text())
        num_targets = len(split["test_ids"])
        meta = json.loads((scene_src / "transforms.json").read_text())

        norm = normalize_inputs.remote(str(scene_src.relative_to(DATA)))
        print("view normalization:", json.dumps(norm), flush=True)
        (root / "logs").mkdir(parents=True, exist_ok=True)
        (root / "logs" / "normalization.json").write_text(json.dumps(norm, indent=2))
        vol.reload()
        work_in = pathlib.Path("/tmp/in")
        shutil.rmtree(work_in, ignore_errors=True)
        shutil.copytree(scene_src, work_in / "scene")
        out_dir = pathlib.Path("/seva/work_dirs/demo/img2img/scene")
        shutil.rmtree(out_dir, ignore_errors=True)

        _report(progress_key, "generating_views", 0, num_targets, f"Conditioning on {num_inputs} real photos")
        done = threading.Event()

        def watch() -> None:  # SEVA writes target frames into samples-rgb/ as chunks finish
            while not done.wait(5):
                n = len(list((out_dir / "samples-rgb").glob("*.png"))) if (out_dir / "samples-rgb").exists() else 0
                _report(progress_key, "generating_views", min(n, num_targets), num_targets)

        threading.Thread(target=watch, daemon=True).start()
        cmd = ["python", "demo.py", "--data_path", str(work_in), "--data_items", "scene", "--task", "img2img",
               "--num_inputs", str(num_inputs), "--H", str(meta["h"]), "--W", str(meta["w"]), "--cfg", str(cfg),
               "--seed", str(seed), "--video_save_fps", "10"]
        if num_inputs >= 9:
            # Semi-dense inputs: SEVA's plain chunking crashes here (T becomes [first, second] pass lengths), and its
            # docs recommend the orbit trajectory prior + nearest-gt chunking for object-centric orbits anyway.
            cmd += ["--use_traj_prior", "True", "--traj_prior", "orbit", "--chunk_strategy", "nearest-gt"]
        print("$", " ".join(cmd), flush=True)
        proc = subprocess.run(cmd, cwd="/seva", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        done.set()
        (root / "logs").mkdir(parents=True, exist_ok=True)
        (root / "logs" / "seva.log").write_text(proc.stdout)
        vol.commit()
        print(proc.stdout[-4000:], flush=True)
        if proc.returncode:
            raise RuntimeError(f"SEVA failed ({proc.returncode}): {proc.stdout[-800:]}")

        # Posed dataset for Splatfacto: SEVA's own transforms.json (OpenGL c2w, per-frame intrinsics at output size).
        posed = root / "posed"
        shutil.rmtree(posed, ignore_errors=True)
        shutil.copytree(out_dir, posed, ignore=shutil.ignore_patterns("*.mp4"))
        posed_meta = json.loads((posed / "transforms.json").read_text())
        # SEVA writes 3x4 camera-to-world matrices; Nerfstudio's pose math needs 4x4. Values are our ring poses.
        for f in posed_meta["frames"]:
            if len(f["transform_matrix"]) == 3:
                f["transform_matrix"] = f["transform_matrix"] + [[0.0, 0.0, 0.0, 1.0]]
        if len(posed_meta["frames"]) != len(meta["frames"]):
            raise RuntimeError(f"SEVA returned {len(posed_meta['frames'])} frames, expected {len(meta['frames'])}")
        # Input-only frames (regenerateReals) conditioned SEVA; reconstruction trains on the ring frames only.
        # Output order = input order; sort the kept frames back into ring order (azimuth) for validation and training.
        keep = sorted((i for i, f in enumerate(meta["frames"]) if not f.get("input_only")), key=lambda i: meta["frames"][i]["azimuth"])
        posed_meta["frames"] = [posed_meta["frames"][i] for i in keep]
        (posed / "transforms.json").write_text(json.dumps(posed_meta, indent=2))
        frames = posed_meta["frames"]
        meta["frames"] = [meta["frames"][i] for i in keep]
        # One image per azimuth for manual inspection (§8): frame order is preserved (sorted train+test indices).
        generated = root / "generated"
        shutil.rmtree(generated, ignore_errors=True)
        generated.mkdir(parents=True)
        for f_in, f_out in zip(meta["frames"], frames):
            shutil.copy(posed / f_out["file_path"], generated / f"{int(f_in['azimuth']):03d}.png")
        vol.commit()
        if not meta.get("keep_background"):
            matte.remote(str(posed.relative_to(DATA)), progress_key)
        vol.reload()
        for f_in, f_out in zip(meta["frames"], frames):  # inspection copies get the matted frames too
            shutil.copy(posed / f_out["file_path"], generated / f"{int(f_in['azimuth']):03d}.png")
        vol.commit()
        _report(progress_key, "generating_views", num_targets, num_targets, "Views generated")
        return {"inputs": num_inputs, "targets": num_targets, "w": meta["w"], "h": meta["h"], "seconds": round(time.time() - t0)}
    except Exception as e:
        _report(progress_key, "failed", message=str(e)[:300])
        raise


def _project_bbox(c2w: list, fl: float, cx: float, cy: float, box: dict) -> tuple[float, float, float, float]:
    """2D bbox (x0, y0, x1, y1) of the assumed vehicle box seen by an OpenGL camera (looks down -Z, +Y up)."""
    import itertools

    import numpy as np

    w2c = np.linalg.inv(np.array(c2w, dtype=float))
    pts = []
    for x, y, z in itertools.product(*zip(box["min"], box["max"])):
        X, Y, Z, _ = w2c @ np.array([x, y, z, 1.0])
        pts.append((cx + fl * X / -Z, cy - fl * Y / -Z))
    xs, ys = zip(*pts)
    return float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))


@app.function(image=matte_image, cpu=4, memory=8192, timeout=1800, volumes={str(DATA): vol})
def normalize_inputs(scene_rel: str) -> list[dict]:
    """Plan §4 "view normalization": cut each real photo out, scale and centre it so the vehicle's height matches the
    assumed vehicle box projected through that slot's camera, on white. Listing photos are shot at different distances;
    left alone, the truck changes size between neighbouring views and the splat smears trying to reconcile them."""
    from PIL import Image
    from rembg import new_session, remove

    vol.reload()
    root = DATA / scene_rel
    t = json.loads((root / "transforms.json").read_text())
    (root / "images_orig").mkdir(exist_ok=True)
    session, report = new_session("isnet-general-use"), []
    for f in t["frames"]:
        if not f.get("file_path"):
            continue
        path = root / f["file_path"]
        orig = root / "images_orig" / path.name
        if not orig.exists():
            shutil.copy(path, orig)
        with Image.open(orig) as im:
            cut = remove(im.convert("RGB"), session=session)
        bbox = cut.getchannel("A").point(lambda a: 255 if a > 128 else 0).getbbox()
        if not bbox:
            report.append({"azimuth": f["azimuth"], "skipped": "no vehicle found"})
            continue
        ex0, ey0, ex1, ey1 = _project_bbox(f["transform_matrix"], t["fl_x"], t["cx"], t["cy"], t["vehicle_box"])
        k = (ey1 - ey0) / (bbox[3] - bbox[1])  # height is stable across azimuths; width depends on the exact angle
        ox = round((ex0 + ex1) / 2 - (bbox[0] + bbox[2]) / 2 * k)
        oy = round(ey1 - bbox[3] * k)  # wheels on the projected ground line
        if t.get("keep_background"):
            # Pose normalization instead of image normalization: keep the full photo (no shrinking, no padded
            # borders for the generator to copy) and move this input's camera along its view ray so the vehicle's
            # apparent size is explained by distance. Generated frames stay at the ring radius, so sizes still match.
            import numpy as np

            c2w = np.array(f["transform_matrix"], dtype=float)
            target = np.array(t.get("ring_target", [0.0, 0.35, 0.0]), dtype=float)
            c2w[:3, 3] = target + (c2w[:3, 3] - target) * k
            f["transform_matrix"] = c2w.tolist()
            with Image.open(orig) as im:
                canvas = im.convert("RGB").resize((t["w"], t["h"]), Image.LANCZOS)
            report.append({"azimuth": int(f["azimuth"]), "distance_scale": round(float(k), 3)})
            canvas.save(path)
            continue
        vehicle = cut.crop(bbox)
        vehicle = vehicle.resize((max(1, round(vehicle.width * k)), max(1, round(vehicle.height * k))), Image.LANCZOS)
        canvas = Image.new("RGB", (t["w"], t["h"]), "white")
        canvas.paste(vehicle, (ox + round(bbox[0] * k), oy + round(bbox[1] * k)), vehicle)
        canvas.save(path)
        # Plain Python numbers: the caller's container runs numpy 1.x and can't unpickle numpy 2 scalars.
        report.append({"azimuth": int(f["azimuth"]), "scale": round(float(k), 3), "expected_h": int(round(float(ey1 - ey0))), "photo_h": int(bbox[3] - bbox[1])})
    if t.get("keep_background"):
        (root / "transforms.json").write_text(json.dumps(t, indent=2))
    vol.commit()
    return report


@app.function(image=matte_image, cpu=4, memory=8192, timeout=1800, volumes={str(DATA): vol})
def matte(posed_rel: str, progress_key: str = "") -> int:
    """Background removal -> RGBA frames. SEVA invents a different parking lot for every angle; Splatfacto would turn
    that disagreement into floaters. With alpha, empty pixels train as empty space and only the vehicle is kept."""
    from PIL import Image
    from rembg import new_session, remove

    vol.reload()
    root = DATA / posed_rel
    frames = json.loads((root / "transforms.json").read_text())["frames"]
    session = new_session("isnet-general-use")
    for i, f in enumerate(frames):
        path = root / f["file_path"]
        with Image.open(path) as im:
            remove(im.convert("RGB"), session=session).save(path)  # RGBA PNG, same size
        _report(progress_key, "generating_views", i + 1, len(frames), "Separating the vehicle from its background")
    vol.commit()
    return len(frames)


@app.local_entrypoint()
def main(check: bool = False, listing: str = ""):
    if check:
        print(modal.Function.from_name(app.name, "check_access").remote())
        return
    assert listing, "--listing required"
    call = modal.Function.from_name(app.name, "generate_views").spawn(listing)
    print("spawned", call.object_id)
