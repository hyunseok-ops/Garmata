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

## Splat pilot (docs/PLAN-SPLAT.md)

Photo-real path: Nerfstudio Splatfacto on Modal, rendered in the viewer with Spark (MIT). `pipeline/splat_modal.py` runs `ns-process-data` + `ns-train splatfacto` + `ns-export gaussian-splat` on an A10G against the `gi-splats` Volume.

```sh
uvx modal run --detach pipeline/splat_modal.py --job <job> --urls pipeline/inputs/<listing>.json   # sparse-photo baseline
uvx modal volume put gi-splats walkaround.mp4 /jobs/<job>/source.mp4                              # guided capture (Phase 0)
uvx modal run --detach pipeline/splat_modal.py --job <job> --video
uvx modal volume get gi-splats /jobs/<job>/export/splat.ply ./splat.ply
GI_IMPORT=<listingId>,./splat.ply,splatfacto-1.1.5 npx electron dist-electron/main.js              # register as a pending asset version
```

Status (2026-09-25): sparse-photo baseline on the 2009 Pierce Velocity (74 listing photos, exhaustive matching) aligned **2 of 74** frames; job cancelled before training. Pipeline then proven end to end on the Tanks & Temples "truck" walkaround (`--job sample-truck`, 251 posed frames): 15k Splatfacto iterations in ~6 min on an A10G, 142 MB `.ply`, loads and orbits in the app (imported as an illustrative asset on listing 226894 with a stored `transform`). Listing photos are scattered viewpoints, mixed focal lengths and close-ups, so COLMAP cannot chain them. This is the outcome the plan's decision gate anticipated: the next input must be a guided walkaround video (Phase 0), uploaded to the volume and run with `--video`. Tag occlusion does not work against splats (no mesh); proxy mesh is the planned fix.

Operational notes: image build is cached after the first deploy; run jobs via `modal deploy` + spawn (the `--wait` flow above) because `modal run` ties the job to the client connection, and this laptop's Wi-Fi drops long-lived streams (a phone hotspot held).

## Layout

```
electron/   main + preload (isolated renderer, narrow bridge, external links denied)
src/data/   types (plan §9), pure tag ops + test, fixture ListingsApi
src/viewer/ Canvas, presets, camera rig, tag markers, GLB loader w/ size/type gate, procedural illustrative pumper
src/App.tsx sidebar, browser, viewer header, inspection panel, tag editor
```

The only 3D fixture is a procedural pumper labelled **Illustrative model**. No licensed GLB template is included; `Viewer` loads `.glb` when an asset has a `storageKey`.
