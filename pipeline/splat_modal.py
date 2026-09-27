"""Gaussian-splat reconstruction on Modal with Nerfstudio Splatfacto (docs/PLAN.md §12, §13, §33).

Two input modes:
  capture       images/video -> COLMAP/hloc -> alignment gate -> Splatfacto
  posed-images  images + transforms.json (known cameras) -> validation -> Splatfacto, no feature matching

Progress is published to the `gi-progress` modal.Dict under `progress_key` so the desktop dashboard can poll it.

Manual pilot usage:
  uvx modal run pipeline/splat_modal.py --job velocity-226894 --urls urls.json          # images from URLs
  uvx modal volume put gi-splats walkaround.mp4 /jobs/<job>/source.mp4 && \
  uvx modal run pipeline/splat_modal.py --job <job> --video                              # walkaround video
  uvx modal volume get gi-splats /jobs/<job>/export/splat.ply ./splat.ply

Inputs and outputs live on the `gi-splats` Volume; nothing is baked into the image or passed as bytes.
"""
import json
import pathlib
import re
import subprocess
import time

import modal

NERFSTUDIO_TAG = "1.1.5"  # ponytail: pinned by tag; bump deliberately after re-running the pilot
image = (
    modal.Image.from_registry(f"ghcr.io/nerfstudio-project/nerfstudio:{NERFSTUDIO_TAG}", add_python="3.10")
    .pip_install("requests")
    # DISK + LightGlue (Apache-2) for wide-baseline matching; the image's hloc lacks SuperGlue and SuperGlue is non-commercial anyway.
    # --no-deps: a plain install drags in newer torch/pycolmap and breaks the image's hloc; kornia is LightGlue's only missing dep.
    # hloc 1.4 (in the image) calls pycolmap.verify_matches with keyword args; pycolmap >= 0.5 wants a TwoViewGeometryOptions object.
    # /usr/bin/python3 is the interpreter behind ns-process-data; Modal's add_python puts a second Python on PATH.
    .run_commands("/usr/bin/python3 -m pip install --no-deps kornia kornia_rs pycolmap==0.4.0 https://github.com/cvg/LightGlue/archive/refs/heads/main.zip")
)
app = modal.App("garage-intelligence-splat", image=image)
vol = modal.Volume.from_name("gi-splats", create_if_missing=True)
progress = modal.Dict.from_name("gi-progress", create_if_missing=True)
DATA = pathlib.Path("/data")


LOG_DIR: pathlib.Path | None = None
PROGRESS_KEY = ""


def report(stage: str, current: int | None = None, total: int | None = None, message: str | None = None) -> None:
    if PROGRESS_KEY:
        progress[PROGRESS_KEY] = json.dumps({"stage": stage, "current": current, "total": total, "message": message, "at": time.time()})


STEP_RE = re.compile(r"^\s*(\d+) \(\s*[\d.]+%\)")


def sh(cmd: list[str], cwd: pathlib.Path | None = None, on_line=None) -> None:
    """Run a step, streaming output (for progress) and teeing it to <job>/logs/<tool>.log on the volume."""
    print("$", " ".join(cmd), flush=True)
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    lines: list[str] = []
    for line in proc.stdout:  # type: ignore[union-attr]
        lines.append(line)
        if on_line:
            on_line(line)
    proc.wait()
    out = "".join(lines)
    if LOG_DIR:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        (LOG_DIR / f"{cmd[0]}.log").write_text(out)
        vol.commit()
    print(out[-4000:], flush=True)
    if proc.returncode:
        raise RuntimeError(f"{cmd[0]} failed ({proc.returncode}); tail:\n{out[-1500:]}")


def image_size(path: pathlib.Path) -> tuple[int, int]:
    """(w, h) from a PNG/JPEG header; raises on anything else or truncated files. Stdlib only: the function's Python
    (Modal add_python) is not the image's Python, so packages installed for one are invisible to the other."""
    import struct

    b = path.read_bytes()
    if b[:8] == b"\x89PNG\r\n\x1a\n" and b[12:16] == b"IHDR" and b[-8:-4] == b"IEND":
        return struct.unpack(">II", b[16:24])
    if b[:2] == b"\xff\xd8" and b[-2:] == b"\xff\xd9":
        i = 2
        while i < len(b) - 9:
            marker, length = b[i + 1], struct.unpack(">H", b[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", b[i + 5:i + 9])
                return w, h
            i += 2 + length
    raise ValueError("not a complete PNG/JPEG")


def validate_posed(root: pathlib.Path, expected: int | None) -> list[str]:
    """Plan §34: posed datasets are validated (frames, matrices, sizes, ordering) instead of alignment-gated."""
    import math

    t = json.loads((root / "transforms.json").read_text())
    frames, errors = t["frames"], []
    if expected is not None and len(frames) != expected:
        errors.append(f"expected {expected} frames, found {len(frames)}")
    sizes = set()
    for i, f in enumerate(frames):
        path = root / (f.get("file_path") or "")
        if not f.get("file_path") or not path.is_file():
            errors.append(f"frame {i} image missing: {f.get('file_path')}")
            continue
        try:
            sizes.add(image_size(path))
        except Exception as e:
            errors.append(f"frame {i} image corrupt: {e}")
        m = f.get("transform_matrix")
        if not (isinstance(m, list) and len(m) == 4 and all(len(r) == 4 and all(math.isfinite(v) for v in r) for r in m)):
            errors.append(f"frame {i} matrix is not a finite 4x4")
    if len(sizes) > 1:
        errors.append(f"inconsistent image sizes: {sorted(sizes)}")
    if not errors:
        az = [(math.degrees(math.atan2(f["transform_matrix"][2][3], f["transform_matrix"][0][3])) + 360) % 360 for f in frames]
        if any(b <= a for a, b in zip(az, az[1:])):
            errors.append("camera azimuths are not strictly increasing")
    return errors


# ponytail: one function per GPU tier; Modal picks the class at definition time, not per call.
MIN_FRAMES = 15  # below this a splat is not worth GPU time; report alignment and stop


def _reconstruct(job: str, image_urls: list[str] | None, video: bool, iterations: int, gpu: str, matcher: str = "sift",
                 posed: str = "", progress_key: str = "", expected_frames: int | None = None, scale_reg: bool = False) -> dict:
    import requests

    global LOG_DIR, PROGRESS_KEY
    PROGRESS_KEY = progress_key
    root = DATA / "jobs" / job
    LOG_DIR = root / "logs"
    images, processed, outputs, export = root / "images", root / "processed", root / "outputs", root / "export"
    stats: dict = {"job": job, "nerfstudio": NERFSTUDIO_TAG, "gpu": gpu, "iterations": iterations}
    t0 = time.time()

    dataparser: list[str] = []
    if posed:
        # Known cameras (synthetic ring or rendered test): no feature matching, no re-orientation, no rescaling, so the
        # splat comes out in the same world frame the poses were written in.
        report("building_cameras", message="Validating posed dataset")
        vol.reload()
        processed = DATA / posed
        errors = validate_posed(processed, expected_frames)
        if errors:
            report("failed", message="; ".join(errors)[:300])
            raise RuntimeError("posed dataset invalid: " + "; ".join(errors))
        dataparser = ["nerfstudio-data", "--orientation-method", "none", "--center-method", "none", "--auto-scale-poses", "False", "--eval-mode", "all"]
        stats["source"] = f"posed {posed}"
    elif job.startswith("sample-"):
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
        # Listing photos are unordered, so match every pair. "lightglue" = hloc DISK+LightGlue: far more tolerant of
        # wide baselines and zoom changes than SIFT, which is what scattered listing photos need.
        extra = ["--sfm-tool", "hloc", "--feature-type", "disk", "--matcher-type", "disk+lightglue"] if matcher == "lightglue" else []
        sh(["ns-process-data", "images", "--data", str(images), "--output-dir", str(processed), "--matching-method", "exhaustive", *extra])
        stats["source"] = f"{len(image_urls)} images"
    vol.commit()
    stats["seconds_process"] = round(time.time() - t0)

    if (processed / "transforms.json").exists():
        stats["frames_aligned"] = len(json.loads((processed / "transforms.json").read_text())["frames"])
    else:
        stats["frames_aligned"] = len(list(next(processed.glob("images*")).glob("*")))

    if not posed and stats["frames_aligned"] < MIN_FRAMES:  # alignment gate applies to real captures only (§34)
        stats["outcome"] = f"unsuitable: only {stats['frames_aligned']} frames aligned (< {MIN_FRAMES}); not training"
        (root / "stats.json").write_text(json.dumps(stats, indent=2))
        vol.commit()
        return stats

    t1 = time.time()
    # Only runs with a checkpoint count; earlier crashed attempts leave config-only folders behind.
    trained = lambda: sorted(c for c in (outputs / job / "splatfacto").glob("*/config.yml") if (c.parent / "nerfstudio_models").exists())  # noqa: E731
    if not trained():
        report("reconstructing", 0, iterations)
        last = [0.0]

        def on_train_line(line: str) -> None:
            m = STEP_RE.match(line)
            if m and time.time() - last[0] > 5:
                last[0] = time.time()
                report("reconstructing", int(m.group(1)), iterations)

        # Scale regularization caps each Gaussian's long/short axis ratio (max_gauss_ratio, default 10). Without it, sparse
        # ring views are fitted with long flat "needles" that look right from the ring and shatter into shards off it.
        model = ["--pipeline.model.use-scale-regularization", "True"] if scale_reg else []
        stats["scale_reg"] = scale_reg
        sh(["ns-train", "splatfacto", "--data", str(processed), "--output-dir", str(outputs), "--experiment-name", job,
            "--vis", "tensorboard", "--viewer.quit-on-train-completion", "True", "--max-num-iterations", str(iterations), *model, *dataparser],
           on_line=on_train_line)
        vol.commit()  # keep the checkpoint even if export fails; uncommitted volume writes die with the container
    print("trained runs:", [str(c.parent.name) for c in trained()], flush=True)
    config = trained()[-1]
    report("exporting", message="Exporting splat")
    sh(["ns-export", "gaussian-splat", "--load-config", str(config), "--output-dir", str(export)])
    vol.commit()
    stats["seconds_train_export"] = round(time.time() - t1)
    stats["ply_bytes"] = (export / "splat.ply").stat().st_size
    stats["export"] = str((export / "splat.ply").relative_to(DATA))
    (root / "stats.json").write_text(json.dumps(stats, indent=2))
    vol.commit()
    report("ready", message="Splat exported")
    return stats


def _guarded(fn, progress_key: str, *args):
    try:
        return fn(*args)
    except Exception as e:
        if progress_key:
            progress[progress_key] = json.dumps({"stage": "failed", "message": str(e)[:300], "at": time.time()})
        raise


@app.function(gpu="A10G", timeout=3 * 3600, volumes={str(DATA): vol})
def reconstruct(job: str, image_urls: list[str] | None = None, video: bool = False, iterations: int = 15000, matcher: str = "sift",
                posed: str = "", progress_key: str = "", expected_frames: int | None = None, scale_reg: bool = False) -> dict:
    return _guarded(_reconstruct, progress_key, job, image_urls, video, iterations, "A10G", matcher, posed, progress_key, expected_frames, scale_reg)


@app.function(gpu="H100", timeout=3 * 3600, volumes={str(DATA): vol})
def reconstruct_fast(job: str, image_urls: list[str] | None = None, video: bool = False, iterations: int = 15000, matcher: str = "sift",
                     posed: str = "", progress_key: str = "", expected_frames: int | None = None, scale_reg: bool = False) -> dict:
    return _guarded(_reconstruct, progress_key, job, image_urls, video, iterations, "H100", matcher, posed, progress_key, expected_frames, scale_reg)


@app.function(gpu="A10G", timeout=600)
def sfm_versions() -> str:
    """Versions of the SfM stack as seen by the interpreter that runs ns-process-data (not Modal's added Python)."""
    import subprocess as sp

    shebang = pathlib.Path(sp.run(["which", "ns-process-data"], capture_output=True, text=True).stdout.strip()).read_text().split("\n")[0]
    py = shebang.lstrip("#!").strip()
    code = ("import importlib.metadata as m\n"
            "print({n: (lambda: m.version(n))() if True else 0 for n in []})\n"
            "out={}\n"
            "for n in ['nerfstudio','hloc','pycolmap','lightglue','kornia','torch','numpy']:\n"
            "    try: out[n]=m.version(n)\n"
            "    except Exception: out[n]='missing'\n"
            "print(out)")
    r = sp.run([py, "-c", code], capture_output=True, text=True)
    return f"python={py} {r.stdout.strip()} {r.stderr.strip()[-200:]}"


@app.local_entrypoint()
def main(job: str = "", urls: str = "", video: bool = False, iterations: int = 15000, gpu: str = "A10G", wait: str = "", matcher: str = "sift", versions: bool = False):
    if versions:
        print(modal.Function.from_name(app.name, "sfm_versions").remote())
        return
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
    call = modal.Function.from_name(app.name, name).spawn(job, image_urls, video, iterations, matcher)
    print("spawned", call.object_id)
    print(f"follow: uvx modal run pipeline/splat_modal.py --wait {call.object_id}")
