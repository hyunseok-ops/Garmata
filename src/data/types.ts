// Mirrors plan §9. Field names follow garage/backend/prisma/schema.prisma where a counterpart exists.

export type ProcessingStatus = "none" | "queued" | "processing" | "ready" | "failed";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type Representation = "reconstructed" | "illustrative";

export type ListingPhoto = {
  id: string; // ListingImage.id
  url: string;
  viewLabel?: string; // ListingImage.viewLabel
};

export type ListingSummary = {
  id: string; // Listing.id (uuid)
  secondaryId: number; // Listing.secondaryId, the human-facing listing number
  listingTitle: string;
  thumbnailUrl?: string;
  processingStatus: ProcessingStatus;
};

export type ListingDetail = ListingSummary & {
  itemBrand?: string;
  listingDescription?: string;
  photos: ListingPhoto[];
  // ListingAttribute rows flattened: attribute name -> value. Missing = unknown, never inferred.
  attributes: Record<string, string>;
};

export type Listing3DAsset = {
  id: string;
  listingId: string;
  version: number;
  representation: Representation;
  format: "glb" | "splat" | "procedural"; // splat = Gaussian splat .ply/.spz (photo-derived appearance, not a mesh)
  storageKey: string | null; // asset URL/key; null for the procedural illustrative model
  // Reviewed normalization into the viewer frame (y-up, ~8 units long, resting on y=0). Splats need it; meshes auto-fit.
  transform?: { scale: number; position: Vec3; rotationDeg: Vec3 };
  templateCategory?: "pumper" | "aerial" | "tanker" | "ambulance";
  sourceImageIds: string[];
  sourceFingerprint: string;
  pipelineVersion: string;
  processingStatus: ProcessingStatus;
  reviewStatus: ReviewStatus;
  error?: string;
  createdAt: string;
};

export const TAG_CATEGORIES = ["Cab", "Pump Panel", "Compartments", "Engine", "Wheels/Tires", "Rear", "Other"] as const;
export type TagCategory = (typeof TAG_CATEGORIES)[number];

export type Vec3 = [number, number, number];

export type Listing3DTag = {
  id: string;
  assetVersionId: string;
  label: string;
  category: TagCategory;
  position: Vec3; // model-local coordinates
  camera?: { position: Vec3; target: Vec3 };
  description?: string;
  order: number;
  evidence: { imageIds: string[]; fields: string[] };
};

export interface ListingsApi {
  searchListings(query: string): Promise<ListingSummary[]>;
  getListing(id: string): Promise<ListingDetail>;
  getCurrentAsset(listingId: string): Promise<Listing3DAsset | null>;
  listAssets(listingId: string): Promise<Listing3DAsset[]>; // every version, newest first
  requestGeneration(listingId: string): Promise<Listing3DAsset>;
  listTags(assetVersionId: string): Promise<Listing3DTag[]>;
  saveTags(assetVersionId: string, tags: Listing3DTag[]): Promise<void>;
}
