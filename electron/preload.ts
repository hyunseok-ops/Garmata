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
  requestGeneration: call("assets.generate"),
  reviewAsset: call("assets.review"),
  listTags: call("tags.list"),
  saveTags: call("tags.save"),
});
