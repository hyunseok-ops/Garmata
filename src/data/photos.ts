import type { ListingPhoto, TagCategory } from "./types.ts";

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

// Listing originals are up to 8K / 30 MB. Decoding one on the UI thread stalls the viewer for ~1 s, so every on-screen
// image uses a sized rendition from Supabase's image transformer; <Img> falls back to the original if that fails.
export function thumbUrl(url: string, width: number): string {
  return url.includes("/storage/v1/object/public/")
    ? url.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") + `?width=${width}&quality=75`
    : url;
}
