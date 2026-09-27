import { contextBridge, ipcRenderer } from "electron";

// Narrow desktop bridge: renderer sees these calls only, never the DB or provider credentials.
const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld("garageDesktop", {
  platform: process.platform,
  status: call("status"),
  searchListings: call("listings.search"),
  getListing: call("listings.get"),
  getCurrentAsset: call("assets.current"),
  listAssets: call("assets.list"),
  listGenerations: call("generations.list"),
  listPending: call("assets.pending"),
  startGeneration: call("generations.start"),
  retryGeneration: call("generations.retry"),
  // Hidden ring-render window (posed-test) streams frames back to the main process.
  ringFrame: (azimuth: number, dataUrl: string) => ipcRenderer.send("ring.frame", azimuth, dataUrl),
  ringDone: (error?: string) => ipcRenderer.send("ring.done", error),
  reviewAsset: call("assets.review"),
  listTags: call("tags.list"),
  saveTags: call("tags.save"),
});
