import type { ListingsApi } from "./types.ts";

export type Bridge = ListingsApi & { platform: string; status(): Promise<{ garage: boolean; provider: boolean }>; reviewAsset(id: string, s: "approved" | "rejected"): Promise<unknown> };
export const desktop = (window as unknown as { garageDesktop?: Bridge }).garageDesktop;
