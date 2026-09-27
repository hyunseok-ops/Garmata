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

## MVP (docs/PLAN.md, 2026-09-27)

Goal: turn a listing's sparse exterior photos into a navigable 360 Gaussian splat, with the real photos kept as evidence.
Meshy/mesh generation is removed; existing mesh versions remain viewable as "Legacy Mesh".

Pipeline (`electron/novel.ts`, dashboard "Generate 360" or headless):

| Step | Where | What |
| --- | --- | --- |
| Prep `GI_NOVEL_PREP=<listingId>` | local | One photo per exterior label, resized/cropped, facing detected (`pipeline/facing.py`), 24-slot ring planned, `transforms.json` + manifest written to `experiments/novel-view/<id>/` |
| Views `GI_NOVEL_GENERATE=<id>` | Modal H100 | Stable Virtual Camera renders the 19 missing ring angles from the real photos at the exact planned cameras, then rembg mattes every frame (`pipeline/novel_view_modal.py`); pauses for inspection |
| Splat `GI_NOVEL_SPLAT=<id>` | Modal A10G | Posed-images mode: validate frames/matrices/sizes/order, Splatfacto 7k iterations, no feature matching (`pipeline/splat_modal.py`); prune floaters on import |
| All `GI_GENERATE=<id>` | both | The three steps in one run |
| Test `GI_NOVEL_RENDER_TEST=<id>` | both | Renders an existing model from the ring cameras instead of SEVA, to verify poses → Splatfacto → viewer |

Progress is real stage data (Modal Dict `gi-progress`), persisted per generation, resumed after restarts.
Per-listing overrides: `experiments/novel-view/<id>/azimuths.json`, e.g. `{"front_34": 315}` when facing detection is wrong.

**Blocker:** SEVA weights are gated. The Hugging Face account behind the Modal `huggingface` secret must accept the Stability AI
Non-Commercial License at https://huggingface.co/stabilityai/stable-virtual-camera (check with `uvx --from modal==1.5.5 python pipeline/gi.py check`).

## Layout

```
electron/   main + preload (isolated renderer, narrow bridge, external links denied)
src/data/   types (plan §9), pure tag ops + test, fixture ListingsApi
src/viewer/ Canvas, presets, camera rig, tag markers, GLB loader w/ size/type gate, procedural illustrative pumper
src/App.tsx sidebar, browser, viewer header, inspection panel, tag editor
```

The only 3D fixture is a procedural pumper labelled **Illustrative model**. No licensed GLB template is included; `Viewer` loads `.glb` when an asset has a `storageKey`.
