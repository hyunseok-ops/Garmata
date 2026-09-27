import { nativeImage } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Generation, GenerationStage, ListingDetail, SplatPipeline } from "../src/data/types.ts";
import { buildSplit, buildTransforms, EXTERIOR_LABELS, normalizeOverrides, planRing, RING, ringFor, validatePosed, viewerScale, type Facing, type RingView } from "../src/data/novel.ts";
import { pruneSplatFile } from "./ply.ts";

// Splatfacto default budget. 7k was tried first and looked under-trained; with scale regularization on, 15k is the
// setting that keeps splats compact enough to survive small camera tilts.
const ITERATIONS = 15000;

// Sparse listing photos -> 360 splat (docs/PLAN.md §24, §31, §32). Local steps run here; GPU steps are detached Modal calls
// whose ids and progress are persisted, so a closed window never loses a job and polling resumes on the next launch.

export type Deps = {
  repoRoot: string;
  getListing: (id: string) => Promise<ListingDetail>;
  loadGenerations: () => Record<string, Generation>;
  saveGeneration: (g: Generation) => void;
  importSplat: (listingId: string, file: string, pipeline: SplatPipeline, transformScale: number) => string; // returns assetId
  renderRing?: (listingId: string, outDir: string) => Promise<void>; // posed-test only
  lockDir: () => string;
};

// One driver per generation. The dev window restarts (and resumes jobs) whenever main-process code changes, and headless
// runs can overlap it; two drivers race on the store and double-spawn GPU jobs. The lock holds the driver's pid; a lock
// whose pid is gone is stale and taken over.
function acquire(d: Deps, id: string): (() => void) | null {
  fs.mkdirSync(d.lockDir(), { recursive: true });
  const file = path.join(d.lockDir(), `${id}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch {
      const pid = Number(fs.readFileSync(file, "utf8"));
      try {
        process.kill(pid, 0);
        return pid === process.pid ? () => undefined : null; // alive: someone else is driving it
      } catch {
        fs.rmSync(file, { force: true }); // stale lock from a dead process
      }
    }
  }
  return null;
}

const TERMINAL: GenerationStage[] = ["ready", "failed"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const expDir = (d: Deps, listingId: string) => path.join(d.repoRoot, "experiments", "novel-view", listingId);

function run(d: Deps, cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd: d.repoRoot, timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args.slice(0, 4).join(" ")}: ${(stderr || err.message).slice(-400)}`)) : resolve(stdout),
    ),
  );
}

// ponytail: shells out to uvx per call (~2 s). Fine for a handful of jobs; a long-lived Python sidecar if polling gets heavy.
async function gi(d: Deps, ...args: string[]): Promise<any> {
  const out = await run(d, "uvx", ["--from", "modal==1.5.5", "python", "pipeline/gi.py", ...args], 180_000);
  return JSON.parse(out.trim().split("\n").pop()!);
}

// This laptop's network drops long transfers; retry volume copies a few times.
// `modal volume put` overwrites but never deletes, so a re-run would inherit stale files (e.g. an old
// train_test_split_5.json next to a new _7). Clear the remote dir first; a missing dir is fine.
async function volumeReplace(d: Deps, local: string, remote: string) {
  await run(d, "uvx", ["modal", "volume", "rm", "-r", "gi-splats", remote], 120_000).catch(() => undefined);
  await volume(d, "put", local, remote);
}

async function volume(d: Deps, op: "put" | "get", a: string, b: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await run(d, "uvx", ["modal", "volume", op, "--force", "gi-splats", a, b], 900_000);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(5000 * attempt);
    }
  }
}

// ---- Phase 2: dataset preparation (GI_NOVEL_PREP) ------------------------------------------------

async function fetchImage(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`photo ${res.status}`);
  return nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
}

function cropTo(img: Electron.NativeImage, aspect: number) {
  const { width, height } = img.getSize();
  const w = Math.min(width, Math.round(height * aspect));
  const h = Math.min(height, Math.round(width / aspect));
  return img.crop({ x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h });
}

const fitMax = (img: Electron.NativeImage, max: number) => {
  const { width, height } = img.getSize();
  const k = max / Math.max(width, height);
  return k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: "best" }) : img;
};

export async function prep(d: Deps, listingId: string) {
  const listing = await d.getListing(listingId);
  const dir = expDir(d, listingId);
  // Keep a hand-written azimuths.json across re-runs; everything else is regenerated.
  const overridesPath = path.join(dir, "azimuths.json");
  const overrides = normalizeOverrides(fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, "utf8")) : {});
  for (const sub of ["real", "normalized", "generated", "poses", "output", "scene"]) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  for (const sub of ["real", "normalized", "generated", "poses", "output", "scene/images"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });

  // 1. Download, reject unusable, resize (plan §6), crop to the ring aspect. Label picks feed facing detection.
  const rejected: { label: string; reason: string }[] = [];
  const crops = new Map<string, Electron.NativeImage>(); // by ListingImage.id
  const load = async (photo: ListingDetail["photos"][number], name: string) => {
    try {
      const img = await fetchImage(photo.url);
      const { width, height } = img.getSize();
      if (Math.min(width, height) < 400) throw new Error(`too small (${width}x${height})`);
      fs.writeFileSync(path.join(dir, "real", `${name}.jpg`), fitMax(img, 1600).toJPEG(90));
      const cropped = cropTo(img, RING.w / RING.h);
      fs.writeFileSync(path.join(dir, "normalized", `${name}.jpg`), fitMax(cropped, 1600).toJPEG(90));
      crops.set(photo.id, cropped);
    } catch (e) {
      rejected.push({ label: name, reason: (e as Error).message });
    }
  };
  for (const label of EXTERIOR_LABELS) {
    const photo = listing.photos.find((p) => p.viewLabel === label && !(p.id in (overrides.photos ?? {})));
    if (photo) await load(photo, label);
  }
  for (const id of Object.keys(overrides.photos ?? {})) {
    const photo = listing.photos.find((p) => p.id === id);
    if (photo) await load(photo, `${photo.viewLabel}-${id.slice(0, 8)}`);
    else rejected.push({ label: id, reason: "pinned photo not on this listing" });
  }
  const usable = listing.photos.filter((p) => crops.has(p.id));

  // 2. Which side each auto-picked 3/4 and side photo shows (plan §7). Failure is not fatal: unknowns follow the majority.
  let facing: Facing & { evidence?: unknown } = {};
  try {
    facing = JSON.parse((await run(d, "uv", ["run", "--quiet", "--with", "opencv-python-headless", "--with", "numpy", "python", "pipeline/facing.py", path.join(dir, "normalized")], 300_000)).trim().split("\n").pop()!);
  } catch (e) {
    rejected.push({ label: "facing-detection", reason: (e as Error).message.slice(0, 200) });
  }

  // 3. Ring plan and cameras. SEVA reads intrinsics at the image's native size, so scene images match the ring resolution.
  const ring = ringFor(overrides);
  let views: RingView[] = planRing(usable, facing, overrides, ring);
  for (const v of views) if (v.source === "real") {
    fs.writeFileSync(path.join(dir, "scene", v.file), crops.get(v.sourceImageId!)!.resize({ width: RING.w, height: RING.h, quality: "best" }).toPNG());
  }
  const realFiles = views.filter((v) => v.source === "real").map((v) => v.sourceImage!);
  views = views.map((v) => (v.source === "generated" ? { ...v, conditionedOn: realFiles } : v));
  if (realFiles.length < 3) throw new Error(`needs at least 3 usable exterior photos (front, 3/4, side, rear); found ${realFiles.length}`);

  const transforms = buildTransforms(views, ring, !!overrides.regenerateReals, !!overrides.keepBackground);
  const split = buildSplit(views, !!overrides.regenerateReals);
  fs.writeFileSync(path.join(dir, "scene", "transforms.json"), JSON.stringify(transforms, null, 2));
  fs.writeFileSync(path.join(dir, "scene", `train_test_split_${split.train_ids.length}.json`), JSON.stringify(split, null, 2));
  fs.writeFileSync(path.join(dir, "poses", "transforms.json"), JSON.stringify(transforms, null, 2));
  const manifest = {
    listingId, title: listing.listingTitle, secondaryId: listing.secondaryId, createdAt: new Date().toISOString(),
    ring, facing, overrides,
    assumptions: ["all photos share one camera distance, height and a 60° horizontal FOV", "front faces +X, driver side +Z (officer side -Z)"],
    rejected, views,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---- Orchestration (GI_GENERATE / dashboard "Generate 360") -------------------------------------

function update(d: Deps, g: Generation, patch: Partial<Generation>) {
  Object.assign(g, patch, { updatedAt: new Date().toISOString() });
  if (patch.stage && patch.stage !== "failed") g.error = undefined;
  d.saveGeneration(g);
}

async function pollCall(d: Deps, g: Generation, callId: string, fallback: GenerationStage) {
  const key = g.id;
  for (;;) {
    let s: any;
    try {
      s = await gi(d, "status", callId, key);
    } catch {
      await sleep(15_000); // transient network/CLI failure: keep polling
      continue;
    }
    const p = s.progress;
    if (p && p.stage !== "failed" && p.stage !== "ready") update(d, g, { stage: p.stage, current: p.current ?? undefined, total: p.total ?? undefined, message: p.message ?? undefined });
    if (s.state === "done") return s.result;
    if (s.state === "failed") throw new Error(p?.stage === "failed" && p.message ? p.message : s.error ?? `${fallback} failed`);
    await sleep(10_000);
  }
}

export function newGeneration(d: Deps, listingId: string, title: string, pipeline: SplatPipeline, secondaryId?: number): Generation {
  const active = Object.values(d.loadGenerations()).find((x) => x.listingId === listingId && x.pipeline === pipeline && !TERMINAL.includes(x.stage));
  if (active) return active; // plan §7: retries never duplicate a live job
  const now = new Date().toISOString();
  const g: Generation = { id: `gen-${Date.now().toString(36)}`, listingId, title, secondaryId, pipeline, stage: "queued", calls: {}, done: {}, startedAt: now, updatedAt: now };
  d.saveGeneration(g);
  return g;
}

// Idempotent: every step checks g.done / g.calls, so the same function resumes an interrupted job.
export async function drive(d: Deps, g: Generation, stopAfter?: "views") {
  const release = acquire(d, g.id);
  if (!release) {
    console.log(`${g.id} is already being driven by another process; not starting a second driver`);
    return g;
  }
  try {
    return await driveLocked(d, g, stopAfter);
  } finally {
    release();
  }
}

async function driveLocked(d: Deps, g: Generation, stopAfter?: "views") {
  if (g.paused) update(d, g, { paused: false });
  const dir = expDir(d, g.listingId);
  const remote = `/novel/${g.listingId}`;
  const posedDir = g.pipeline === "posed-test" ? `${remote}/posed-test` : `${remote}/posed`;
  try {
    if (!g.done.prep) {
      update(d, g, { stage: "preparing", message: "Selecting and normalizing exterior photos" });
      if (g.pipeline === "posed-test") {
        if (!d.renderRing) throw new Error("ring renderer unavailable");
        fs.mkdirSync(path.join(dir, "test", "images"), { recursive: true });
        await d.renderRing(g.listingId, path.join(dir, "test"));
        await volumeReplace(d, path.join(dir, "test"), posedDir);
      } else {
        const m = await prep(d, g.listingId);
        await volumeReplace(d, path.join(dir, "scene"), `${remote}/scene`);
        const unsure = ((m.facing as { uncertain?: string[] }).uncertain ?? []).filter((l) => !(l in (m.overrides.labels ?? {})));
        if (unsure.length) update(d, g, { message: `Side unknown for ${unsure.join(", ")}; assumed from the other photos (pin in azimuths.json)` });
      }
      update(d, g, { done: { ...g.done, prep: true } });
    }
    if (g.pipeline !== "posed-test" && !g.done.views) {
      if (!g.calls.views) {
        update(d, g, { stage: "generating_views", current: undefined, total: undefined, message: "Checking view-generator access" });
        const access = (await gi(d, "check")).seva as string; // cheap CPU call: never start an H100 just to hit a 403
        if (!access.startsWith("ok")) throw new Error("View generator license not accepted yet: accept it at huggingface.co/stabilityai/stable-virtual-camera with the Hugging Face account whose token is in Modal, then Retry");
        update(d, g, { current: 0, total: ringCount(dir) - realCount(dir), message: "Starting view generator" });
        update(d, g, { calls: { ...g.calls, views: (await gi(d, "spawn-views", g.listingId, g.id)).callId } });
      }
      await pollCall(d, g, g.calls.views!, "generating_views");
      await volume(d, "get", `${remote}/generated`, dir); // modal volume get <dir> <existing dir> writes <existing dir>/generated/
      update(d, g, { done: { ...g.done, views: true } });
    }
    if (stopAfter === "views") {
      update(d, g, { paused: true, current: undefined, total: undefined, message: `Views ready for inspection in experiments/novel-view/${g.listingId}/generated` });
      return g;
    }
    if (!g.done.cameras) {
      update(d, g, { stage: "building_cameras", current: undefined, total: undefined, message: "Validating camera poses" });
      fs.mkdirSync(path.join(dir, "poses"), { recursive: true });
      const local = path.join(dir, "poses", "posed-transforms.json");
      await volume(d, "get", `${posedDir}/transforms.json`, local);
      const errors = validatePosed(JSON.parse(fs.readFileSync(local, "utf8")), g.pipeline === "posed-test" ? 24 : ringCount(dir));
      if (errors.length) throw new Error(`camera poses invalid: ${errors.slice(0, 3).join("; ")}`);
      update(d, g, { done: { ...g.done, cameras: true } });
    }
    if (!g.done.splat) {
      const job = `novel-${g.listingId.slice(0, 8)}-${g.id}`;
      if (!g.calls.splat) {
        update(d, g, { stage: "reconstructing", current: 0, total: ITERATIONS, message: undefined });
        update(d, g, { calls: { ...g.calls, splat: (await gi(d, "spawn-splat", job, posedDir.slice(1), g.id, String(g.pipeline === "posed-test" ? 24 : ringCount(dir)), "A10G", String(ITERATIONS), "1")).callId } });
      }
      const result = await pollCall(d, g, g.calls.splat!, "reconstructing");
      update(d, g, { stage: "exporting", current: undefined, total: undefined, message: `Downloading splat (${Math.round((result?.ply_bytes ?? 0) / 1e6)} MB)` });
      fs.mkdirSync(path.join(dir, "output"), { recursive: true });
      const out = path.join(dir, "output", g.pipeline === "posed-test" ? "posed-test.ply" : "splat.ply");
      await volume(d, "get", `/jobs/${job}/export/splat.ply`, out);
      // Every camera sits on the ring looking inward, so anything near or beyond the ring is a floater, not vehicle.
      const pruned = out.replace(/\.ply$/, ".pruned.ply");
      const r = pruneSplatFile(out, pruned, { minOpacity: 0.05, maxRadius: RING.radius * 0.6, minY: -0.15, maxY: RING.target[1] * 3.5 });
      update(d, g, { message: `Kept ${r.kept.toLocaleString()} of ${r.total.toLocaleString()} splats` });
      const assetId = d.importSplat(g.listingId, pruned, g.pipeline, viewerScale());
      update(d, g, { done: { ...g.done, splat: true }, assetId });
    }
    update(d, g, { stage: "ready", current: undefined, total: undefined, message: "Ready for review" });
  } catch (e) {
    update(d, g, { stage: "failed", error: (e as Error).message.slice(0, 400) });
  }
  return g;
}

function ringCount(dir: string): number {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).views.length;
  } catch {
    return 24;
  }
}

function realCount(dir: string) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).views.filter((v: RingView) => v.source === "real").length;
  } catch {
    return 0;
  }
}

// Restart: every generation that was mid-flight picks up where it stopped.
export function resumeAll(d: Deps) {
  for (const g of Object.values(d.loadGenerations())) if (!TERMINAL.includes(g.stage) && !g.paused) void drive(d, g);
}
