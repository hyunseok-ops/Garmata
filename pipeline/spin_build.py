"""Photo spin builder: a smooth 360 lap where every angle the listing actually photographed shows the real photo.

Base lap: the generated ring frames (experiments/novel-view/<id>/generated/NNN.png, backgrounds kept).
Each full-vehicle exterior listing photo is matched (SIFT + RANSAC similarity) against the ring frames its label allows,
placed on the frame it matches best, aligned to it, and composited over it with a feathered edge. Close-ups fail the
scale check and are skipped. The truck pixels in real frames are the listing photo's own (only scaled/shifted).

  uv run --with opencv-python-headless --with numpy --with pillow --with requests python pipeline/spin_build.py \
      <exp_dir> <candidates.json> <out_dir>
candidates.json: [{"id", "url", "viewLabel"}]. Writes <out_dir>/frames/NNN.jpg and <out_dir>/spin.json.
"""
import io
import json
import pathlib
import sys

import cv2
import numpy as np
import requests
from PIL import Image, ImageFilter

OUT_W, OUT_H = 1536, 1152  # 2x the generation resolution so real frames stay sharp
MIN_INLIERS = 40
# Label -> plausible azimuth windows (degrees). Facing is unknown, so both sides are allowed.
WINDOWS = {
    "front": [(-30, 30)],
    "front_34": [(15, 75), (285, 345)],
    "side": [(60, 120), (240, 300)],
    "rear_34": [(105, 165), (195, 255)],
    "rear": [(150, 210)],
}
sift = cv2.SIFT_create(5000)
matcher = cv2.BFMatcher()


def in_window(az: float, label: str) -> bool:
    return any(lo <= az <= hi or lo <= az - 360 <= hi for lo, hi in WINDOWS.get(label, []))


def features(img: np.ndarray):
    return sift.detectAndCompute(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY), None)


def fetch(url: str, cache: pathlib.Path) -> np.ndarray:
    if not cache.exists():
        thumb = url.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") + "?width=1600&resize=contain&quality=90"
        data = requests.get(thumb, timeout=120).content
        if len(data) < 1000:  # transformer refused (very large originals): fall back to the original
            data = requests.get(url, timeout=300).content
        Image.open(io.BytesIO(data)).convert("RGB").save(cache, quality=92)
    return np.array(Image.open(cache).convert("RGB"))


def align(photo_feat, frame_feat, frame_w: int):
    """Similarity transform photo -> frame (frame pixel units), inlier count, and its scale."""
    kp1, d1 = photo_feat
    kp2, d2 = frame_feat
    if d1 is None or d2 is None:
        return None, 0, 0.0
    good = [m for m, n in (p for p in matcher.knnMatch(d1, d2, k=2) if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < MIN_INLIERS:
        return None, 0, 0.0
    src = np.float32([kp1[g.queryIdx].pt for g in good])
    dst = np.float32([kp2[g.trainIdx].pt for g in good])
    M, mask = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=6.0, maxIters=4000)
    if M is None:
        return None, 0, 0.0
    inl = int(mask.sum())
    if inl < 30:  # weak geometric agreement: leave the generated frame
        return None, 0, 0.0
    return M, inl, float(np.hypot(M[0, 0], M[1, 0]))


def main(exp_dir: pathlib.Path, candidates_path: pathlib.Path, out_dir: pathlib.Path) -> None:
    gen_dir = exp_dir / "generated"
    frames = sorted(gen_dir.glob("*.png"), key=lambda p: int(p.stem))
    manifest = json.loads((exp_dir / "manifest.json").read_text())
    azimuths = [float(v["azimuth"]) for v in manifest["views"]]
    assert len(azimuths) == len(frames), f"{len(frames)} generated frames for {len(azimuths)} ring slots"
    gen = [np.array(Image.open(p).convert("RGB")) for p in frames]
    gw = gen[0].shape[1]
    gen_feat = [features(g) for g in gen]

    cache = exp_dir / "candidates"
    cache.mkdir(exist_ok=True)
    candidates = json.loads(candidates_path.read_text())
    matches = []  # (inliers, slot, photo_id, M, scale)
    for c in candidates:
        if c.get("viewLabel") not in WINDOWS:
            continue
        try:
            photo = fetch(c["url"], cache / f"{c['id']}.jpg")
        except Exception as e:  # unreachable photo: skip, never fail the build
            print("skip", c["id"], e, file=sys.stderr)
            continue
        pf = features(photo)
        # Expected scale for a full-vehicle shot: photo and frame both show the whole truck at similar framing.
        expect = gw / photo.shape[1]
        for slot, az in enumerate(azimuths):
            if not in_window(az, c["viewLabel"]):
                continue
            M, inl, s = align(pf, gen_feat[slot], gw)
            if M is not None and 0.55 * expect <= s <= 1.6 * expect:
                matches.append((inl, slot, c["id"], M, s, photo.shape))

    # Greedy: strongest matches first; each photo and each slot used at most once.
    used_photo, used_slot, placed = set(), {}, []
    for inl, slot, pid, M, s, shape in sorted(matches, key=lambda m: -m[0]):
        if pid in used_photo or slot in used_slot:
            continue
        used_photo.add(pid)
        used_slot[slot] = (pid, M, inl)

    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    k = OUT_W / gw
    out_frames = []
    for slot, az in enumerate(azimuths):
        base = Image.fromarray(gen[slot]).resize((OUT_W, OUT_H), Image.LANCZOS)
        src = "generated"
        pid = None
        if slot in used_slot:
            pid, M, inl = used_slot[slot]
            photo = Image.open(cache / f"{pid}.jpg").convert("RGB")
            M2 = np.vstack([M * np.array([[k], [k]]), [0, 0, 1]])  # frame px -> output px
            inv = np.linalg.inv(M2)[:2].flatten()
            warped = photo.transform((OUT_W, OUT_H), Image.AFFINE, tuple(inv), Image.BICUBIC)
            mask = Image.new("L", photo.size, 255).transform((OUT_W, OUT_H), Image.AFFINE, tuple(inv), Image.NEAREST)
            mask = mask.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.GaussianBlur(10))  # feathered seam
            base = Image.composite(warped, base, mask)
            src = "real"
            placed.append({"azimuth": az, "photo": pid, "inliers": inl})
        name = f"{slot:03d}.jpg"
        base.save(frames_dir / name, quality=88)
        out_frames.append({"azimuth": az, "file": f"frames/{name}", "source": src, "sourceImageId": pid})

    spin = {"w": OUT_W, "h": OUT_H, "ring": manifest["ring"], "frames": out_frames}
    (out_dir / "spin.json").write_text(json.dumps(spin, indent=2))
    print(json.dumps({"frames": len(out_frames), "real": len(placed), "placed": placed}))


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
