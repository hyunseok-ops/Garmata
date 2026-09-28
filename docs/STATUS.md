# Garage Intelligence — Development Status

Date: 2026-09-27. Plan: docs/PLAN.md (novel-view 360). Latest commit on main.

## Current direction: Photo Spin
The priority moved from a free-orbit Gaussian splat to a **photo spin**: a smooth 360° turntable of images with the real
background, where every angle the listing actually photographed shows that photo unmodified, and AI fills the angles in between.
The splat pipeline still exists (v10 is the best splat) but is not the product path right now.

Pilot: 2009 Pierce Velocity Pumper (#226894). Best version: **v15** (Versions tab). Preview video: `~/Desktop/pierce-velocity-spin-v15.mp4`.

## How a spin is built
1. **Pick and place real photos** (`azimuths.json` in `experiments/novel-view/<listingId>/`). Listing labels are unreliable
   (front-3/4 shots labelled "front", rear-3/4 labelled "side", no left/right), so photos are pinned to ring angles: automatically by
   matching each photo to an earlier lap (truck-only SIFT, mirrored for the side the lap never saw), by eye where that fails.
2. **Generate a 48-view lap** (7.5° steps, 1024×768) with Stable Virtual Camera on Modal H100, conditioned on the pinned photos,
   backgrounds kept. Inputs are pose-normalised (camera moved along its ray so the truck size matches the ring) instead of shrunk.
   16 inputs uses SEVA's orbit prior + nearest-gt chunking (its plain path crashes at ≥9 inputs). ~20 min per run.
3. **Assemble the spin** (`pipeline/spin_build.py`, `GI_SPIN_BUILD`): real photos are placed at their angles as plain crops (never
   composited); generated frames zoom to meet their framing; a size check drops real frames whose truck is >12% off its neighbours;
   frames flagged in `spinReplace` are replaced by an optical-flow midpoint; RIFE adds 3 in-betweens per gap → 192 frames.
4. **Viewer** (`src/viewer/SpinViewer.tsx`): drag with momentum, trackpad/wheel, arrow keys, presets, real/AI badge, projected tags.
   Key frames stay decoded; in-betweens decode off-thread in a window around the current angle (~70 of 192 in memory).
   120 fps while scrolling (p95 ≈ 9.8 ms).

## What's weak (from a slow manual scroll through v15, screenshot every 3.75°)
**The truck in AI angles**
- **Driver-side front, ~0–60°** is the weakest stretch: the listing has no photo between 37.5° and 82.5° on that side.
  - 4–26°: the far side of the body ghosts (a doubled outline behind the truck).
  - 41°: cab front smeared.
  - 56–64°: the cab is a smeared blur. 60° itself was AI-broken (doubled wheels) and is an optical-flow blend.
- **Rear, 184–206°**: a brown smear band in the background behind the truck; at 195–206° the truck looks stretched, cab and rear
  both visible, with doubled rear wheels at 206°.
- **Small ghost wheels / smudges** under the body at 150–165°, 236–247°.
- **Trees at the top of the frame** smear in several places (26°, 60–75°, 116°, 146°).

**Framing**
- **Zoom pulses** around the real-photo cluster (300–341°). Real frames at 307.5°, 315°, 330° have their own framing, and the AI frames
  between them zoom in and out to meet them, so the truck breathes in size.
- **Truck is cropped** at the right edge from ~285° to ~341° (rear of the body cut off) because of that zoom.
- **Jumps** at 247→251° and 266→270° (truck position/size shift).
- **Truck grows toward the front** (0–30° framed tighter than 352°).

**Tags (template positions, not per truck)**
- **Wrong spots.** "Pump Panel" sits on the cab front at 319–0°; the pump panel is on the side. "Engine" and "Rear" float in empty
  space beside the truck (e.g. Engine left of the cab at 270–311°, Rear right of the truck at 210–251°) and get clipped at the edges.
- **Overlap.** "Rear" and "Compartments" overlap at 184–206°.

**App / UX**
- **Stuck "Generating" state.** Dashboard shows a paused job as "Generating intermediate views" forever, with an internal file path as
  its message. The listing header shows the same and a disabled "Generating..." button, so a new generation can't be started from
  the app.
- **Indistinguishable cards.** "Ready for review" has four identical "Novel View Splat" cards plus a pipeline test; spin cards have no
  listing number and no thumbnail, and nothing says v15 is the good one.
- **Wasted space.** The spin uses about half the viewport height; dark bands above and below.
- **Blank thumbnail.** The listing thumbnail in the 3D Listings list is empty.
- **Only 8 real photos** in the spin (of 16 inputs): the size check dropped 3 and 5 close-ups need too much zoom.

**Process**
- **Per-listing hand work.** Photo angles needed manual fixes (one photo was on the wrong side). Each listing needs a review pass.
- **Silent drift.** Registration against an AI lap is circular: where the lap is wrong, photos don't match it.

## Next steps (suggested order)
1. **Real camera poses** from structure-from-motion on the listing's exterior photos (parking-lot texture should work). This
   replaces label guesses and eyeballing, fixes side mix-ups, and gives SEVA true distances/heights: the biggest quality lever.
2. **Tags** placed per truck (click-to-place in the spin, or project from the pose model) instead of the pumper template.
3. **Framing pass**: normalise truck height per frame from the matte, so real and AI frames share one scale and nothing is cropped.
4. **UX fixes**: close paused jobs, card thumbnails + version labels, fill the viewport.
5. **Photo capture guidance** for sellers: two driver-side 3/4 shots would remove the weakest stretch outright.

## Known limits
- SEVA license is non-commercial (fine for this experiment). Weights via Modal secret `gi-huggingface`; deploy with `GI_HF_SECRET=gi-huggingface`.
- RIFE (frame interpolation) runs locally from `~/.cache/gi/rife-ncnn-vulkan-20221029-macos`; without it the spin has 48 frames.
- A React "removeChild" console error appears on every app run (pre-existing, not from the spin).

## Earlier status (mesh era, kept for history)

**Desktop app (macOS, Electron)**
- Sidebar (3D Listings, Settings), listing browser searching live Garage listings by title or number, viewer with orbit/zoom/pan, Front/Rear/Left/Right/Reset presets, inspection panel with the listing's real photos (labelled by view: front, front 3/4, side, rear 3/4, rear, pump panel, compartment, engine bay, wheels, cab interior, dash, module interior) and specs.
- 3D orbit tab and Versions tab per listing. Every generated version is listed with pipeline, status, review state; view / approve / reject from the list. Approved version shows by default; others only in editor mode.
- Tag editor: click-to-place tags in model-local coordinates, label/category/description, linked photos and spec fields as evidence, saved camera pose per tag, delete. Tags are bound to one asset version. Tags fade when occluded by the mesh.
- Angle-matched real photo: while orbiting, the listing photo taken from the current viewing direction is shown in a corner panel and updates live (click to cycle). This is how "realistic" and "free orbit" coexist with sparse photos.
- Template tag seeding by vehicle type (pumper, aerial, ambulance): Cab, Pump Panel/Patient Module, Compartments, Engine, Wheels/Tires, Rear (+ Aerial), each linked to photos by view label and to specs by field name. Only tags with evidence are created.
- Packaging: `npm run dist` → unsigned arm64 `.dmg`/`.zip` in `release/`. Packaged app reads `.env` from `~/Library/Application Support/garage-intelligence/.env`.
- Headless modes (used for automation): `GI_GENERATE=<listingIds>`, `GI_SEED_TAGS=approved|<assetIds>`, `GI_IMPORT=<listingId>,<file>,<pipeline>[,illustrative]`, `GI_SYNC=all|<assetIds>`, `GI_SMOKE_OUT=<dir>` (screenshots).

**Data connection**
- Reads: Electron main process queries Garage Postgres read-only (`GARAGE_DATABASE_URL`): `Listing`, `ListingImage` (+ `Media`, view labels), `ListingAttribute`/`Attribute`. Photos are served from Supabase public URLs. Originals are 8K/30 MB, so generation inputs are resized to 1600 px in the main process.
- Local store: assets and tags live in `~/Library/Application Support/garage-intelligence/3d/` (JSON + model files) and are served to the renderer over a custom `gi-asset://` protocol. Renderer is sandboxed; no credentials reach it.

**3D generation — generative tier (working)**
- Provider: Meshy multi-image-to-3D, Ultra tier (2k geometry, 4k PBR textures), 4 labelled exterior photos per job (front 3/4, side, rear 3/4, rear). Jobs are versioned (never overwrite), retries don't duplicate live jobs, pending jobs resume after restart.
- Results: 13 active listings generated, reviewed, approved, and tagged: 2009 Pierce Velocity Pumper, 2018 Pierce Dash CF Pumper, 1994 Saulsbury Pumper Tanker, 2007 Pierce Dash Pumper, 2002 E-One Cyclone 100' Quint, 2008 LifeLine Type III, and seven Type I ambulances (Horton, Braun, Frazer, REV). Quality: paint schemes, stripes, lettering, pump panels, aerial ladders match the photos on photographed sides; unseen surfaces are the generator's guess. Cost ≈ 60 Meshy credits per Ultra model; default tier ≈ 30.
- Meshy models face −X; the viewer stores a per-asset transform (yaw 180°) so presets face the cab.

**3D reconstruction — photo-real tier (pipeline works, input does not)**
- Pipeline: `pipeline/splat_modal.py` runs Nerfstudio (COLMAP or hloc DISK+LightGlue matching → Splatfacto → `.ply` export) on Modal (A10G or H100), volume `gi-splats`, deployed app `garage-intelligence-splat`. Launch with `modal deploy` then spawn (detached), because `modal run` dies with the laptop's connection. Image pinned to nerfstudio 1.1.5 with pycolmap 0.4.0 and LightGlue.
- Proven on a proper walkaround (Tanks & Temples "truck", 251 posed frames): ~6 min on A10G, 142 MB splat, renders and orbits in the app via Spark (MIT). Viewer supports `.ply/.spz/.splat` with a stored per-asset transform (scale/position/rotation).
- Real listings tested: Pierce Velocity 74 photos → 2 aligned (SIFT); Lance Heavy Rescue 31 → 10 (LightGlue); Velocity Quint 35 → 22 (LightGlue), trained on H100, output fragmented and unusable. Conclusion: listing galleries lack photo-to-photo overlap. Faithful reconstruction requires continuous capture: a 2–3 min walkaround video or 80–150 photos a step apart (guided apps like Scaniverse/Polycam/Luma produce this directly and export formats the viewer already loads).
- Alignment gate: fewer than 15 aligned frames → job stops before training.

**Garage backend integration (built, not merged, not fully tested)**
- Branch `hyunseok/garage-intelligence-3d` in the Garage monorepo (worktree `../garage-3d`, local commit only; repo rules forbid pushing/PRs without explicit ask).
- Prisma models `Listing3DAsset` (versioned, representation, format, storageKey, transform, source fingerprint, pipeline, processing/review status, reviewer) and `Listing3DTag`; migration applied to the local dev DB.
- Admin oRPC routes `admin.listings3d.{listAssets, createAsset, updateAsset, reviewAsset, listTags, saveTags}`; files via signed upload/download URLs to a private Supabase bucket `listing-3d`.
- Local backend boots (needs placeholder env for two unrelated Microsoft ads keys missing from the dev Infisical env); routes mount and return 401 without auth.
- Desktop write-through: with `GARAGE_API_URL` + `GARAGE_API_KEY` (Clerk admin API key `ak_…`) set, approvals and tag saves push to Garage; `GI_SYNC=all` pushes everything. Untested end to end: needs a real admin API key and the bucket created.

## 2. Key decisions made
1. Two tiers: generative (Meshy) for every listing with ≥3 labelled exterior photos; photo-real splat only where a walkaround capture exists. Both labelled honestly in the UI; real photos always one click away.
2. Sparse-photo reconstruction is not pursued further (three real-listing attempts failed the decision gate).
3. Tags are manual/template-seeded, evidence-gated, bound to asset versions (plan §8).
4. Auth for the desktop tool = Clerk admin API key against existing admin oRPC auth; no custom sign-in.
5. Long-running cloud jobs must survive client disconnects (this laptop's Wi-Fi drops minutes-long streams).

## 3. Open items / needs owner action
- Create a Clerk admin API key and set `GARAGE_API_URL`/`GARAGE_API_KEY`; run the first `GI_SYNC=all`.
- Create the `listing-3d` Supabase bucket in the target environment (dev key is a placeholder).
- Push the Garage branch and open a PR when ready (not done, by rule).
- Rotate the Meshy API key (it was pasted in chat).
- Capture one walkaround of a real vehicle to exercise the photo-real tier; decide capture workflow (seller app vs intake team checklist).
- Tag positions on the 10 new listings came from templates; a quick drag-to-adjust pass per truck is expected.

## 4. Not built / deferred
- Per-user roles beyond "admin API key"; audit of who approved what beyond `reviewedById`.
- Automatic tag suggestion, proxy-mesh occlusion for splats, embedding the viewer in the public listing page, auto-update/code signing for the desktop build, Windows build.
- Open-source generator on Modal (Hunyuan3D/TRELLIS) as a Meshy alternative — evaluated as an option, not implemented.
- Splat cropping to the vehicle (Nerfstudio OBB export) — not needed until a real capture exists.

## 5. Costs and timings observed
- Meshy Ultra: ~10–20 min per model, ~60 credits. Default tier: ~5–10 min, ~30 credits.
- Modal: Nerfstudio image build ~15 min once (cached after); Splatfacto 15k iterations ≈ 6 min A10G / ≈ 4 min H100 on ~250 frames; alignment 1–2 min for 30–75 photos.
- Supabase image transform has a 25 MB source limit; local resize in Electron (nativeImage) is used instead.
