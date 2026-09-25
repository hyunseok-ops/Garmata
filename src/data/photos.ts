import type { ListingPhoto, TagCategory } from "./types.ts";

// ListingImageViewLabel values from the Garage schema.
const GENERATION_VIEWS = ["front_34", "side", "rear_34", "rear", "front"];

// Up to 4 exterior photos, one per view, most-distinct views first. Interior/detail shots would only confuse reconstruction.
export function pickGenerationPhotos(photos: ListingPhoto[]): ListingPhoto[] {
  const picked: ListingPhoto[] = [];
  for (const view of GENERATION_VIEWS) {
    const p = photos.find((x) => x.viewLabel === view && !picked.includes(x));
    if (p) picked.push(p);
    if (picked.length === 4) break;
  }
  if (picked.length === 0 && photos.length) picked.push(...photos.filter((p) => !p.viewLabel).slice(0, 4));
  return picked;
}

export const CATEGORY_VIEWS: Record<TagCategory, string[]> = {
  Cab: ["cab_interior", "dash", "front"],
  "Pump Panel": ["pump_panel"],
  Compartments: ["compartment"],
  Engine: ["engine_bay"],
  "Wheels/Tires": ["wheel_tire", "undercarriage"],
  Rear: ["rear", "rear_34"],
  Other: [],
};

export const VIEW_LABELS: Record<string, string> = {
  front: "Front", front_34: "Front 3/4", side: "Side", rear: "Rear", rear_34: "Rear 3/4", pump_panel: "Pump panel", compartment: "Compartment",
  engine_bay: "Engine bay", wheel_tire: "Wheels/tires", cab_interior: "Cab interior", dash: "Dash", module_interior: "Module interior",
  undercarriage: "Undercarriage", document: "Document", other: "Other",
};
