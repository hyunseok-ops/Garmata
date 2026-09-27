import { nativeImage } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Generation, GenerationStage, ListingDetail, SplatPipeline } from "../src/data/types.ts";
import { buildSplit, buildTransforms, EXTERIOR_LABELS, planRing, RING, validatePosed, viewerScale, type Facing, type RingView } from "../src/data/novel.ts";
import { pruneSplatFile } from "./ply.ts";

// MVP quality bar (not photogrammetry-grade): 7k Splatfacto iterations is ~half the GPU time of the 15k default and
// yields smaller splats that render smoothly; raise it only if the orbit looks under-trained.
const ITERATIONS = 7000;

// Sparse listing photos -> 360 splat (docs/PLAN.md §24, §31, §32). Local steps run here; GPU steps are detached Modal calls
// whose ids and progress are persisted, so a closed window never loses a job and polling resumes on the next launch.

export type Deps = {
  repoRoot: string;
  getListing: (id: string) => Promise<ListingDetail>;
  loadGenerations: () => Record<string, Generation>;
  saveGeneration: (g: Generation) => void;
  importSplat: (listingId: string, file: string, pipeline: SplatPipeline, transformScale: number) => string; // returns assetId
  renderRing?: (listingId: string, outDir: string) => Promise<void>; // posed-test only
};

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
  const overrides: Record<string, number> = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, "utf8")) : {};
  for (const sub of ["real", "normalized", "generated", "poses", "output", "scene"]) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  for (const sub of ["real", "normalized", "generated", "poses", "output", "scene/images"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });

  // 1. One photo per exterior label: download, reject unusable, resize (plan §6), crop to the ring aspect.
  const rejected: { label: string; reason: string }[] = [];
  const crops = new Map<string, Electron.NativeImage>();
  for (const label of EXTERIOR_LABELS) {
    const photo = listing.photos.find((p) => p.viewLabel === label);
    if (!photo) continue;
    try {
      const img = await fetchImage(photo.url);
      const { width, height } = img.getSize();
      if (Math.min(width, height) < 400) throw new Error(`too small (${width}x${height})`);
      fs.writeFileSync(path.join(dir, "real", `${label}.jpg`), fitMax(img, 1600).toJPEG(90));
      const cropped = cropTo(img, RING.w / RING.h);
      fs.writeFileSync(path.join(dir, "normalized", `${label}.jpg`), fitMax(cropped, 1600).toJPEG(90));
      crops.set(label, cropped);
    } catch (e) {
      rejected.push({ label, reason: (e as Error).message });
    }
  }
  const usable = listing.photos.filter((p) => p.viewLabel && crops.has(p.viewLabel));

  // 2. Which side each 3/4 and side photo shows (plan §7). Detection failure is not fatal: unknowns follow the majority.
  let facing: Facing & { evidence?: unknown } = {};
  try {
    facing = JSON.parse((await run(d, "uv", ["run", "--quiet", "--with", "opencv-python-headless", "--with", "numpy", "python", "pipeline/facing.py", path.join(dir, "normalized")], 300_000)).trim().split("\n").pop()!);
  } catch (e) {
    rejected.push({ label: "facing-detection", reason: (e as Error).message.slice(0, 200) });
  }

  // 3. Ring plan and cameras. SEVA reads intrinsics at the image's native size, so scene images match the ring resolution.
  let views: RingView[] = planRing(usable, facing, overrides);
  for (const v of views) if (v.source === "real") {
    const label = listing.photos.find((p) => p.id === v.sourceImageId)!.viewLabel!;
    fs.writeFileSync(path.join(dir, "scene", v.file), crops.get(label)!.resize({ width: RING.w, height: RING.h, quality: "best" }).toPNG());
  }
  const realFiles = views.filter((v) => v.source === "real").map((v) => v.sourceImage!);
  views = views.map((v) => (v.source === "generated" ? { ...v, conditionedOn: realFiles } : v));
  if (realFiles.length < 3) throw new Error(`needs at least 3 usable exterior photos (front, 3/4, side, rear); found ${realFiles.length}`);

  const transforms = buildTransforms(views);
  const split = buildSplit(views);
  fs.writeFileSync(path.join(dir, "scene", "transforms.json"), JSON.stringify(transforms, null, 2));
  fs.writeFileSync(path.join(dir, "scene", `train_test_split_${split.train_ids.length}.json`), JSON.stringify(split, null, 2));
  fs.writeFileSync(path.join(dir, "poses", "transforms.json"), JSON.stringify(transforms, null, 2));
  const manifest = {
    listingId, title: listing.listingTitle, secondaryId: listing.secondaryId, createdAt: new Date().toISOString(),
    ring: RING, facing, overrides,
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
        await volume(d, "put", path.join(dir, "test"), posedDir);
      } else {
        const m = await prep(d, g.listingId);
        await volume(d, "put", path.join(dir, "scene"), `${remote}/scene`);
        const unsure = ((m.facing as { uncertain?: string[] }).uncertain ?? []).filter((l) => !(l in m.overrides));
        if (unsure.length) update(d, g, { message: `Side unknown for ${unsure.join(", ")}; assumed from the other photos (pin in azimuths.json)` });
      }
      update(d, g, { done: { ...g.done, prep: true } });
    }
    if (g.pipeline !== "posed-test" && !g.done.views) {
      if (!g.calls.views) {
        update(d, g, { stage: "generating_views", current: undefined, total: undefined, message: "Checking view-generator access" });
        const access = (await gi(d, "check")).seva as string; // cheap CPU call: never start an H100 just to hit a 403
        if (!access.startsWith("ok")) throw new Error("Stable Virtual Camera weights are gated: accept the license at huggingface.co/stabilityai/stable-virtual-camera with the account behind Modal's `huggingface` secret, then Retry");
        update(d, g, { current: 0, total: 24 - realCount(dir), message: "Starting view generator" });
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
      const errors = validatePosed(JSON.parse(fs.readFileSync(local, "utf8")), 24);
      if (errors.length) throw new Error(`camera poses invalid: ${errors.slice(0, 3).join("; ")}`);
      update(d, g, { done: { ...g.done, cameras: true } });
    }
    if (!g.done.splat) {
      const job = `novel-${g.listingId.slice(0, 8)}-${g.id}`;
      if (!g.calls.splat) {
        update(d, g, { stage: "reconstructing", current: 0, total: ITERATIONS, message: undefined });
        update(d, g, { calls: { ...g.calls, splat: (await gi(d, "spawn-splat", job, posedDir.slice(1), g.id, "24", "A10G", String(ITERATIONS))).callId } });
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
