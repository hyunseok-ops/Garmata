import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

// `--mode web` runs the viewer in a plain browser; core interaction logic must not need the desktop shell.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === "web"
      ? []
      : [
          electron({
            main: { entry: "electron/main.ts" },
            preload: { input: "electron/preload.ts" },
          }),
        ]),
  ],
  build: { outDir: "dist" },
}));
