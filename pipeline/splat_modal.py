"""Gaussian-splat reconstruction on Modal with Nerfstudio Splatfacto (docs/PLAN-SPLAT.md, Phase 1).

Manual pilot usage:
  uvx modal run pipeline/splat_modal.py --job velocity-226894 --urls urls.json          # images from URLs
  uvx modal volume put gi-splats walkaround.mp4 /jobs/<job>/source.mp4 && \
  uvx modal run pipeline/splat_modal.py --job <job> --video                              # walkaround video
  uvx modal volume get gi-splats /jobs/<job>/export/splat.ply ./splat.ply

Inputs and outputs live on the `gi-splats` Volume; nothing is baked into the image or passed as bytes.
"""
import json
import pathlib
import subprocess
import time

import modal

NERFSTUDIO_TAG = "1.1.5"  # ponytail: pinned by tag; bump deliberately after re-running the pilot
image = modal.Image.from_registry(f"ghcr.io/nerfstudio-project/nerfstudio:{NERFSTUDIO_TAG}", add_python="3.10").pip_install("requests")
app = modal.App("garage-intelligence-splat", image=image)
vol = modal.Volume.from_name("gi-splats", create_if_missing=True)
DATA = pathlib.Path("/data")


def sh(cmd: list[str], cwd: pathlib.Path | None = None) -> None:
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


# ponytail: one function per GPU tier; Modal picks the class at definition time, not per call.
def _reconstruct(job: str, image_urls: list[str] | None, video: bool, iterations: int, gpu: str) -> dict:
    import requests

    root = DATA / "jobs" / job
    images, processed, outputs, export = root / "images", root / "processed", root / "outputs", root / "export"
    stats: dict = {"job": job, "nerfstudio": NERFSTUDIO_TAG, "gpu": gpu, "iterations": iterations}
    t0 = time.time()

    dataparser: list[str] = []
    if job.startswith("sample-"):
        # Tanks & Temples walkarounds ("truck", "train") with COLMAP poses, as packaged by the 3DGS authors.
        # Proves the pipeline end to end with the kind of capture a listing walkaround video would give.
        name = job.removeprefix("sample-")
        processed = root / "tandt" / name
        if not processed.exists():
            zip_path = root / "tandt_db.zip"
            root.mkdir(parents=True, exist_ok=True)
            with requests.get("https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/datasets/input/tandt_db.zip", stream=True, timeout=600) as r:
                r.raise_for_status()
                with zip_path.open("wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            import zipfile

            with zipfile.ZipFile(zip_path) as z:
                z.extractall(root, [m for m in z.namelist() if m.startswith(f"tandt/{name}/")])
        # The package ships images at half the COLMAP resolution. Halve the camera intrinsics to match.
        if (processed / "images_2").exists():
            (processed / "images_2").rename(processed / "images")
        sparse = processed / "sparse" / "0"
        if not (sparse / "cameras.txt").exists():
            sh(["colmap", "model_converter", "--input_path", str(sparse), "--output_path", str(sparse), "--output_type", "TXT"])
            for b in sparse.glob("*.bin"):
                b.unlink()
            lines = []
            for line in (sparse / "cameras.txt").read_text().splitlines():
                if line.startswith("#") or not line.strip():
                    lines.append(line)
                    continue
                cam_id, model, w, h, *params = line.split()
                n = {"SIMPLE_PINHOLE": 3, "PINHOLE": 4, "SIMPLE_RADIAL": 3, "RADIAL": 3, "OPENCV": 4}[model]  # f/fx fy cx cy scale; distortion doesn't
                params = [str(float(p) / 2) for p in params[:n]] + params[n:]
                lines.append(" ".join([cam_id, model, str(-(-int(w) // 2)), str(-(-int(h) // 2)), *params]))  # ceil: 1957 -> 979 like the images
            (sparse / "cameras.txt").write_text("\n".join(lines) + "\n")
        dataparser = ["colmap", "--colmap-path", "sparse/0", "--downscale-factor", "1"]
        stats["source"] = f"tanks-and-temples {name}"
    elif video:
        src = root / "source.mp4"
        assert src.exists(), f"upload the capture first: modal volume put gi-splats <file> /jobs/{job}/source.mp4"
        # Video frames are ordered, so sequential matching is enough and far faster than exhaustive.
        sh(["ns-process-data", "video", "--data", str(src), "--output-dir", str(processed), "--num-frames-target", "200", "--matching-method", "sequential"])
        stats["source"] = "video"
    else:
        assert image_urls, "image_urls required unless --video"
        images.mkdir(parents=True, exist_ok=True)
        for i, url in enumerate(image_urls):
            dst = images / f"{i:04d}.jpg"
            if not dst.exists():
                dst.write_bytes(requests.get(url, timeout=120).content)
        # Listing photos are unordered, so match every pair; fine for a few hundred images.
        sh(["ns-process-data", "images", "--data", str(images), "--output-dir", str(processed), "--matching-method", "exhaustive"])
        stats["source"] = f"{len(image_urls)} images"
    vol.commit()
    stats["seconds_process"] = round(time.time() - t0)

    if (processed / "transforms.json").exists():
        stats["frames_aligned"] = len(json.loads((processed / "transforms.json").read_text())["frames"])
    else:
        stats["frames_aligned"] = len(list(next(processed.glob("images*")).glob("*")))

    t1 = time.time()
    # Only runs with a checkpoint count; earlier crashed attempts leave config-only folders behind.
    trained = lambda: sorted(c for c in (outputs / job / "splatfacto").glob("*/config.yml") if (c.parent / "nerfstudio_models").exists())  # noqa: E731
    if not trained():
        sh(["ns-train", "splatfacto", "--data", str(processed), "--output-dir", str(outputs), "--experiment-name", job,
            "--vis", "tensorboard", "--viewer.quit-on-train-completion", "True", "--max-num-iterations", str(iterations), *dataparser])
        vol.commit()  # keep the checkpoint even if export fails; uncommitted volume writes die with the container
    print("trained runs:", [str(c.parent.name) for c in trained()], flush=True)
    config = trained()[-1]
    sh(["ns-export", "gaussian-splat", "--load-config", str(config), "--output-dir", str(export)])
    vol.commit()
    stats["seconds_train_export"] = round(time.time() - t1)
    stats["ply_bytes"] = (export / "splat.ply").stat().st_size
    (root / "stats.json").write_text(json.dumps(stats, indent=2))
    vol.commit()
    return stats


@app.function(gpu="A10G", timeout=3 * 3600, volumes={str(DATA): vol})
def reconstruct(job: str, image_urls: list[str] | None = None, video: bool = False, iterations: int = 15000) -> dict:
    return _reconstruct(job, image_urls, video, iterations, "A10G")


@app.function(gpu="H100", timeout=3 * 3600, volumes={str(DATA): vol})
def reconstruct_fast(job: str, image_urls: list[str] | None = None, video: bool = False, iterations: int = 15000) -> dict:
    return _reconstruct(job, image_urls, video, iterations, "H100")


@app.local_entrypoint()
def main(job: str = "", urls: str = "", video: bool = False, iterations: int = 15000, gpu: str = "A10G", wait: str = ""):
    """Deploy once (`modal deploy`), then spawn: the call outlives this client, which laptops on flaky networks need.

      uvx modal deploy pipeline/splat_modal.py
      uvx modal run pipeline/splat_modal.py --job <job> --urls <urls.json> [--gpu H100]   -> prints a call id
      uvx modal run pipeline/splat_modal.py --wait <call id>                              -> blocks until done, prints stats
    """
    if wait:
        print(json.dumps(modal.FunctionCall.from_id(wait).get(), indent=2))
        return
    assert job, "--job required"
    image_urls = json.loads(pathlib.Path(urls).read_text()) if urls else None
    name = "reconstruct_fast" if gpu.upper() == "H100" else "reconstruct"
    call = modal.Function.from_name(app.name, name).spawn(job, image_urls, video, iterations)
    print("spawned", call.object_id)
    print(f"follow: uvx modal run pipeline/splat_modal.py --wait {call.object_id}")
