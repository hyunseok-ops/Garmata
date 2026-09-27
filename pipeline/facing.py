"""Which way does the vehicle's front point in each side-ish listing photo? (docs/PLAN.md §7)

Listing labels say "side" / "front_34" / "rear_34" but not which side. Getting it wrong mirrors the poses against the
pixels, so the view generator is told the opposite of what the photo shows. SIFT + RANSAC homography finds the front
face (from the `front` photo) or rear face (from `rear`) inside each 3/4 photo; which half of the frame it lands in gives
the facing. The `side` photo inherits the facing of whichever 3/4 photo it shares the most geometry with.

  uv run --with opencv-python-headless --with numpy python pipeline/facing.py <dir with front.jpg, front_34.jpg, ...>
prints {"front_34": "left"|"right"|null, "side": ..., "rear_34": ..., "uncertain": [...], "evidence": {...}}
("left" = front points left). Unknowns fall back to the majority in src/data/novel.ts; a reviewer can pin any photo in
experiments/novel-view/<listingId>/azimuths.json, e.g. {"front_34": 315}. A vision-model check is the robust follow-up.
"""
import json
import pathlib
import sys

import cv2
import numpy as np

MIN_INLIERS = 12  # direct front/rear face evidence
SAME_SIDE_INLIERS = 20  # side photo inherits a 3/4 photo's facing only with strong shared geometry
sift = cv2.SIFT_create(4000)
cache: dict[str, tuple] = {}


def features(d: pathlib.Path, name: str):
    if name not in cache:
        img = cv2.imread(str(d / f"{name}.jpg"), cv2.IMREAD_GRAYSCALE)
        cache[name] = (img, *sift.detectAndCompute(img, None)) if img is not None else (None, None, None)
    return cache[name]


def match(d: pathlib.Path, a: str, b: str) -> tuple[int, float | None]:
    """Inlier count and median x (0..1) of a's features inside image b."""
    ia, ka, da = features(d, a)
    ib, kb, db = features(d, b)
    if ia is None or ib is None or da is None or db is None:
        return 0, None
    good = [m for m, n in cv2.BFMatcher().knnMatch(da, db, k=2) if m.distance < 0.75 * n.distance]
    if len(good) < MIN_INLIERS:
        return 0, None
    pa = np.float32([ka[g.queryIdx].pt for g in good])
    pb = np.float32([kb[g.trainIdx].pt for g in good])
    H, mask = cv2.findHomography(pa, pb, cv2.RANSAC, 8.0)
    if H is None:
        return 0, None
    inliers = pb[mask.ravel() == 1]
    return len(inliers), float(np.median(inliers[:, 0]) / ib.shape[1])


def facing(d: pathlib.Path) -> dict:
    out: dict = {"front_34": None, "side": None, "rear_34": None, "evidence": {}}
    # Front face on the left half of a front 3/4 photo => front points left; rear face on the right half of a rear 3/4
    # => front points left. No cross fallbacks (e.g. rear face into a front 3/4): that face isn't visible there and the
    # "matches" are background, which produced confident wrong answers. Unknown is better than wrong.
    for label, ref, left_when in (("front_34", "front", "low"), ("rear_34", "rear", "high")):
        n, x = match(d, ref, label)
        out["evidence"][f"{ref}->{label}"] = [n, x]
        if n >= MIN_INLIERS and x is not None:
            out[label] = "left" if (x < 0.5) == (left_when == "low") else "right"
    best = max((match(d, q, "side") + (q,) for q in ("front_34", "rear_34") if out[q]), default=(0, None, None))
    out["evidence"]["side"] = list(best)
    if best[0] >= SAME_SIDE_INLIERS:
        out["side"] = out[best[2]]
    out["uncertain"] = [k for k in ("front_34", "side", "rear_34") if out[k] is None and (d / f"{k}.jpg").exists()]
    return out


if __name__ == "__main__":
    print(json.dumps(facing(pathlib.Path(sys.argv[1]))))
