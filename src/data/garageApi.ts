import type { ListingsApi } from "./types.ts";

import type { Generation, SplatPipeline } from "./types.ts";

export type Bridge = ListingsApi & {
  platform: string;
  status(): Promise<{ garage: boolean; sync?: boolean }>;
  reviewAsset(id: string, s: "approved" | "rejected"): Promise<unknown>;
  listGenerations(): Promise<Generation[]>;
  listPending(): Promise<import("./types.ts").Listing3DAsset[]>;
  startGeneration(listingId: string, pipeline?: SplatPipeline): Promise<Generation>;
  retryGeneration(id: string): Promise<Generation>;
  ringFrame(azimuth: number, dataUrl: string): void;
  ringDone(error?: string): void;
};
export const desktop = (window as unknown as { garageDesktop?: Bridge }).garageDesktop;
