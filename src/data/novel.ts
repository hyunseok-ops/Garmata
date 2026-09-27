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

// Estimated vehicle length in world units. 0.72 of the frame width at the target distance keeps the near side of a
// side view (which projects wider than the centre line) at ~80% of the image, with margin for the generator.
export const estimatedVehicleLength = (ring = RING) => 2 * ring.radius * Math.tan(((ring.hfovDeg / 2) * Math.PI) / 180) * 0.72;
// Assumed vehicle box in world units (fire apparatus is roughly 4:1:1.2 length:width:height), resting on y=0.
// View normalization scales each real photo so the vehicle fills the frame the way this box projects at its slot.
export const vehicleBox = (ring = RING) => {
  const L = estimatedVehicleLength(ring);
  return { min: [-L / 2, 0, -L * 0.125], max: [L / 2, L * 0.3, L * 0.125] };
};
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

// Per-listing overrides (experiments/novel-view/<id>/azimuths.json):
//   labels: { "front_34": 315 }            move the auto-picked photo for a label
//   photos: { "<ListingImage.id>": 135 }   pin exact photos to ring slots (e.g. a driver-side shot filed as "side")
// A plain { label: azimuth } object is read as `labels`.
// regenerateReals: SEVA re-renders the real slots too, from the exact ring cameras. Real photos stay as conditioning
// (and as evidence in the viewer) but are not trained on, because their unknown distance/zoom contradicts the ring.
// keepBackground: view normalization scales the whole photo (not a cutout on white) and matting is skipped, so every
// generated frame carries a background: real surroundings at the photographed angles, SEVA's continuation between them.
// Meant for the photo spin view; a 3D splat can't reconcile invented backgrounds.
export type RingOverrides = { labels?: Record<string, number>; photos?: Record<string, number>; regenerateReals?: boolean; ringStepDeg?: number; keepBackground?: boolean };
export function normalizeOverrides(o: unknown): RingOverrides {
  const x = (o ?? {}) as Record<string, unknown>;
  return ["labels", "photos", "regenerateReals", "ringStepDeg", "keepBackground"].some((k) => k in x) ? (x as RingOverrides) : { labels: x as Record<string, number> };
}

// Ring for a listing: the default 24-view ring unless the experiment config asks for a different spacing.
export function ringFor(o: RingOverrides) {
  return o.ringStepDeg ? { ...RING, stepDeg: o.ringStepDeg } : RING;
}

const slot = (az: number, ring = RING) => ((Math.round(az / ring.stepDeg) * ring.stepDeg) % 360 + 360) % 360;

// One real photo per exterior label (first by gallery order) unless pinned; real photos take their ring slot, the rest
// are generated. Pinned photos win their slot.
export function planRing(photos: ListingPhoto[], facing: Facing = {}, overrides: RingOverrides | Record<string, number> = {}, ring = RING): RingView[] {
  const o = normalizeOverrides(overrides);
  const reals = new Map<number, ListingPhoto>();
  for (const [id, az] of Object.entries(o.photos ?? {})) {
    const p = photos.find((x) => x.id === id);
    if (p) reals.set(slot(az, ring), p);
  }
  for (const label of EXTERIOR_LABELS) {
    const p = photos.find((x) => x.viewLabel === label && !(x.id in (o.photos ?? {})));
    const az = slot(o.labels?.[label] ?? azimuthFor(label, facing), ring);
    if (p && !reals.has(az)) reals.set(az, p);
  }
  const fileFor = (p: ListingPhoto) => `real/${p.viewLabel}${p.id in (o.photos ?? {}) ? `-${p.id.slice(0, 8)}` : ""}.jpg`;
  const realFiles = [...reals.values()].map(fileFor);
  return ringAzimuths(ring.stepDeg).map((azimuth) => {
    const file = `images/${String(azimuth).padStart(3, "0")}.png`;
    const real = reals.get(azimuth);
    return real
      ? { azimuth, file, source: "real", sourceImage: fileFor(real), sourceImageId: real.id }
      : { azimuth, file, source: "generated", conditionedOn: realFiles };
  });
}

// Nerfstudio / SEVA transforms.json. Generated frames have file_path null until the generator fills them.
// With regenerateReals, all 24 ring frames are targets and each real photo is prepended as an input-only frame at its
// slot's camera; those extra frames condition SEVA and are dropped before reconstruction.
export function buildTransforms(views: RingView[], ring = RING, regenerateReals = false, keepBackground = false) {
  const fl = focalPx(ring);
  const ringFrames = views.map((v) => ({
    file_path: v.source === "real" && !regenerateReals ? v.file : null,
    transform_matrix: poseFor(v.azimuth, ring),
    azimuth: v.azimuth,
  }));
  const inputFrames = regenerateReals
    ? views.filter((v) => v.source === "real").map((v) => ({ file_path: v.file, transform_matrix: poseFor(v.azimuth, ring), azimuth: v.azimuth, input_only: true }))
    : [];
  // Inputs first: SEVA sizes each empty frame from the previous loaded image, so frame 0 must have an image.
  return { orientation_override: "none", fl_x: fl, fl_y: fl, cx: ring.w / 2, cy: ring.h / 2, w: ring.w, h: ring.h, vehicle_box: vehicleBox(ring), ring_target: ring.target, keep_background: keepBackground, frames: [...inputFrames, ...ringFrames] };
}

export function buildSplit(views: RingView[], regenerateReals = false) {
  if (regenerateReals) {
    const reals = views.filter((v) => v.source === "real").length;
    return { train_ids: Array.from({ length: reals }, (_, i) => i), test_ids: views.map((_, i) => reals + i) };
  }
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
