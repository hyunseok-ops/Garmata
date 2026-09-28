"""Photo spin builder: a smooth 360 lap where every angle the listing actually photographed shows the real photo.

Base lap: the generated ring frames (experiments/novel-view/<id>/generated/NNN.png, backgrounds kept).
Each full-vehicle exterior listing photo is matched (SIFT + RANSAC similarity) against the ring frames its label allows,
placed on the frame it matches best, aligned to it, and composited over it with a feathered edge. Close-ups fail the
scale check and are skipped. The truck pixels in real frames are the listing photo's own (only scaled/shifted).

  uv run --with rembg --with onnxruntime --with opencv-python-headless --with numpy --with pillow --with requests python pipeline/spin_build.py \
      <exp_dir> <candidates.json> <out_dir>
candidates.json: [{"id", "url", "viewLabel"}]. Writes <out_dir>/frames/NNN.jpg and <out_dir>/spin.json.
"""
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np
import requests
from PIL import Image

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


LABEL_SLACK = 30  # listing labels are loose (front-3/4 shots labelled "front", rear-3/4 labelled "side")


def in_window(az: float, label: str) -> bool:
    return any(lo - LABEL_SLACK <= a <= hi + LABEL_SLACK for lo, hi in WINDOWS.get(label, []) for a in (az, az - 360))


_session = None


def truck_mask(img: np.ndarray, cache: pathlib.Path) -> np.ndarray:
    """Vehicle matte (uint8 0/255). Alignment must use truck pixels only: the generator moved each input camera to fix
    the truck's size, so background features disagree with the truck on scale and would pull the fit off."""
    global _session
    if not cache.exists():
        from rembg import new_session, remove
        _session = _session or new_session("isnet-general-use")
        a = np.array(remove(Image.fromarray(img), session=_session, only_mask=True))
        cv2.imwrite(str(cache), np.where(a > 128, 255, 0).astype(np.uint8))
    return cv2.imread(str(cache), cv2.IMREAD_GRAYSCALE)


def features(img: np.ndarray, mask: np.ndarray):
    return sift.detectAndCompute(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY), mask)


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


SIZE_TOLERANCE = 0.12  # max truck-height difference between a real frame and its neighbours
ZOOM_MAX = 1.6  # generated frames are 768 px upscaled 2x; zooming further than this looks soft


def real_view(M, pshape, gw: int, gh: int):
    """Crop of the photo that shows what the ring frame shows (M: photo px -> frame px), zooming in rather than
    shrinking when the photo can't cover the frame. Returns (zoom, frame centre x, y, photo crop box) or None."""
    s = float(np.hypot(M[0, 0], M[1, 0]))
    ph, pw = pshape[:2]
    z = max(1.0, (gw / s) / pw, (gh / s) / ph)
    if z > ZOOM_MAX:
        return None
    ww, wh = gw / s / z, gh / s / z
    cx, cy = cv2.invertAffineTransform(M) @ np.array([gw / 2, gh / 2, 1.0])
    cx, cy = min(max(cx, ww / 2), pw - ww / 2), min(max(cy, wh / 2), ph - wh / 2)
    gx, gy = M @ np.array([cx, cy, 1.0])
    return z, float(gx), float(gy), (cx - ww / 2, cy - wh / 2, cx + ww / 2, cy + wh / 2)


INTERP = 4  # in-between frames per gap (x4: 7.5 deg lap -> 1.875 deg steps)
RIFE_DIR = pathlib.Path(os.environ.get("GI_RIFE_DIR", pathlib.Path.home() / ".cache/gi/rife-ncnn-vulkan-20221029-macos"))


def midpoint(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    with tempfile.TemporaryDirectory() as tmp:
        t = pathlib.Path(tmp)
        Image.fromarray(a).save(t / "a.png"), Image.fromarray(b).save(t / "b.png")
        subprocess.run([str(RIFE_DIR / "rife-ncnn-vulkan"), "-0", str(t / "a.png"), "-1", str(t / "b.png"), "-o", str(t / "m.png"),
                        "-m", str(RIFE_DIR / "rife-v4.6"), "-s", "0.5"], check=True, capture_output=True)
        return np.array(Image.open(t / "m.png").convert("RGB"))


def interpolate(out_dir: pathlib.Path, frames: list[dict], factor: int) -> list[dict]:
    """Optical-flow in-betweens (RIFE v4.6, local GPU) so a slow spin never shows two frames blended. Key frames
    are copied through untouched (real photos stay the photo); in-betweens are marked "interpolated". Without the
    RIFE binary the lap is returned as is."""
    exe = RIFE_DIR / "rife-ncnn-vulkan"
    if factor <= 1 or not exe.exists():
        print(f"no interpolation (RIFE not found at {RIFE_DIR})" if factor > 1 else "no interpolation", file=sys.stderr)
        return [{**f, "key": True} for f in frames]
    n = len(frames)
    with tempfile.TemporaryDirectory() as tmp:
        tin, tout = pathlib.Path(tmp, "in"), pathlib.Path(tmp, "out")
        tin.mkdir(), tout.mkdir()
        for i, f in enumerate(frames + frames[:1]):  # closed loop: last frame -> first
            shutil.copy(out_dir / f["file"], tin / f"{i:04d}.jpg")
        subprocess.run([str(exe), "-i", str(tin), "-o", str(tout), "-m", str(RIFE_DIR / "rife-v4.6"), "-n", str(n * factor + 1),
                        "-f", "%04d.jpg"], check=True, capture_output=True)  # outputs are 1-indexed
        keys = out_dir / "keys"
        shutil.rmtree(keys, ignore_errors=True)
        (out_dir / "frames").rename(keys)
        (out_dir / "frames").mkdir()
        out = []
        for j in range(n * factor):
            k, r = divmod(j, factor)
            a, b, t = frames[k], frames[(k + 1) % n], r / factor
            name = f"frames/{j:03d}.jpg"
            if r == 0:
                shutil.copy(keys / pathlib.Path(a["file"]).name, out_dir / name)
                out.append({**a, "file": name, "key": True})
                continue
            shutil.copy(tout / f"{j + 1:04d}.jpg", out_dir / name)
            db = (b["azimuth"] - a["azimuth"]) % 360
            view = [a["view"][i] + (b["view"][i] - a["view"][i]) * t for i in range(3)]
            out.append({"azimuth": round((a["azimuth"] + db * t) % 360, 4), "file": name, "source": "interpolated",
                        "sourceImageId": None, "view": [round(v, 4) for v in view]})
        shutil.rmtree(keys)
    return out


def main(exp_dir: pathlib.Path, candidates_path: pathlib.Path, out_dir: pathlib.Path) -> None:
    gen_dir = exp_dir / "generated"
    frames = sorted(gen_dir.glob("*.png"), key=lambda p: int(p.stem))
    manifest = json.loads((exp_dir / "manifest.json").read_text())
    azimuths = [float(v["azimuth"]) for v in manifest["views"]]
    assert len(azimuths) == len(frames), f"{len(frames)} generated frames for {len(azimuths)} ring slots"
    gen = [np.array(Image.open(p).convert("RGB")) for p in frames]
    # Reviewed-bad generated frames (azimuths.json "spinReplace": [azimuth, ...]) are replaced by the optical-flow
    # midpoint of their neighbours instead of being shown.
    overrides = json.loads((exp_dir / "azimuths.json").read_text()) if (exp_dir / "azimuths.json").exists() else {}
    replaced = [azimuths.index(float(a)) for a in overrides.get("spinReplace", []) if float(a) in azimuths]
    for slot in replaced:
        gen[slot] = midpoint(gen[(slot - 1) % len(gen)], gen[(slot + 1) % len(gen)])
    gw = gen[0].shape[1]
    cache = exp_dir / "candidates"
    cache.mkdir(exist_ok=True)
    masks = exp_dir / "masks"
    masks.mkdir(exist_ok=True)
    gen_feat = [features(g, truck_mask(g, masks / f"gen-{p.stem}-{p.stat().st_mtime_ns}.png")) for g, p in zip(gen, frames)]
    candidates = json.loads(candidates_path.read_text())
    matches = []  # (inliers, slot, photo_id, M, scale)
    mirrored = []  # (inliers, azimuth, photo_id)
    for c in candidates:
        if c.get("viewLabel") not in WINDOWS:
            continue
        try:
            photo = fetch(c["url"], cache / f"{c['id']}.jpg")
        except Exception as e:  # unreachable photo: skip, never fail the build
            print("skip", c["id"], e, file=sys.stderr)
            continue
        pmask = truck_mask(photo, masks / f"{c['id']}.png")
        pf = features(photo, pmask)
        # Mirrored registration: a photo of a side the lap only hallucinated won't match it directly, but its mirror
        # matches the photographed opposite side at azimuth a, putting the photo at 360 - a. Used only to pin
        # generator inputs, never to place a (mirrored) image in the spin.
        pf_m = features(np.ascontiguousarray(photo[:, ::-1]), np.ascontiguousarray(pmask[:, ::-1]))
        # Expected scale for a full-vehicle shot: photo and frame both show the whole truck at similar framing.
        expect = gw / photo.shape[1]
        for slot, az in enumerate(azimuths):
            if not in_window(az, c["viewLabel"]):
                continue
            M, inl, s = align(pf, gen_feat[slot], gw)
            if M is not None and 0.55 * expect <= s <= 1.6 * expect:
                matches.append((inl, slot, c["id"], M, s, photo.shape))
        for slot, az in enumerate(azimuths):
            if not in_window((360 - az) % 360, c["viewLabel"]):
                continue
            M, inl, s = align(pf_m, gen_feat[slot], gw)
            if M is not None and 0.55 * expect <= s <= 1.6 * expect:
                mirrored.append((inl, (360 - az) % 360, c["id"]))

    # Best slot per photo (also for photos that don't end up in the spin): feeds more pinned inputs to the generator.
    best = {}
    for inl, slot, pid, M, s, shape in matches:
        if pid not in best or inl > best[pid]["inliers"]:
            best[pid] = {"photo": pid, "azimuth": azimuths[slot], "inliers": inl, "zoom": round(max(1.0, (gw / s) / shape[1], (gen[0].shape[0] / s) / shape[0]), 3)}
    for inl, az, pid in mirrored:
        if pid not in best or (best[pid].get("mirrored") and inl > best[pid]["inliers"]):
            if pid in best and not best[pid].get("mirrored"):
                continue
            best[pid] = {"photo": pid, "azimuth": az, "inliers": inl, "mirrored": True}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "registrations.json").write_text(json.dumps(sorted(best.values(), key=lambda r: r["azimuth"]), indent=2))

    # Greedy: strongest matches first; each photo and each slot used at most once.
    used_photo, used_slot, placed = set(), {}, []
    for inl, slot, pid, M, s, shape in sorted(matches, key=lambda m: -m[0]):
        if pid in used_photo or slot in used_slot:
            continue
        used_photo.add(pid)
        used_slot[slot] = (pid, M, inl)

    # Real frames are the listing photo itself: cropped/zoomed, never shrunk or composited, so there is no seam.
    # When the photo's framing is tighter than the ring camera's, the generated frames zoom in to meet it, and the
    # zoom/centre is interpolated around the lap so size never jumps between real and generated frames.
    gh = gen[0].shape[0]
    views = {}  # slot -> (zoom, gen centre x, gen centre y, photo crop box)
    for slot, (pid, M, inl) in used_slot.items():
        v = real_view(M, np.array(Image.open(cache / f"{pid}.jpg")).shape, gw, gh)
        if v is None:
            print("skip", pid, "needs too much zoom to match the ring framing", file=sys.stderr)
            continue
        views[slot] = v
    real_slots = sorted(views)

    def gen_view(slot):
        if slot in views:
            return views[slot][:3]
        if not real_slots:
            return 1.0, gw / 2, gh / 2
        n = len(azimuths)
        prev = max([r for r in real_slots if r < slot], default=real_slots[-1] - n)
        nxt = min([r for r in real_slots if r > slot], default=real_slots[0] + n)
        t = (slot - prev) / (nxt - prev)
        a, b = views[prev % n][:3], views[nxt % n][:3]
        return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))

    frames_dir = out_dir / "frames"

    def render():
        shutil.rmtree(frames_dir, ignore_errors=True)  # a previous (interpolated) build leaves more files
        frames_dir.mkdir(parents=True)
        placed.clear()
        out_frames = []
        for slot, az in enumerate(azimuths):
            pid = None
            view = views[slot][:3] if slot in views else None
            if slot in views:
                pid = used_slot[slot][0]
                base = Image.open(cache / f"{pid}.jpg").convert("RGB").crop(views[slot][3]).resize((OUT_W, OUT_H), Image.LANCZOS)
                placed.append({"azimuth": az, "photo": pid, "inliers": used_slot[slot][2], "zoom": round(views[slot][0], 3)})
            else:
                z, cx, cy = gen_view(slot)
                w, h = gw / z, gh / z
                cx, cy = min(max(cx, w / 2), gw - w / 2), min(max(cy, h / 2), gh - h / 2)
                view = (z, cx, cy)
                box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
                base = Image.fromarray(gen[slot]).resize((OUT_W, OUT_H), Image.LANCZOS, box=box)
            name = f"{slot:03d}.jpg"
            base.save(frames_dir / name, quality=88)
            out_frames.append({"azimuth": az, "file": f"frames/{name}", "source": "real" if pid else "interpolated" if slot in replaced else "generated", "sourceImageId": pid,
                               "view": [round(view[0], 4), round(view[1], 2), round(view[2], 2)]})  # zoom, centre in ring px
        return out_frames

    # Size check on the finished frames: a real photo whose truck is noticeably bigger or smaller than its neighbours'
    # (bad alignment, or two real photos shot at different distances side by side) would jump; drop the worst one and
    # re-render until none is off. Its slot falls back to the generated frame.
    heights = {}

    def truck_height(slot: int, source: str) -> float:
        key = (slot, source, views.get(slot, (None,))[0])
        if key not in heights:
            a = np.array(Image.open(frames_dir / f"{slot:03d}.jpg").convert("RGB").resize((OUT_W // 2, OUT_H // 2)))
            global _session
            from rembg import new_session, remove
            _session = _session or new_session("isnet-general-use")
            rows = np.where((np.array(remove(Image.fromarray(a), session=_session, only_mask=True)) > 128).mean(1) > 0.01)[0]
            heights[key] = float(rows[-1] - rows[0]) if len(rows) else 0.0
        return heights[key]

    for _ in range(len(views)):
        out_frames = render()
        n = len(azimuths)
        worst, worst_dev = None, SIZE_TOLERANCE
        for slot in views:
            h = truck_height(slot, "real")
            ref = np.mean([truck_height(j, out_frames[j]["source"]) for j in ((slot - 1) % n, (slot + 1) % n)])
            dev = abs(h / ref - 1) if ref else 0
            if dev > worst_dev:
                worst, worst_dev = slot, dev
        if worst is None:
            break
        print("drop", used_slot[worst][0], f"at {azimuths[worst]}: truck {worst_dev:.0%} off its neighbours", file=sys.stderr)
        del views[worst]
        real_slots.remove(worst)

    out_frames = interpolate(out_dir, out_frames, INTERP)
    spin = {"w": OUT_W, "h": OUT_H, "ring": manifest["ring"], "frames": out_frames}
    (out_dir / "spin.json").write_text(json.dumps(spin, indent=2))
    print(json.dumps({"frames": len(out_frames), "real": len(placed), "placed": placed}))


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:  # photo 2x the frame, aligned at half scale: plain crop, no zoom
        z, gx, gy, box = real_view(np.array([[0.5, 0, 0], [0, 0.5, 0]]), (1152, 1536), 768, 576)
        assert (round(z, 3), round(gx), round(gy), tuple(map(round, box))) == (1.0, 384, 288, (0, 0, 1536, 1152))
        z, *_ = real_view(np.array([[1.0, 0, 0], [0, 1.0, 0]]), (480, 640), 768, 576)  # photo smaller than frame
        assert round(z, 3) == 1.2
        assert real_view(np.array([[1.0, 0, 0], [0, 1.0, 0]]), (288, 384), 768, 576) is None  # would need 2x
        print("ok"); sys.exit()
    main(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
