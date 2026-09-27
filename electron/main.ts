import { app, BrowserWindow, ipcMain, net, protocol, shell } from "electron";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import type { Generation, Listing3DAsset, Listing3DTag, ListingDetail, ListingSummary, SplatPipeline } from "../src/data/types.ts";
import { ringAzimuths, RING, buildTransforms, viewerScale } from "../src/data/novel.ts";
import { drive, newGeneration, prep, resumeAll, type Deps } from "./novel.ts";
import { smoke } from "./smoke.ts";

app.setName("garage-intelligence"); // userData path must not depend on how Electron was launched
dns.setDefaultResultOrder("ipv4first"); // long-lived HTTPS over IPv6 stalls on this network
// Dev: repo-root .env. Packaged: <userData>/.env (Application Support/garage-intelligence/.env), never inside the app bundle.
for (const envPath of [path.join(import.meta.dirname, "../.env"), path.join(app.getPath("userData"), ".env")]) {
  try { process.loadEnvFile(envPath); break; } catch { /* try next */ }
}

// ---- Garage (read-only Postgres) ----------------------------------------------------------------
const db = process.env.GARAGE_DATABASE_URL ? new pg.Pool({ connectionString: process.env.GARAGE_DATABASE_URL, max: 3 }) : null;
const dbOrThrow = () => { if (!db) throw new Error("GARAGE_DATABASE_URL is not set"); return db; };

async function searchListings(query: string): Promise<ListingSummary[]> {
  const q = query.trim();
  const { rows } = await dbOrThrow().query(
    `SELECT l.id, l."secondaryId", l."listingTitle", l."imageUrls"[1] AS thumb
       FROM "Listing" l
      WHERE l.status = 'ACTIVE' AND ($1 = '' OR l."listingTitle" ILIKE '%' || $1 || '%' OR l."secondaryId"::text LIKE $1 || '%')
      ORDER BY l."createdAt" DESC LIMIT 40`,
    [q],
  );
  const store = loadStore();
  return rows.map((r) => ({
    id: r.id, secondaryId: r.secondaryId, listingTitle: r.listingTitle, thumbnailUrl: r.thumb ?? undefined,
    processingStatus: currentAsset(store, r.id)?.processingStatus ?? "none",
  }));
}

async function getListing(id: string): Promise<ListingDetail> {
  const d = dbOrThrow();
  const [l, imgs, attrs] = await Promise.all([
    d.query(`SELECT id, "secondaryId", "listingTitle", "itemBrand", "listingDescription", "imageUrls" FROM "Listing" WHERE id = $1`, [id]),
    d.query(`SELECT li.id, coalesce(sm.url, m.url) AS url, li."viewLabel" FROM "ListingImage" li
               JOIN "Media" m ON m.id = li."mediaId" LEFT JOIN "Media" sm ON sm.id = li."scrubbedMediaId"
              WHERE li."listingId" = $1 AND li.status = 'APPROVED' ORDER BY li."order"`, [id]),
    d.query(`SELECT a.label, la.value FROM "ListingAttribute" la JOIN "Attribute" a ON a.id = la."attributeId" WHERE la."listingId" = $1 ORDER BY a."order"`, [id]),
  ]);
  const row = l.rows[0];
  if (!row) throw new Error("Listing not found");
  // Legacy listings have imageUrls but no ListingImage rows.
  const photos = imgs.rows.length ? imgs.rows.map((r) => ({ id: r.id, url: r.url, viewLabel: r.viewLabel ?? undefined }))
    : ((row.imageUrls ?? []) as string[]).map((url: string, i: number) => ({ id: `${id}:${i}`, url }));
  return {
    id: row.id, secondaryId: row.secondaryId, listingTitle: row.listingTitle, itemBrand: row.itemBrand ?? undefined,
    listingDescription: row.listingDescription ?? undefined, photos,
    attributes: Object.fromEntries(attrs.rows.map((r) => [r.label, r.value])),
    processingStatus: currentAsset(loadStore(), id)?.processingStatus ?? "none",
  };
}

// ---- Local asset store -------------------------------------------------------------------------
// ponytail: JSON file + GLBs in userData. Move to Garage DB/object storage when a second machine needs the data.
type Store = { assets: Listing3DAsset[]; tags: Listing3DTag[]; jobs: Record<string, string>; generations?: Record<string, Generation> };
const dataDir = () => path.join(app.getPath("userData"), "3d");
const storePath = () => path.join(dataDir(), "store.json");
const assetFile = (assetId: string) => [".glb", ".ply", ".spz"].map((e) => path.join(dataDir(), assetId + e)).find((f) => fs.existsSync(f));
function loadStore(): Store {
  try { return JSON.parse(fs.readFileSync(storePath(), "utf8")); } catch { return { assets: [], tags: [], jobs: {} }; }
}
function saveStore(s: Store) { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(storePath(), JSON.stringify(s, null, 2)); }
// Viewer shows the newest approved version; falls back to the newest of any status so users see honest job state.
function currentAsset(s: Store, listingId: string) {
  const mine = s.assets.filter((a) => a.listingId === listingId).sort((a, b) => b.version - a.version);
  return mine.find((a) => a.reviewStatus === "approved") ?? mine[0] ?? null;
}

// ---- IPC -----------------------------------------------------------------------------------------
ipcMain.handle("status", () => ({ garage: !!db, sync: garageConfigured() }));
ipcMain.handle("listings.search", (_e, q: string) => searchListings(q));
ipcMain.handle("listings.get", (_e, id: string) => getListing(id));
ipcMain.handle("assets.current", (_e, listingId: string) => currentAsset(loadStore(), listingId));
ipcMain.handle("assets.list", (_e, listingId: string) => loadStore().assets.filter((a) => a.listingId === listingId).sort((a, b) => b.version - a.version));
// Ready-for-review queue: 360 versions only (legacy meshes are not part of the MVP product).
ipcMain.handle("assets.pending", () => loadStore().assets.filter((a) => (a.format === "splat" || a.format === "spin") && a.processingStatus === "ready" && a.reviewStatus === "pending"));
ipcMain.handle("generations.list", () => Object.values(loadStore().generations ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
ipcMain.handle("generations.start", async (_e, listingId: string, pipeline: SplatPipeline = "novel-view-splat") => {
  const l = await getListing(listingId);
  const g = newGeneration(deps, listingId, l.listingTitle, pipeline, l.secondaryId);
  if (g.stage === "queued") void drive(deps, g);
  return g;
});
ipcMain.handle("generations.retry", (_e, id: string) => {
  const old = loadStore().generations?.[id];
  if (!old) throw new Error(`no generation ${id}`);
  const g = newGeneration(deps, old.listingId, old.title, old.pipeline, old.secondaryId); // failed = terminal, so this is a fresh run
  if (g.stage === "queued") void drive(deps, g);
  return g;
});
ipcMain.handle("assets.review", async (_e, assetId: string, reviewStatus: "approved" | "rejected") => {
  const s = loadStore();
  const a = s.assets.find((x) => x.id === assetId);
  if (a) { a.reviewStatus = reviewStatus; saveStore(s); }
  if (a && garageConfigured()) await pushAsset(assetId).catch((e) => console.error("garage sync:", e.message));
  return a ?? null;
});
ipcMain.handle("tags.list", (_e, assetVersionId: string) => loadStore().tags.filter((t) => t.assetVersionId === assetVersionId));
ipcMain.handle("tags.save", async (_e, assetVersionId: string, tags: Listing3DTag[]) => {
  const s = loadStore();
  s.tags = [...s.tags.filter((t) => t.assetVersionId !== assetVersionId), ...tags.filter((t) => t.assetVersionId === assetVersionId)];
  saveStore(s);
  if (garageConfigured()) await pushAsset(assetVersionId).catch((e) => console.error("garage sync:", e.message));
});

// ---- Window --------------------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{ scheme: "gi-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, title: "Garage Intelligence",
    webPreferences: { preload: path.join(import.meta.dirname, "preload.mjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(import.meta.dirname, "../dist/index.html"));
  if (process.env.GI_SMOKE_OUT) void smoke(win, process.env.GI_SMOKE_OUT, process.env.GI_SMOKE_QUERY ?? "").finally(() => app.exit(0));
}

// ---- Novel-view 360 pipeline (electron/novel.ts) -----------------------------------------------
const deps: Deps = {
  repoRoot: path.join(import.meta.dirname, ".."),
  getListing,
  loadGenerations: () => loadStore().generations ?? {},
  saveGeneration: (g) => { const s = loadStore(); s.generations = { ...(s.generations ?? {}), [g.id]: g }; saveStore(s); },
  importSplat: (listingId, file, pipeline, scale) => {
    const id = importAsset(listingId, file, pipeline, pipeline === "posed-test" ? "illustrative" : "reconstructed", { scale, position: [0, 0, 0], rotationDeg: [0, 0, 0] });
    try {
      const m = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)), "manifest.json"), "utf8"));
      const st = loadStore();
      const a = st.assets.find((x) => x.id === id)!;
      if (pipeline !== "posed-test") {
        a.sourceImageIds = m.views.filter((v: { source: string }) => v.source === "real").map((v: { sourceImageId: string }) => v.sourceImageId);
        a.sourceFingerprint = `ring:${a.sourceImageIds.join("|")}`;
      }
      saveStore(st);
    } catch { /* manifest missing: provenance stays minimal */ }
    return id;
  },
  renderRing,
  lockDir: () => path.join(dataDir(), "locks"),
};

// posed-test: render the listing's current mesh from the exact 24 ring cameras in a hidden window, so the
// pose -> Splatfacto -> viewer chain can be verified without the view generator.
async function renderRing(listingId: string, outDir: string) {
  const asset = currentAsset(loadStore(), listingId);
  if (!asset || asset.format !== "glb") throw new Error("posed-test needs an existing mesh version to render");
  const win = new BrowserWindow({
    width: RING.w, height: RING.h, useContentSize: true, show: false,
    webPreferences: { preload: path.join(import.meta.dirname, "preload.mjs"), contextIsolation: true, sandbox: true, offscreen: false },
  });
  const frames = new Map<number, Buffer>();
  const done = new Promise<void>((resolve, reject) => {
    const onFrame = (_e: Electron.IpcMainEvent, az: number, dataUrl: string) => frames.set(az, Buffer.from(dataUrl.split(",")[1], "base64"));
    const onDone = (_e: Electron.IpcMainEvent, err?: string) => { ipcMain.off("ring.frame", onFrame); ipcMain.off("ring.done", onDone); err ? reject(new Error(err)) : resolve(); };
    ipcMain.on("ring.frame", onFrame);
    ipcMain.on("ring.done", onDone);
  });
  const hash = `ring-render=${encodeURIComponent(asset.id)}`;
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${hash}`);
  else await win.loadFile(path.join(import.meta.dirname, "../dist/index.html"), { hash });
  await Promise.race([done, new Promise((_, r) => setTimeout(() => r(new Error("ring render timed out")), 120_000))]).finally(() => win.destroy());
  const views = ringAzimuths().map((azimuth) => ({ azimuth, file: `images/${String(azimuth).padStart(3, "0")}.png`, source: "real" as const }));
  for (const v of views) {
    const png = frames.get(v.azimuth);
    if (!png) throw new Error(`ring render missing ${v.azimuth}°`);
    fs.writeFileSync(path.join(outDir, v.file), png);
  }
  fs.writeFileSync(path.join(outDir, "transforms.json"), JSON.stringify(buildTransforms(views), null, 2));
}

async function driveCli(listingIds: string[], pipeline: SplatPipeline, stopAfterViews = false) {
  const gens = await Promise.all(listingIds.map(async (id) => {
    const l = await getListing(id);
    return newGeneration(deps, id, l.listingTitle, pipeline, l.secondaryId);
  }));
  const tick = setInterval(() => {
    const all = loadStore().generations ?? {};
    console.log(gens.map((g) => { const x = all[g.id]; return `${x.title}: ${x.stage}${x.total ? ` ${x.current ?? 0}/${x.total}` : ""}${x.error ? ` (${x.error})` : ""}`; }).join(" | "));
  }, 20_000);
  await Promise.all(gens.map((g) => drive(deps, g, stopAfterViews ? "views" : undefined)));
  clearInterval(tick);
  const all = loadStore().generations ?? {};
  for (const g of gens) console.log(`${all[g.id].title}: ${all[g.id].stage}${all[g.id].error ? ` (${all[g.id].error})` : ""}${all[g.id].assetId ? ` -> ${all[g.id].assetId}` : ""}`);
}

// ---- Garage sync (admin oRPC, OpenAPI routes) --------------------------------------------------
// GARAGE_API_URL + GARAGE_API_KEY (a Clerk admin API key, "ak_...") turn on write-through to Garage's Listing3DAsset /
// Listing3DTag tables and the private "listing-3d" bucket. Without them the app stays local-only.
const garageUrl = () => process.env.GARAGE_API_URL?.replace(/\/$/, "");
const garageConfigured = () => !!(garageUrl() && process.env.GARAGE_API_KEY);

async function garage<T>(op: string, input: unknown): Promise<T> {
  const res = await fetch(`${garageUrl()}/admin/listings3d/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GARAGE_API_KEY}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Garage ${op} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

type RemoteAsset = { id: string; version: number; storageKey: string | null; downloadUrl: string | null; reviewStatus: string; processingStatus: string };

// Push one local asset (metadata, file, review state, tags) to Garage. Idempotent: skips the file if already uploaded.
async function pushAsset(assetId: string) {
  const s = loadStore();
  const a = s.assets.find((x) => x.id === assetId);
  if (!a) throw new Error(`no asset ${assetId}`);
  let remote: RemoteAsset;
  let uploadUrl: string | null = null;
  if (a.remoteId) {
    remote = (await garage<RemoteAsset[]>("listAssets", { listingId: a.listingId })).find((r) => r.id === a.remoteId)!;
  } else {
    const created = await garage<{ asset: RemoteAsset; uploadUrl: string | null }>("createAsset", {
      listingId: a.listingId, representation: a.representation.toUpperCase(), format: a.format === "glb" ? "GLB" : "SPLAT",
      sourceImageIds: a.sourceImageIds, sourceFingerprint: a.sourceFingerprint, pipelineVersion: a.pipelineVersion,
      transform: a.transform ?? null, processingStatus: a.processingStatus.toUpperCase(), error: a.error ?? null,
    });
    remote = created.asset;
    uploadUrl = created.uploadUrl;
    a.remoteId = remote.id;
    saveStore(s);
  }
  const file = assetFile(a.id);
  if (file && !remote.storageKey && uploadUrl) {
    const put = await fetch(uploadUrl, { method: "PUT", body: fs.readFileSync(file), headers: { "Content-Type": "application/octet-stream" } });
    if (!put.ok) throw new Error(`upload ${put.status}`);
    await garage("updateAsset", { assetId: remote.id, uploaded: true, processingStatus: "READY" });
  }
  await garage("reviewAsset", { assetId: remote.id, reviewStatus: a.reviewStatus.toUpperCase() });
  const tags = s.tags.filter((t) => t.assetVersionId === a.id).map((t) => ({
    id: t.id, label: t.label, category: t.category, position: t.position, camera: t.camera ?? null,
    description: t.description ?? null, order: t.order, evidenceImages: t.evidence.imageIds, evidenceFields: t.evidence.fields,
  }));
  await garage("saveTags", { assetId: remote.id, tags });
  console.log(`pushed ${a.id} -> ${remote.id} (${tags.length} tags${file && !remote.storageKey ? ", file uploaded" : ""})`);
}

// ---- Tag seeding -------------------------------------------------------------------------------
// Template positions in the viewer frame (vehicle faces +X, driver side +Z, ~8 units long). Reviewers drag to refine.
type Seed = { label: string; category: Listing3DTag["category"]; position: [number, number, number]; camera: [[number, number, number], [number, number, number]]; views: string[]; fields: RegExp; description: string };
const CAM_SIDE = (x: number, y: number): [[number, number, number], [number, number, number]] => [[x + 0.6, y + 1, 6.8], [x, y - 0.1, 0.6]];
const PUMPER: Seed[] = [
  { label: "Cab", category: "Cab", position: [2.7, 1.9, 1.28], camera: [[7.5, 3.2, 6.5], [2.7, 1.6, 0.3]], views: ["cab_interior", "dash"], fields: /model|chassis|automatic|cab|seat/i, description: "Cab and crew area." },
  { label: "Pump Panel", category: "Pump Panel", position: [0.9, 1.55, 1.3], camera: CAM_SIDE(0.9, 1.5), views: ["pump_panel"], fields: /pump|tank|foam/i, description: "Pump operator's panel." },
  { label: "Compartments", category: "Compartments", position: [-1.6, 1.35, 1.3], camera: CAM_SIDE(-1.6, 1.3), views: ["compartment"], fields: /body/i, description: "Body compartments, driver side." },
  { label: "Engine", category: "Engine", position: [3.95, 1.05, 0], camera: [[9.5, 2.2, 1.5], [4, 1.1, 0]], views: ["engine_bay"], fields: /engine|mileage|fuel|runs|service|hours/i, description: "Engine and drivetrain." },
  { label: "Wheels/Tires", category: "Wheels/Tires", position: [2.3, 0.5, 1.2], camera: [[4.2, 1.3, 5.2], [2.3, 0.5, 0.8]], views: ["wheel_tire", "undercarriage"], fields: /4wd|tire|wheel|axle/i, description: "Wheels, tires and undercarriage." },
  { label: "Rear", category: "Rear", position: [-3.95, 1.4, 0], camera: [[-9.5, 2.6, 2], [-4, 1.3, 0]], views: ["rear", "rear_34"], fields: /tank|vehicle type|hose/i, description: "Rear of the apparatus." },
];
const AERIAL: Seed[] = [
  ...PUMPER.filter((t) => t.label !== "Rear"),
  { label: "Aerial", category: "Other", position: [-1.5, 2.7, 0], camera: [[-3, 5.5, 6.5], [-1.5, 2.4, 0]], views: ["other"], fields: /aerial|ladder|jack|outrigger/i, description: "Aerial device, turntable and jacks." },
  { label: "Rear", category: "Rear", position: [-3.95, 1.4, 0], camera: [[-9.5, 2.6, 2], [-4, 1.3, 0]], views: ["rear", "rear_34"], fields: /tank|vehicle type|hose/i, description: "Rear of the apparatus." },
];
const AMBULANCE: Seed[] = [
  { label: "Cab", category: "Cab", position: [2.9, 1.7, 1.15], camera: [[7.5, 3, 6.5], [2.9, 1.4, 0.3]], views: ["cab_interior", "dash"], fields: /model|chassis|automatic|cab|seat|make/i, description: "Chassis cab." },
  { label: "Patient Module", category: "Other", position: [-0.8, 1.9, 1.3], camera: CAM_SIDE(-0.8, 1.8), views: ["module_interior"], fields: /module|stretcher|cot|headroom|interior/i, description: "Patient compartment interior." },
  { label: "Compartments", category: "Compartments", position: [-2.2, 1.1, 1.3], camera: CAM_SIDE(-2.2, 1.1), views: ["compartment"], fields: /body|builder/i, description: "Exterior compartments." },
  { label: "Engine", category: "Engine", position: [4.1, 1.0, 0], camera: [[9.5, 2.2, 1.5], [4.1, 1.0, 0]], views: ["engine_bay"], fields: /engine|mileage|fuel|runs|service|hours/i, description: "Engine and drivetrain." },
  { label: "Wheels/Tires", category: "Wheels/Tires", position: [2.6, 0.5, 1.15], camera: [[4.5, 1.3, 5], [2.6, 0.5, 0.8]], views: ["wheel_tire", "undercarriage"], fields: /4wd|tire|wheel|axle/i, description: "Wheels and tires." },
  { label: "Rear Doors", category: "Rear", position: [-3.9, 1.5, 0], camera: [[-9.5, 2.6, 2], [-3.9, 1.4, 0]], views: ["rear", "rear_34"], fields: /vehicle type|loader|lift/i, description: "Rear loading doors." },
];
function templateFor(title: string): Seed[] {
  if (/ambulance|type i\b|type ii|type iii/i.test(title)) return AMBULANCE;
  if (/quint|aerial|ladder|tower|platform/i.test(title)) return AERIAL;
  return PUMPER;
}
async function seedTags(assetId: string) {
  const s = loadStore();
  const asset = s.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`no asset ${assetId}`);
  const listing = await getListing(asset.listingId);
  const template = templateFor(listing.listingTitle);
  const tags: Listing3DTag[] = template.map((t, i) => ({
    id: crypto.randomUUID(), assetVersionId: assetId, label: t.label, category: t.category, position: t.position,
    camera: { position: t.camera[0], target: t.camera[1] }, description: t.description, order: i,
    evidence: {
      imageIds: listing.photos.filter((p) => p.viewLabel && t.views.includes(p.viewLabel)).slice(0, 6).map((p) => p.id),
      fields: Object.keys(listing.attributes).filter((f) => t.fields.test(f)),
    },
  })).filter((t) => t.evidence.imageIds.length || t.evidence.fields.length); // plan §8: only tags supported by evidence
  s.tags = [...s.tags.filter((t) => t.assetVersionId !== assetId), ...tags];
  saveStore(s);
  console.log(`seeded ${tags.length} tags on ${assetId} (${template === AMBULANCE ? "ambulance" : template === AERIAL ? "aerial" : "pumper"} template)`);
}

// Headless: GI_IMPORT=<listingId>,<file.ply|.glb>,<pipelineVersion>[,illustrative] registers an externally produced asset version.
// GI_TRANSFORM='{"scale":1,"position":[0,0,0],"rotationDeg":[180,0,0]}' sets the reviewed normalization for splats.
function importAsset(listingId: string, file: string, pipelineVersion: string, representation: Listing3DAsset["representation"], transform?: Listing3DAsset["transform"]): string {
  const s = loadStore();
  const version = Math.max(0, ...s.assets.filter((a) => a.listingId === listingId).map((a) => a.version)) + 1;
  const ext = path.extname(file).toLowerCase();
  const id = `${listingId.slice(0, 8)}-v${version}`;
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.copyFileSync(file, path.join(dataDir(), id + ext));
  s.assets.push({
    id, listingId, version, representation, format: ext === ".glb" ? "glb" : "splat", storageKey: `gi-asset://${id}`,
    sourceImageIds: [], sourceFingerprint: `import:${path.basename(file)}`, pipelineVersion, processingStatus: "ready", reviewStatus: "pending",
    createdAt: new Date().toISOString(), transform: transform ?? (process.env.GI_TRANSFORM ? JSON.parse(process.env.GI_TRANSFORM) : undefined),
  });
  saveStore(s);
  console.log(`imported ${id} (${ext}) for listing ${listingId}`);
  return id;
}

app.whenReady().then(() => {
  protocol.handle("gi-asset", (req) => {
    const u = new URL(req.url);
    const id = (u.hostname || u.pathname.split("/")[1] || "").replace(/[^a-z0-9_-]/gi, "");
    const rest = u.hostname ? u.pathname.replace(/^\//, "") : u.pathname.split("/").slice(2).join("/");
    // Folder assets (spin): gi-asset://<assetId>/<relative file>, confined to that asset's folder.
    if (rest) {
      const root = path.join(dataDir(), id);
      const file = path.resolve(root, rest);
      return file.startsWith(root + path.sep) && fs.existsSync(file) ? net.fetch(pathToFileURL(file).href) : new Response("not found", { status: 404 });
    }
    const file = assetFile(id);
    return file ? net.fetch(pathToFileURL(file).href) : new Response("not found", { status: 404 });
  });
  const headless = (task: Promise<unknown>) => void task.catch((e) => console.error(e)).finally(() => app.exit(0));
  // Plan §31: separate phases for debugging, plus GI_GENERATE for the whole chain.
  if (process.env.GI_NOVEL_PREP) {
    return headless((async () => { for (const id of process.env.GI_NOVEL_PREP!.split(",")) { const m = await prep(deps, id); console.log(`${m.title}: ${m.views.filter((v) => v.source === "real").length} real / 24, rejected ${JSON.stringify(m.rejected)} -> experiments/novel-view/${id}`); } })());
  }
  if (process.env.GI_NOVEL_GENERATE) return headless(driveCli(process.env.GI_NOVEL_GENERATE.split(","), "novel-view-splat", true));
  if (process.env.GI_NOVEL_SPLAT || process.env.GI_GENERATE) return headless(driveCli((process.env.GI_NOVEL_SPLAT ?? process.env.GI_GENERATE)!.split(","), "novel-view-splat"));
  if (process.env.GI_NOVEL_RENDER_TEST) return headless(driveCli(process.env.GI_NOVEL_RENDER_TEST.split(","), "posed-test"));
  if (process.env.GI_SPIN_BUILD) {
    // Photo spin from the generated lap + every alignable real exterior photo (pipeline/spin_build.py).
    return headless((async () => {
      for (const id of process.env.GI_SPIN_BUILD!.split(",")) {
        const l = await getListing(id);
        const exp = path.join(deps.repoRoot, "experiments", "novel-view", id);
        const cands = path.join(exp, "spin-candidates.json");
        fs.writeFileSync(cands, JSON.stringify(l.photos.filter((p) => p.viewLabel).map((p) => ({ id: p.id, url: p.url, viewLabel: p.viewLabel }))));
        const out = path.join(exp, "spin");
        fs.rmSync(out, { recursive: true, force: true });
        const { execFileSync } = await import("node:child_process");
        const res = execFileSync("uv", ["run", "--quiet", "--with", "rembg", "--with", "onnxruntime", "--with", "opencv-python-headless", "--with", "numpy", "--with", "pillow", "--with", "requests",
          "python", "pipeline/spin_build.py", exp, cands, out], { cwd: deps.repoRoot, encoding: "utf8", maxBuffer: 64 << 20, timeout: 1_800_000 });
        const summary = JSON.parse(res.trim().split("\n").pop()!);
        const st = loadStore();
        const version = Math.max(0, ...st.assets.filter((a) => a.listingId === id).map((a) => a.version)) + 1;
        const assetId = `${id.slice(0, 8)}-v${version}`;
        fs.cpSync(out, path.join(dataDir(), assetId), { recursive: true });
        st.assets.push({
          id: assetId, listingId: id, version, representation: "reconstructed", format: "spin", storageKey: `gi-asset://${assetId}/spin.json`,
          sourceImageIds: summary.placed.map((p: { photo: string }) => p.photo), sourceFingerprint: `spin:${summary.placed.map((p: { photo: string }) => p.photo).join("|")}`,
          pipelineVersion: "photo-spin", processingStatus: "ready", reviewStatus: "pending", createdAt: new Date().toISOString(),
          transform: { scale: viewerScale(), position: [0, 0, 0], rotationDeg: [0, 0, 0] },
        });
        saveStore(st);
        console.log(`spin ${assetId}: ${summary.frames} frames, ${summary.real} real photos`);
      }
    })());
  }
  if (process.env.GI_NOVEL_RESPLAT) {
    // Re-train only: reuse the views already on the volume (novel/<id>/posed) with the current reconstruction settings.
    return headless((async () => {
      for (const id of process.env.GI_NOVEL_RESPLAT!.split(",")) {
        const l = await getListing(id);
        const g = newGeneration(deps, id, l.listingTitle, "novel-view-splat", l.secondaryId);
        deps.saveGeneration({ ...g, done: { ...g.done, prep: true, views: true }, message: "Re-training from existing views" });
      }
      await driveCli(process.env.GI_NOVEL_RESPLAT!.split(","), "novel-view-splat");
    })());
  }
  if (process.env.GI_SYNC) {
    // GI_SYNC=<assetId,...|all> pushes local assets, files, review state and tags to Garage.
    const s = loadStore();
    const ids = process.env.GI_SYNC === "all" ? s.assets.filter((a) => a.processingStatus === "ready").map((a) => a.id) : process.env.GI_SYNC.split(",");
    void (async () => { for (const id of ids) await pushAsset(id); })().catch((e) => console.error(e)).finally(() => app.exit(0));
    return;
  }
  if (process.env.GI_SEED_TAGS) {
    // GI_SEED_TAGS=<assetId,...|approved> seeds template tags; "approved" = every approved asset without tags.
    const s = loadStore();
    const ids = process.env.GI_SEED_TAGS === "approved"
      ? s.assets.filter((a) => a.reviewStatus === "approved" && !s.tags.some((t) => t.assetVersionId === a.id)).map((a) => a.id)
      : process.env.GI_SEED_TAGS.split(",");
    void (async () => { for (const id of ids) await seedTags(id); })().catch((e) => console.error(e)).finally(() => app.exit(0));
    return;
  }
  if (process.env.GI_IMPORT) {
    const [listingId, file, pipelineVersion = "manual", rep] = process.env.GI_IMPORT.split(",");
    importAsset(listingId, file, pipelineVersion, rep === "illustrative" ? "illustrative" : "reconstructed");
    app.exit(0);
    return;
  }
  resumeAll(deps); // generations interrupted by a restart continue polling their Modal calls
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
