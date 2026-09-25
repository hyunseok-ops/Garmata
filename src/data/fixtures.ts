import type { Listing3DAsset, Listing3DTag, ListingDetail, ListingsApi, ListingSummary } from "./types.ts";
import { forAssetVersion } from "./tags.ts";

// Offline placeholder photos so the shell runs without Garage credentials. Replaced by ListingImage media URLs in Phase 2.
const photo = (id: string, label: string, hue: number) => ({
  id,
  viewLabel: label,
  url:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="100%" height="100%" fill="hsl(${hue} 30% 22%)"/><text x="50%" y="50%" fill="#e6e6e6" font-family="system-ui" font-size="28" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`,
    ),
});

const listings: ListingDetail[] = [
  {
    id: "5f1c2a7e-0000-4000-8000-000000000001",
    secondaryId: 41822,
    listingTitle: "2009 Pierce Velocity Pumper",
    itemBrand: "Pierce",
    listingDescription: "Top-mount pumper. 1500 GPM Waterous pump, 750 gallon poly tank. Well maintained municipal unit.",
    processingStatus: "ready",
    photos: [
      photo("img-1", "Front 3/4", 210),
      photo("img-2", "Driver side", 200),
      photo("img-3", "Pump panel", 30),
      photo("img-4", "Officer side", 190),
      photo("img-5", "Rear", 0),
      photo("img-6", "Engine bay", 120),
    ],
    attributes: {
      "Pump Manufacturer": "Waterous",
      "Pump GPM": "1500",
      "Pump Hours": "1,240",
      "Tank Capacity (gal)": "750",
      Mileage: "58,300",
      Engine: "Cummins ISL 425",
      Transmission: "Allison EVS 3000",
    },
  },
  {
    id: "5f1c2a7e-0000-4000-8000-000000000002",
    secondaryId: 41903,
    listingTitle: "2014 E-One Typhoon Rescue Pumper",
    itemBrand: "E-One",
    processingStatus: "none",
    photos: [photo("img-7", "Front", 215), photo("img-8", "Driver side", 205)],
    attributes: { "Pump GPM": "1250", Mileage: "41,000" },
  },
  {
    id: "5f1c2a7e-0000-4000-8000-000000000003",
    secondaryId: 42017,
    listingTitle: "2006 Sutphen 75' Aerial",
    itemBrand: "Sutphen",
    processingStatus: "failed",
    photos: [photo("img-9", "Driver side", 200)],
    attributes: {},
  },
];

const assets: Listing3DAsset[] = [
  {
    id: "asset-41822-v1",
    listingId: listings[0].id,
    version: 1,
    representation: "illustrative",
    format: "procedural",
    storageKey: null,
    templateCategory: "pumper",
    sourceImageIds: ["img-1", "img-2", "img-4", "img-5"],
    sourceFingerprint: "fixture",
    pipelineVersion: "illustrative-template-0.1",
    processingStatus: "ready",
    reviewStatus: "approved",
    createdAt: "2026-09-20T00:00:00Z",
  },
  {
    id: "asset-42017-v1",
    listingId: listings[2].id,
    version: 1,
    representation: "reconstructed",
    format: "glb",
    storageKey: null,
    sourceImageIds: ["img-9"],
    sourceFingerprint: "fixture",
    pipelineVersion: "provider-tbd",
    processingStatus: "failed",
    reviewStatus: "pending",
    error: "Only one exterior photo available; reconstruction needs at least three sides.",
    createdAt: "2026-09-21T00:00:00Z",
  },
];

const seedTags: Listing3DTag[] = [
  { id: "t1", assetVersionId: "asset-41822-v1", label: "Cab", category: "Cab", position: [2.9, 1.9, 0], camera: { position: [7, 3, 6], target: [2.9, 1.7, 0] }, order: 0, evidence: { imageIds: ["img-1"], fields: ["Mileage"] } },
  { id: "t2", assetVersionId: "asset-41822-v1", label: "Pump Panel", category: "Pump Panel", position: [0.6, 1.6, 1.32], camera: { position: [2.5, 3, 9], target: [0.6, 1.4, 0] }, description: "Top-mount panel, driver side.", order: 1, evidence: { imageIds: ["img-3"], fields: ["Pump Manufacturer", "Pump GPM", "Pump Hours"] } },
  { id: "t3", assetVersionId: "asset-41822-v1", label: "Compartments", category: "Compartments", position: [-1.5, 1.5, 1.32], order: 2, evidence: { imageIds: ["img-2"], fields: [] } },
  { id: "t4", assetVersionId: "asset-41822-v1", label: "Engine", category: "Engine", position: [3.6, 1.2, 0], order: 3, evidence: { imageIds: ["img-6"], fields: ["Engine", "Transmission"] } },
  { id: "t5", assetVersionId: "asset-41822-v1", label: "Rear", category: "Rear", position: [-3.65, 1.4, 0], camera: { position: [-8, 2.5, 3], target: [-3.5, 1.4, 0] }, order: 4, evidence: { imageIds: ["img-5"], fields: ["Tank Capacity (gal)"] } },
];

const TAG_KEY = (v: string) => `gi.tags.${v}`;

// ponytail: localStorage persistence keyed by asset version; swap for the Garage oRPC client in Phase 2/3.
export const fixtureApi: ListingsApi = {
  async searchListings(query) {
    const q = query.trim().toLowerCase();
    return listings
      .filter((l) => !q || l.listingTitle.toLowerCase().includes(q) || String(l.secondaryId).includes(q))
      .map<ListingSummary>(({ id, secondaryId, listingTitle, processingStatus, photos }) => ({
        id,
        secondaryId,
        listingTitle,
        processingStatus,
        thumbnailUrl: photos[0]?.url,
      }));
  },
  async getListing(id) {
    const l = listings.find((x) => x.id === id);
    if (!l) throw new Error("Listing not found");
    return l;
  },
  async getCurrentAsset(listingId) {
    return assets.find((a) => a.listingId === listingId) ?? null;
  },
  async listAssets(listingId) {
    return assets.filter((a) => a.listingId === listingId).sort((a, b) => b.version - a.version);
  },
  async requestGeneration(listingId) {
    const l = listings.find((x) => x.id === listingId)!;
    const existing = assets.find((a) => a.listingId === listingId);
    // Retry must not duplicate a live job or overwrite an approved version.
    if (existing && (existing.processingStatus === "queued" || existing.processingStatus === "processing")) return existing;
    const version = existing ? existing.version + 1 : 1;
    const asset: Listing3DAsset = {
      id: `asset-${l.secondaryId}-v${version}`,
      listingId,
      version,
      representation: "reconstructed",
      format: "glb",
      storageKey: null,
      sourceImageIds: l.photos.map((p) => p.id),
      sourceFingerprint: l.photos.map((p) => p.id).join("|"),
      pipelineVersion: "provider-tbd",
      processingStatus: "queued",
      reviewStatus: "pending",
      createdAt: new Date().toISOString(),
    };
    if (existing && existing.reviewStatus === "approved") return existing; // keep approved model in the viewer; new job would run in background
    if (existing) assets.splice(assets.indexOf(existing), 1, asset);
    else assets.push(asset);
    l.processingStatus = "queued";
    return asset;
  },
  async listTags(assetVersionId) {
    const raw = localStorage.getItem(TAG_KEY(assetVersionId));
    const tags: Listing3DTag[] = raw ? JSON.parse(raw) : seedTags;
    return forAssetVersion(tags, assetVersionId);
  },
  async saveTags(assetVersionId, tags) {
    localStorage.setItem(TAG_KEY(assetVersionId), JSON.stringify(forAssetVersion(tags, assetVersionId)));
  },
};
