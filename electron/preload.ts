import { contextBridge } from "electron";

// Narrow desktop bridge. Add methods here only when a feature needs the OS.
contextBridge.exposeInMainWorld("garageDesktop", { platform: process.platform });
