# Garage Intelligence — Development Status

Date: 2026-09-27 (plan v2: docs/PLAN.md; the mesh-era plan is archived as docs/PLAN-v1-mesh.md)

## Where the MVP stands

| Phase (plan §40) | State |
| --- | --- |
| 1 Simplify UI | Done. Dashboard home (Active Generations, Ready for Review, Recent Listings), 360 View / Photos / Versions tabs, pipeline labels (Novel View Splat, Capture Splat, Pipeline Test, Legacy Mesh). Meshy generation removed. |
| 2 Dataset prep | Done. `GI_NOVEL_PREP`: one photo per exterior label, resize/crop, facing detection (SIFT, conservative) + `azimuths.json` override, 24-slot ring, manifest. Verified on three pumpers. |
| 3 Novel views | Built and deployed (Stable Virtual Camera on Modal H100 + rembg matting). **Blocked: model license not accepted** on the Hugging Face account behind the Modal secret. |
| 4 Pose generator | Done and tested (`src/data/novel.ts`). OpenGL cameras, front +X, driver side +Z, shared by SEVA, Splatfacto and three.js. |
| 5 Posed Splatfacto | Done. Posed-images mode with validation (frames, 4x4 matrices, sizes, ordering), no feature matching, 7k iterations, floater pruning on import. |
| 6 Viewer integration | Verified with a pipeline test (existing model rendered from the ring cameras → splat): orientation, scale, all presets, real-photo matching correct. 95–120 fps while orbiting. |
| 7 Dashboard progress | Done. Real stages from Modal (`gi-progress` Dict), iteration progress bar, step checklist, retry, resume after restart. |
| 8 Evaluation | Not started: needs Phase 3 output on a real listing. |

## To unblock
Accept the Stability AI Non-Commercial License at https://huggingface.co/stabilityai/stable-virtual-camera with the account behind
Modal's `huggingface` secret (currently a teammate's account), or put your own token in that secret. Then Retry the Pierce Velocity
card on the dashboard (scene already uploaded). Check access: `uvx --from modal==1.5.5 python pipeline/gi.py check`.
Note the license is non-commercial: fine for the MVP experiment; production use needs a commercial license or another model.

## Known limits
- Facing detection answers "unknown" when photos don't share enough features; unknowns follow the majority. A vision-model check is the robust fix.
- Real photos are assumed to share one camera distance, height and FOV.
- Deferred per plan §39: Garage backend branch (built earlier, local only), Clerk keys, Supabase bucket, packaging polish.

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
