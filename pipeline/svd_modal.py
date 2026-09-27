"""Quick try of Stable Video Diffusion img2vid-xt-1.1 on listing photos (one photo -> 25-frame clip).

  uvx modal run pipeline/svd_modal.py --check
  uvx modal run pipeline/svd_modal.py --photos experiments/novel-view/<id>/real/front_34.jpg,<more>.jpg   # mp4s land next to each photo
"""
import os
import pathlib

import modal

MODEL = os.environ.get("GI_SVD_MODEL", "stabilityai/stable-video-diffusion-img2vid-xt-1-1")
image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "torch==2.6.0", "diffusers==0.32.2", "transformers==4.48.3", "accelerate", "imageio[ffmpeg]", "pillow"
)
app = modal.App("gi-svd", image=image)
HF = modal.Secret.from_name(os.environ.get("GI_HF_SECRET", "huggingface"))
cache = modal.Volume.from_name("gi-hf-cache", create_if_missing=True)


@app.function(secrets=[HF], timeout=120)
def check_access() -> str:
    from huggingface_hub import get_hf_file_metadata, hf_hub_url

    try:
        get_hf_file_metadata(hf_hub_url(MODEL, "model_index.json"), token=os.environ.get("HF_TOKEN"))
        return "ok"
    except Exception as e:
        return f"no access: {type(e).__name__}: {str(e)[:200]}"


@app.function(gpu="H100", timeout=1800, secrets=[HF], volumes={"/cache": cache})
def generate(photos: list[bytes], seed: int = 42, motion_bucket_id: int = 127) -> list[bytes]:
    import io
    import tempfile

    import torch
    from diffusers import StableVideoDiffusionPipeline
    from diffusers.utils import export_to_video
    from PIL import Image, ImageOps

    pipe = StableVideoDiffusionPipeline.from_pretrained(
        MODEL, torch_dtype=torch.float16, variant="fp16", cache_dir="/cache", token=os.environ.get("HF_TOKEN")
    ).to("cuda")
    cache.commit()
    out = []
    for b in photos:
        # Model trained at 1024x576; letterboxing would animate the bars, so centre-crop to 16:9.
        img = ImageOps.fit(Image.open(io.BytesIO(b)).convert("RGB"), (1024, 576))
        frames = pipe(img, decode_chunk_size=8, motion_bucket_id=motion_bucket_id,
                      generator=torch.manual_seed(seed)).frames[0]
        with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
            export_to_video(frames, f.name, fps=7)
            out.append(pathlib.Path(f.name).read_bytes())
    return out


@app.local_entrypoint()
def main(photos: str = "", check: bool = False, motion: int = 127):
    if check or not photos:
        print(check_access.remote())
        return
    paths = [pathlib.Path(p) for p in photos.split(",")]
    for p, mp4 in zip(paths, generate.remote([p.read_bytes() for p in paths], motion_bucket_id=motion)):
        dst = p.with_name(f"{p.stem}.svd.mp4")
        dst.write_bytes(mp4)
        print(dst)
