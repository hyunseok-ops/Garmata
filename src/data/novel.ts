import type { ListingPhoto } from "./types.ts";

// Sparse listing photos -> 24-view ring with deterministic cameras (docs/PLAN.md §7, §8, §11).
// World frame matches the viewer: y up, vehicle front faces +X, driver (left) side faces +Z.
// Cameras use the OpenGL convention shared by Nerfstudio, SEVA and three.js: look down -Z, +Y up.

export type Mat4 = number[][];

// ListingImageViewLabel -> approximate azimuth on the driver side. Labels don't say which side a photo shows, so
// pipeline/facing.py detects where the vehicle's front points; "left" means the camera stood on the officer side (-Z).
export const AZIMUTH_BY_LABEL: Record<string, number> = { front: 0, front_34: 45, side: 90, rear_34: 135, rear: 180 };
export const EXTERIOR_LABELS = Object.keys(AZIMUTH_BY_LABEL);

export type FacingDir = "left" | "right" | null;
export type Facing = Partial<Record<"front_34" | "side" | "rear_34", FacingDir>>;

export function azimuthFor(label: string, facing: Facing = {}): number {
  const base = AZIMUTH_BY_LABEL[label];
  if (label === "front" || label === "rear") return base;
  const known = Object.values(facing).filter(Boolean) as ("left" | "right")[];
  const majority = known.filter((f) => f === "left").length > known.length / 2 ? "left" : known.length ? "right" : null;
  const dir = facing[label as keyof Facing] ?? majority;
  return dir === "left" ? 360 - base : base;
}

export const RING = { stepDeg: 15, radius: 2.5, height: 0.35, target: [0, 0.35, 0] as [number, number, number], w: 768, h: 576, hfovDeg: 60 };

export function ringAzimuths(stepDeg = RING.stepDeg): number[] {
  return Array.from({ length: Math.round(360 / stepDeg) }, (_, i) => i * stepDeg);
}

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function cameraPosition(azimuthDeg: number, ring = RING): [number, number, number] {
  const t = (azimuthDeg * Math.PI) / 180;
  return [ring.radius * Math.cos(t), ring.height, ring.radius * Math.sin(t)];
}

// Camera-to-world matrix (OpenGL): columns are right, up, back(= -forward), position.
export function poseFor(azimuthDeg: number, ring = RING): Mat4 {
  const p = cameraPosition(azimuthDeg, ring);
  const f = norm(sub(ring.target, p));
  const right = norm(cross(f, [0, 1, 0]));
  const up = cross(right, f);
  const back = f.map((v) => -v);
  return [
    [right[0], up[0], back[0], p[0]],
    [right[1], up[1], back[1], p[1]],
    [right[2], up[2], back[2], p[2]],
    [0, 0, 0, 1],
  ];
}

export const focalPx = (ring = RING) => ring.w / 2 / Math.tan(((ring.hfovDeg / 2) * Math.PI) / 180);

// Estimated vehicle length in world units: a side photo frames the truck at ~85% of the image width.
export const estimatedVehicleLength = (ring = RING) => 2 * ring.radius * Math.tan(((ring.hfovDeg / 2) * Math.PI) / 180) * 0.85;
// Viewer normalizes vehicles to ~8 units long.
export const viewerScale = (ring = RING) => 8 / estimatedVehicleLength(ring);

export type RingView = {
  azimuth: number;
  file: string; // images/NNN.png inside the posed dataset
  source: "real" | "generated";
  sourceImage?: string; // real/<label>.jpg
  sourceImageId?: string; // ListingImage.id
  conditionedOn?: string[]; // real images the generator saw
};

// One real photo per exterior label (first by gallery order); real photos take their ring slot, the rest are generated.
// `overrides` (label -> azimuth, from experiments/novel-view/<id>/azimuths.json) beat detection.
export function planRing(photos: ListingPhoto[], facing: Facing = {}, overrides: Record<string, number> = {}, ring = RING): RingView[] {
  const reals = new Map<number, ListingPhoto>();
  for (const label of EXTERIOR_LABELS) {
    const p = photos.find((x) => x.viewLabel === label);
    const az = overrides[label] ?? azimuthFor(label, facing);
    if (p && !reals.has(az)) reals.set(az, p);
  }
  const realFiles = [...reals.entries()].map(([az, p]) => `real/${p.viewLabel}.jpg`);
  return ringAzimuths(ring.stepDeg).map((azimuth) => {
    const file = `images/${String(azimuth).padStart(3, "0")}.png`;
    const real = reals.get(azimuth);
    return real
      ? { azimuth, file, source: "real", sourceImage: `real/${real.viewLabel}.jpg`, sourceImageId: real.id }
      : { azimuth, file, source: "generated", conditionedOn: realFiles };
  });
}

// Nerfstudio / SEVA transforms.json. Generated frames have file_path null until the generator fills them.
export function buildTransforms(views: RingView[], ring = RING) {
  const fl = focalPx(ring);
  return {
    orientation_override: "none",
    fl_x: fl, fl_y: fl, cx: ring.w / 2, cy: ring.h / 2, w: ring.w, h: ring.h,
    frames: views.map((v) => ({ file_path: v.source === "real" ? v.file : null, transform_matrix: poseFor(v.azimuth, ring), azimuth: v.azimuth })),
  };
}

export function buildSplit(views: RingView[]) {
  return {
    train_ids: views.flatMap((v, i) => (v.source === "real" ? [i] : [])),
    test_ids: views.flatMap((v, i) => (v.source === "generated" ? [i] : [])),
  };
}

// Plan §34: posed datasets are validated instead of alignment-gated.
export function validatePosed(t: { frames: { file_path: string | null; transform_matrix: Mat4; w?: number; h?: number }[]; w?: number; h?: number }, expected: number): string[] {
  const errors: string[] = [];
  if (t.frames.length !== expected) errors.push(`expected ${expected} frames, found ${t.frames.length}`);
  const sizes = new Set(t.frames.map((f) => `${f.w ?? t.w}x${f.h ?? t.h}`));
  if (sizes.size > 1) errors.push(`inconsistent image sizes: ${[...sizes].join(", ")}`);
  t.frames.forEach((f, i) => {
    if (!f.file_path) errors.push(`frame ${i} has no image`);
    const m = f.transform_matrix;
    if (!Array.isArray(m) || m.length !== 4 || m.some((r) => r.length !== 4 || r.some((v) => !Number.isFinite(v)))) errors.push(`frame ${i} matrix is not a finite 4x4`);
    else {
      const cols = [0, 1, 2].map((c) => [m[0][c], m[1][c], m[2][c]]);
      if (cols.some((c) => Math.abs(Math.hypot(...c) - 1) > 1e-3)) errors.push(`frame ${i} rotation is not orthonormal`);
    }
  });
  if (errors.some((e) => e.includes("4x4"))) return errors;
  // Ordering: camera azimuths must increase around the ring.
  const az = t.frames.map((f) => (Math.atan2(f.transform_matrix[2][3], f.transform_matrix[0][3]) * 180) / Math.PI).map((a) => (a + 360) % 360);
  if (az.some((a, i) => i > 0 && a <= az[i - 1])) errors.push("camera azimuths are not strictly increasing");
  return errors;
}
