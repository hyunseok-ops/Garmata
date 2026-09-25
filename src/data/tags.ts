import type { Listing3DTag, TagCategory, Vec3 } from "./types.ts";

// Pure tag-list operations. Persistence lives in the ListingsApi implementation.

export function addTag(tags: Listing3DTag[], assetVersionId: string, position: Vec3, category: TagCategory = "Other"): Listing3DTag[] {
  const tag: Listing3DTag = {
    id: crypto.randomUUID(),
    assetVersionId,
    label: `New ${category}`,
    category,
    position: position.map((n) => Math.round(n * 1000) / 1000) as Vec3,
    order: tags.length,
    evidence: { imageIds: [], fields: [] },
  };
  return [...tags, tag];
}

export function updateTag(tags: Listing3DTag[], id: string, patch: Partial<Listing3DTag>): Listing3DTag[] {
  return tags.map((t) => (t.id === id ? { ...t, ...patch, id: t.id, assetVersionId: t.assetVersionId } : t));
}

export function deleteTag(tags: Listing3DTag[], id: string): Listing3DTag[] {
  return tags.filter((t) => t.id !== id).map((t, i) => ({ ...t, order: i }));
}

// Tags are bound to one asset version; anything else is a bug upstream and must not render.
export function forAssetVersion(tags: Listing3DTag[], assetVersionId: string): Listing3DTag[] {
  return tags.filter((t) => t.assetVersionId === assetVersionId).sort((a, b) => a.order - b.order);
}
