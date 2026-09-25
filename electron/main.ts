import { app, BrowserWindow, ipcMain, nativeImage, net, protocol, shell } from "electron";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import type { Listing3DAsset, Listing3DTag, ListingDetail, ListingSummary } from "../src/data/types.ts";
import { pickGenerationPhotos } from "../src/data/photos.ts";
import { smoke } from "./smoke.ts";

app.setName("garage-intelligence"); // userData path must not depend on how Electron was launched
dns.setDefaultResultOrder("ipv4first"); // Meshy over IPv6 stalls on this network
try { process.loadEnvFile(path.join(import.meta.dirname, "../.env")); } catch { /* no .env */ }

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
type Store = { assets: Listing3DAsset[]; tags: Listing3DTag[]; jobs: Record<string, string> }; // jobs: assetId -> provider task id
const dataDir = () => path.join(app.getPath("userData"), "3d");
const storePath = () => path.join(dataDir(), "store.json");
const glbPath = (assetId: string) => path.join(dataDir(), `${assetId}.glb`);
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

// ---- Generation provider: Meshy multi-image-to-3D ------------------------------------------------
const MESHY = "https://api.meshy.ai/openapi/v1/multi-image-to-3d";
const meshyKey = () => process.env.MESHY_API_KEY;
async function meshy(pathname: string, init?: RequestInit) {
  const res = await fetch(MESHY + pathname, { ...init, signal: AbortSignal.timeout(init?.method === "POST" ? 300_000 : 60_000), headers: { Authorization: `Bearer ${meshyKey()}`, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`Meshy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Listing originals run to 8K/30MB and providers reject them; ship 1600px JPEG data URIs instead.
async function generationInput(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Photo download failed (${res.status})`);
  const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
  const { width } = img.getSize();
  const small = width > 1600 ? img.resize({ width: 1600, quality: "best" }) : img;
  return `data:image/jpeg;base64,${small.toJPEG(85).toString("base64")}`;
}

async function requestGeneration(listingId: string): Promise<Listing3DAsset> {
  if (!meshyKey()) throw new Error("MESHY_API_KEY is not set; generation provider unavailable");
  const store = loadStore();
  const live = store.assets.find((a) => a.listingId === listingId && (a.processingStatus === "queued" || a.processingStatus === "processing"));
  if (live) return live; // no duplicate jobs
  const listing = await getListing(listingId);
  const inputs = pickGenerationPhotos(listing.photos);
  if (inputs.length === 0) throw new Error("No exterior photos to generate from");
  const fingerprint = inputs.map((p) => p.id).join("|");
  const version = Math.max(0, ...store.assets.filter((a) => a.listingId === listingId).map((a) => a.version)) + 1;
  const asset: Listing3DAsset = {
    id: `${listing.secondaryId}-v${version}`, listingId, version, representation: "reconstructed", format: "glb", storageKey: null,
    sourceImageIds: inputs.map((p) => p.id), sourceFingerprint: fingerprint, pipelineVersion: "meshy-multi-image-1",
    processingStatus: "queued", reviewStatus: "pending", createdAt: new Date().toISOString(),
  };
  // Meshy fetches the source photos before answering the POST; this can take minutes.
  const image_urls = await Promise.all(inputs.map((p) => generationInput(p.url)));
  const { result: taskId } = await meshy("", {
    method: "POST",
    body: JSON.stringify({ image_urls, should_texture: true, enable_pbr: true, ai_model: "latest", target_formats: ["glb"] }),
  });
  store.assets.push(asset);
  store.jobs[asset.id] = taskId;
  saveStore(store);
  void pollJob(asset.id);
  return asset;
}

async function pollJob(assetId: string) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const store = loadStore();
    const asset = store.assets.find((a) => a.id === assetId);
    const taskId = store.jobs[assetId];
    if (!asset || !taskId) return;
    try {
      const task = await meshy(`/${taskId}`);
      if (task.status === "SUCCEEDED") {
        const glb = await fetch(task.model_urls.glb);
        if (!glb.ok) throw new Error(`GLB download failed (${glb.status})`);
        fs.mkdirSync(dataDir(), { recursive: true });
        fs.writeFileSync(glbPath(assetId), Buffer.from(await glb.arrayBuffer()));
        asset.processingStatus = "ready";
        asset.storageKey = `gi-asset://${assetId}`;
        delete store.jobs[assetId];
      } else if (task.status === "FAILED" || task.status === "CANCELED") {
        asset.processingStatus = "failed";
        asset.error = task.task_error?.message ?? task.status;
        delete store.jobs[assetId];
      } else {
        asset.processingStatus = "processing";
      }
      saveStore(store);
      if (!store.jobs[assetId]) return;
    } catch (e) {
      asset.processingStatus = "failed";
      asset.error = String((e as Error).message);
      delete store.jobs[assetId];
      saveStore(store);
      return;
    }
  }
}

// ---- IPC -----------------------------------------------------------------------------------------
ipcMain.handle("status", () => ({ garage: !!db, provider: !!meshyKey() }));
ipcMain.handle("listings.search", (_e, q: string) => searchListings(q));
ipcMain.handle("listings.get", (_e, id: string) => getListing(id));
ipcMain.handle("assets.current", (_e, listingId: string) => currentAsset(loadStore(), listingId));
ipcMain.handle("assets.generate", (_e, listingId: string) => requestGeneration(listingId));
ipcMain.handle("assets.review", (_e, assetId: string, reviewStatus: "approved" | "rejected") => {
  const s = loadStore();
  const a = s.assets.find((x) => x.id === assetId);
  if (a) { a.reviewStatus = reviewStatus; saveStore(s); }
  return a ?? null;
});
ipcMain.handle("tags.list", (_e, assetVersionId: string) => loadStore().tags.filter((t) => t.assetVersionId === assetVersionId));
ipcMain.handle("tags.save", (_e, assetVersionId: string, tags: Listing3DTag[]) => {
  const s = loadStore();
  s.tags = [...s.tags.filter((t) => t.assetVersionId !== assetVersionId), ...tags.filter((t) => t.assetVersionId === assetVersionId)];
  saveStore(s);
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

// Headless: GI_GENERATE=<listingId,...> submits multi-image jobs for those listings, waits for them, exits.
async function generateCli(ids: string[]) {
  for (const id of ids) {
    const a = await requestGeneration(id);
    console.log(`submitted ${a.id} from ${a.sourceImageIds.length} photos`);
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, 15_000));
    const s = loadStore();
    const mine = s.assets.filter((a) => ids.includes(a.listingId));
    console.log(mine.map((a) => `${a.id}: ${a.processingStatus}${a.error ? " " + a.error : ""}`).join(" | "));
    if (mine.every((a) => a.processingStatus === "ready" || a.processingStatus === "failed")) return;
  }
}

// Headless: GI_IMPORT=<listingId>,<file.ply|.glb>,<pipelineVersion>[,illustrative] registers an externally produced asset version.
// GI_TRANSFORM='{"scale":1,"position":[0,0,0],"rotationDeg":[180,0,0]}' sets the reviewed normalization for splats.
function importCli(listingId: string, file: string, pipelineVersion: string, representation: Listing3DAsset["representation"]) {
  const s = loadStore();
  const version = Math.max(0, ...s.assets.filter((a) => a.listingId === listingId).map((a) => a.version)) + 1;
  const ext = path.extname(file).toLowerCase();
  const id = `${listingId.slice(0, 8)}-v${version}`;
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.copyFileSync(file, path.join(dataDir(), id + ext));
  s.assets.push({
    id, listingId, version, representation, format: ext === ".glb" ? "glb" : "splat", storageKey: `gi-asset://${id}`,
    sourceImageIds: [], sourceFingerprint: `import:${path.basename(file)}`, pipelineVersion, processingStatus: "ready", reviewStatus: "pending",
    createdAt: new Date().toISOString(), ...(process.env.GI_TRANSFORM ? { transform: JSON.parse(process.env.GI_TRANSFORM) } : {}),
  });
  saveStore(s);
  console.log(`imported ${id} (${ext}) for listing ${listingId}`);
}

app.whenReady().then(() => {
  if (process.env.GI_IMPORT) {
    const [listingId, file, pipelineVersion = "manual", rep] = process.env.GI_IMPORT.split(",");
    importCli(listingId, file, pipelineVersion, rep === "illustrative" ? "illustrative" : "reconstructed");
    app.exit(0);
    return;
  }
  if (process.env.GI_GENERATE) {
    void generateCli(process.env.GI_GENERATE.split(",")).catch((e) => console.error(e)).finally(() => app.exit(0));
    return;
  }
  protocol.handle("gi-asset", (req) => {
    const id = path.basename(new URL(req.url).hostname || new URL(req.url).pathname);
    const file = assetFile(id.replace(/[^a-z0-9_-]/gi, ""));
    return file ? net.fetch(pathToFileURL(file).href) : new Response("not found", { status: 404 });
  });
  for (const assetId of Object.keys(loadStore().jobs)) void pollJob(assetId); // resume after restart
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
