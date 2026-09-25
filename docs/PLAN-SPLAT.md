# Garage Intelligence: Modal + Nerfstudio Pilot

Date: September 25, 2026  
Scope: Test a photo-real, navigable representation of one actual Garage vehicle, then decide whether the method can support 3D Listings.

## Goal

Make a viewer that feels like exploring **the photographed vehicle**, including its real paint, markings, equipment, and visible wear. A user can move the camera around the truck and select anchored tags to view original photos and listing facts. The representation does not need movable equipment or an editable game-style mesh.

Use **Nerfstudio's Splatfacto** as the initial Gaussian splatting implementation and **Modal** as the GPU execution environment. These are candidate tools for a pilot, not a claim that ordinary listing photos will reconstruct reliably. Nerfstudio is open source; Garage's Modal credits can pay for the GPU experiment until exhausted.

## Critical distinction

Splatfacto produces a Gaussian splat, which is a photo-derived 3D appearance representation. It is **not a GLB vehicle mesh**. Plan for a splat-capable viewer and export the trained splat as `.ply` for the prototype. Do not assume that an existing Three.js GLB loader can display it or that parts are independently selectable. Tags are separate data anchored in the same scene coordinate system. A simple proxy mesh or manually positioned 3D points may be useful for placement and depth ordering.

## Phase 0: Obtain a suitable capture

Start with one truck that Garage is allowed to photograph and process. Record a slow, steady walkaround covering front, front corners, both sides, rear corners, and rear. Include a second pass at a higher angle where safe and practical; capture close-up listing photos separately for tags. Keep the truck still, maintain plenty of overlap between consecutive frames, avoid abrupt camera movements, and try to keep people and moving traffic out of the scene.

Collect the original video, source listing ID, basic dimensions if available, and a small set of reference photos for visual review. Use consistent lighting. The pilot can also test an existing listing's photos, but treat that as a separate **sparse-photo baseline**. Success with a guided walkaround does not prove that a typical listing's scattered images will work.

## Phase 1: Run a one-vehicle local workflow on Modal

1. Create a pinned Modal image with Nerfstudio, CUDA/PyTorch dependencies, FFmpeg, and COLMAP. Use Nerfstudio's installation or container guidance as a starting point, but verify that dependency versions and GPU drivers work together in Modal.
2. Upload or mount the source video in an isolated pilot input location. Do not include the video bytes in a function argument or bake listing media into a container image.
3. Run `ns-process-data video --data <video-path> --output-dir <processed-path>` to extract frames and estimate camera poses. Inspect the processing report and aligned cameras before training.
4. Run `ns-train splatfacto --data <processed-path>` on a single suitable NVIDIA GPU. Begin with the default model; size the GPU after measuring actual memory use rather than assuming a specific GPU is sufficient.
5. Save the training checkpoint, metadata, logs, and an exported splat using `ns-export gaussian-splat --load-config <config-path> --output-dir <export-path>`.
6. Copy the reviewed output to Garage-controlled asset storage. A Modal Volume can hold checkpoints and intermediate data, but the app needs a stable final asset location and a recorded asset version.

The initial run can be launched manually with `modal run`. Only after it works should Garage build an asynchronous job API. Modal's `.spawn()` pattern can then start a GPU job and return a job ID immediately. Keep the user-facing job state in Garage's database; do not rely on Modal's transient result retention as the permanent record.

## Phase 2: Inspect and score the result

View the splat from the same directions as the capture and from intermediate viewpoints. Compare it with original photos rather than assessing only the most flattering view.

| Check | What to record |
| --- | --- |
| Identity | Paint scheme, lettering, cab, body type, axle count, unique equipment |
| Coverage | Front, sides, rear, roof where captured; holes on unseen surfaces |
| Geometry | Distorted wheels, warped edges, floating artifacts, incorrect scale |
| Navigation | Whether users can smoothly move around the truck without revealing severe artifacts |
| Operations | Input size, alignment success, GPU type, processing time, total cost, output size |

Set a review outcome of **acceptable**, **needs recapture**, or **unsuitable**. Any measurements or condition claims must continue to come from listing evidence, not the splat.

## Phase 3: Minimal Garage Intelligence viewer

Implement the first screen in the Electron/React shell described in the broader Garage Intelligence plan. Keep the splat viewer as a reusable React component if feasible. Verify a candidate renderer's license, supported splat format, file size limits, and interaction support before choosing it.

For the pilot, the user can rotate/orbit, zoom, pan, reset the camera, and choose front/side/rear views. Load one reviewed truck from storage. Add manually placed markers for a few actual features, such as Cab, Pump Panel, and Rear Compartments. Clicking a marker opens the relevant original listing photo and known specifications in a side panel.

Store markers in the exported scene's coordinates, together with the exact asset version and optional camera target. If a new reconstruction changes the coordinate frame, the tags need remapping or re-review. A splat is primarily a rendering representation; marker selection and occlusion need an explicit solution in the viewer.

## Phase 4: Connect a generation job to Garage

When the manual run and viewer are satisfactory:

- Authorize a user to request generation for a listing.
- Store a job with listing ID, source media fingerprint, capture type, pipeline version, state, cost, and output asset version.
- Start the Modal job in the background and display queued, processing, review, ready, and failed states.
- Return a stable asset reference; never expose Modal credentials in Electron.
- Have a reviewer compare the output to the listing before making it the current approved view.
- Retain the previous approved version when a retry fails or a new generation needs review.
- Restrict access to source media, generated assets, and linked tag photos using Garage's existing permissions.

Garage's TypeScript backend can call a narrow Python service or endpoint around the Modal job. The exact bridge should follow existing Garage integration conventions after inspecting the repository; Nerfstudio's processing itself remains Python/CUDA based.

## Decision gate

The pilot succeeds if one well-captured truck produces a recognizable, convincing navigable representation from all principal exterior views; the asset loads acceptably on target hardware; and at least three tags stay in the right locations and show correct listing evidence. Record concrete time and cost before setting any production budget.

Then test several more vehicles and the sparse-photo baseline. If only guided video succeeds, propose a seller capture workflow. If photo-real splats look good but are difficult to tag, test a proxy mesh for anchors. If the reconstruction itself is poor, revise capture or evaluate another reconstruction pipeline before building production automation.

## Deliverables

1. One documented capture and reproducible Modal job.
2. A reviewed splat export and reference screenshots from multiple viewpoints.
3. A minimal interactive viewer with three evidence-backed tags.
4. A brief evaluation of quality, compute cost, asset size, and capture requirements.
5. A go/no-go decision for expanding to listings at scale.

## Sources

- [Nerfstudio custom-data workflow](https://docs.nerf.studio/quickstart/custom_dataset.html)
- [Nerfstudio Splatfacto and splat export](https://docs.nerf.studio/nerfology/methods/splat.html)
- [Modal GPU configuration](https://modal.com/docs/guide/gpu)
- [Modal background jobs](https://modal.com/docs/guide/job-queue)
- [Modal Volumes](https://modal.com/docs/guide/volumes)

This is a pilot plan. The capture, Modal image, reconstruction quality, and rendering integration have not been tested yet.
