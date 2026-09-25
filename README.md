# Garage Intelligence

Desktop app (Electron + React + Three.js) with a persistent sidebar for Garage tools. First feature: **3D Listings**, a vehicle viewer with clickable part tags that open the listing's photos and specs.

Plan: [docs/PLAN.md](docs/PLAN.md).

## Run

```sh
npm install
npm run dev        # Electron shell + Vite
npm run dev:web    # viewer in a plain browser (core logic must not need the desktop shell)
npm test           # tag-binding self-check (node --test, no framework)
npm run build      # typecheck + renderer/main bundles
```

## Status against the plan

| Phase | State |
| --- | --- |
| 0 Reconstruction evaluation | Not started. Manual experiment; no code. Provider unselected. |
| 1 Desktop shell + viewer | Done. Sidebar, listing browser, orbit/zoom/pan, Front/Rear/Left/Right/Reset, anchored tags that fade when occluded, inspection panel. |
| 2 Garage integration | Not started. `ListingsApi` in `src/data/types.ts` is the seam; `src/data/fixtures.ts` is the only implementation. Field names follow `Listing`, `ListingImage`, `ListingAttribute` in the Garage Prisma schema. Auth is absent; the app has no sign-in. |
| 3 Tag editor | Done against fixtures. Click-to-place in model-local coords, label/category/description, photo + field evidence, saved camera pose, delete. Tags persist per asset version in `localStorage`. |
| 4 Generation + review | Stubbed. `requestGeneration` creates a queued version and refuses to duplicate a live job or replace an approved one. No worker, storage, or reviewer UI. |
| 5 Pilot packaging | Not started. No electron-builder config. |

## Layout

```
electron/   main + preload (isolated renderer, narrow bridge, external links denied)
src/data/   types (plan §9), pure tag ops + test, fixture ListingsApi
src/viewer/ Canvas, presets, camera rig, tag markers, GLB loader w/ size/type gate, procedural illustrative pumper
src/App.tsx sidebar, browser, viewer header, inspection panel, tag editor
```

The only 3D fixture is a procedural pumper labelled **Illustrative model**. No licensed GLB template is included; `Viewer` loads `.glb` when an asset has a `storageKey`.
