# Garage Intelligence — MVP Plan

**Date:** 2026-09-27  
**Repo:** `github.com/hyunseok-ops/Garmata`

## 1. MVP Goal

The MVP should answer one core question:

> Can Garage turn the sparse exterior photos already available on a listing into a useful, visually convincing 360° vehicle experience without requiring a new capture workflow?

The MVP is focused on the generation pipeline and viewer experience.

The following are **not MVP priorities**:

- authentication
- Supabase production integration
- public listing-page integration
- advanced roles/permissions
- automatic tag generation
- code signing / auto-update
- Windows support
- production-grade job infrastructure

The existing Electron app and local asset storage are sufficient for the MVP.

---

# 2. Product Direction

Garage Intelligence will no longer treat generated polygon meshes as a core product path.

The MVP will focus on a single visual representation:

> **Gaussian splat / photo-based 360° representation**

There will be two ways to create one:

```text
Existing sparse listing photos
        ↓
Novel-view generation
        ↓
Synthetic intermediate views
        ↓
Known camera poses
        ↓
Gaussian reconstruction


Continuous walkaround capture
        ↓
Camera pose estimation
        ↓
Gaussian reconstruction
```

The first path is the primary MVP experiment.

The second path is the high-confidence photo-real pipeline for future captures.

---

# 3. Core User Experience

A listing should contain:

```text
Listing
├── 360 View
├── Real Photos
├── Inspection Tags
└── Versions
```

The 360 viewer gives the user spatial understanding of the vehicle.

The original listing photographs remain the factual evidence.

While the user rotates around the splat, Garage Intelligence continues showing the real listing photo closest to the current viewing direction.

Example:

```text
┌─────────────────────────────────────────────┐
│                                             │
│                 360 VIEW                    │
│                                             │
│                   🚒                        │
│                                             │
│                                             │
│                              ┌───────────┐  │
│                              │ REAL      │  │
│                              │ PHOTO     │  │
│                              └───────────┘  │
└─────────────────────────────────────────────┘
```

The generated representation should help answer:

> "Where is everything on this truck?"

The original photographs should answer:

> "What does this part actually look like?"

Generated imagery must never replace the original photographs as factual evidence.

---

# 4. Sparse Listing Photo Pipeline

This is the main MVP experiment.

Current Garage listings often contain views such as:

```text
front
front 3/4
side
rear 3/4
rear
```

but do not contain enough overlapping photographs for traditional photogrammetry.

Previous testing showed:

```text
Sparse listing gallery
        ↓
COLMAP / LightGlue
        ↓
insufficient overlap
        ↓
poor camera alignment
        ↓
fragmented reconstruction
```

Instead, the new pipeline will be:

```text
Sparse listing photographs
        ↓
View normalization
        ↓
View-angle assignment
        ↓
Novel-view generation
        ↓
Intermediate synthetic views
        ↓
Known camera poses
        ↓
Splatfacto
        ↓
PLY / SPZ
        ↓
Garage Intelligence Viewer
```

---

# 5. Input Selection

The pipeline should use exterior images only.

Existing `ListingImage.viewLabel` values can identify useful images.

Priority input views:

```text
front
front_34
side
rear_34
rear
```

When available, the opposite side should also be included.

Ideal input:

```text
front
front-left
left
rear-left
rear
rear-right
right
front-right
```

A listing does not need all eight views for the experiment.

Initial target:

> 5–10 useful exterior photographs.

Interior images, documents, engine-bay photos, pump-panel closeups, and compartment closeups should not be fed into the exterior reconstruction pipeline.

---

# 6. Image Preparation

Before novel-view generation, input images should be normalized.

Existing source photographs may be extremely large, so the current local Electron resize path should remain.

Target:

```text
maximum dimension ≈ 1600 px
```

Preparation should eventually include:

- orientation normalization
- resizing
- basic crop normalization
- removal of obviously unusable images
- view-label filtering

The first MVP does not require sophisticated segmentation.

---

# 7. View Angle Assignment

Existing view labels should be mapped to approximate azimuths around the vehicle.

Example mapping:

```text
front        =   0°
front-left   =  45°
left         =  90°
rear-left    = 135°
rear         = 180°
rear-right   = 225°
right        = 270°
front-right  = 315°
```

Garage's current labels may not explicitly distinguish left and right in every case.

For the MVP, approximate assignments are acceptable.

These assignments are primarily used to:

1. order the real photographs around the vehicle
2. determine which intermediate angles are missing
3. construct approximate camera poses

---

# 8. Novel View Generation

Novel-view generation means generating an image of the same vehicle from a camera angle that was never photographed.

Example:

```text
0°      real
15°     generated
30°     generated
45°     real
60°     generated
75°     generated
90°     real
```

For the initial experiment, generate a complete exterior ring at:

```text
15° intervals
```

This gives:

```text
360 / 15 = 24 views
```

Example output:

```text
000.png
015.png
030.png
045.png
060.png
075.png
090.png
105.png
120.png
135.png
150.png
165.png
180.png
195.png
210.png
225.png
240.png
255.png
270.png
285.png
300.png
315.png
330.png
345.png
```

Whenever a real image corresponds closely to a requested angle, prefer the real image.

Synthetic views should only fill missing angles.

---

# 9. Novel View Model Experiment

The MVP should test a small number of approaches rather than prematurely committing to one model.

Candidate approaches include:

- Zero123++
- SyncDreamer
- other multi-view diffusion models
- newer sparse-view image-conditioned models
- direct sparse-image-to-Gaussian approaches if easy to test

The initial goal is not to select the final production model.

The goal is simply:

> Determine whether a model can generate enough geometrically consistent intermediate views of a fire truck to support a stable 360 reconstruction.

---

# 10. Important Constraint: Consistency

The biggest technical challenge is not image quality.

It is **cross-view consistency**.

The generated vehicle must not significantly change between adjacent angles.

Examples of failures:

```text
30°
10 wheel lugs

45°
8 wheel lugs
```

or:

```text
60°
black mirror

75°
chrome mirror
```

or:

```text
90°
four compartments

105°
five compartments
```

Major consistency requirements:

- cab proportions remain stable
- body length remains stable
- wheel count remains stable
- wheel position remains stable
- mirrors remain stable
- major compartments remain stable
- pump-panel placement remains stable
- ladder structure remains stable
- paint and major striping remain stable

Small errors in lettering are acceptable for the MVP.

Large geometry changes are not.

---

# 11. Camera Pose Generation

For generated views, Garage already knows the requested camera angle.

Therefore, the novel-view pipeline should **not require COLMAP to rediscover the full camera orbit**.

Instead, Garage should construct camera poses mathematically.

For each azimuth `θ`:

```text
x = radius * sin(θ)
z = radius * cos(θ)
y = cameraHeight
```

Each camera points toward the estimated vehicle center.

Conceptually:

```text
                   0°
                   ●
                   |
                   |
          270° ● --🚒-- ● 90°
                   |
                   |
                   ●
                  180°
```

All synthetic views should use approximately:

- the same camera radius
- the same focal length
- the same camera height
- the same target point

The resulting poses should be exported in Nerfstudio-compatible format.

Example:

```text
transforms.json
```

This removes one of the largest failure points in the existing sparse-photo pipeline.

---

# 12. Splat Reconstruction

The existing Modal + Nerfstudio pipeline should be reused.

Current stack:

```text
Modal
Nerfstudio 1.1.5
Splatfacto
A10G / H100
Spark viewer
```

New mode:

```text
generated images
+
known transforms.json
        ↓
Nerfstudio
        ↓
Splatfacto
        ↓
PLY / SPZ
```

The sparse synthetic pipeline should skip traditional feature matching whenever explicit camera poses are available.

Conceptually:

```text
ns-train splatfacto
    --data posed-dataset
```

The exact CLI / dataset adapter can be implemented based on the existing Nerfstudio pipeline.

---

# 13. Continuous Capture Pipeline

The existing real-capture pipeline remains valid.

This is the preferred high-fidelity path.

Input:

```text
2–3 minute walkaround video
```

or:

```text
80–150 overlapping photographs
```

Pipeline:

```text
walkaround capture
        ↓
frame extraction
        ↓
COLMAP / hloc
        ↓
alignment gate
        ↓
Splatfacto
        ↓
PLY / SPZ
```

Current results already prove this pipeline works with a proper capture sequence.

The Tanks & Temples truck reconstruction validated:

- Nerfstudio training
- Modal execution
- Splatfacto export
- Spark rendering
- free orbit in Garage Intelligence

The remaining test is a properly captured real Garage vehicle.

---

# 14. Representation Types

The MVP should simplify asset representations.

Instead of supporting separate product concepts for:

```text
Mesh
Splat
```

the user-facing product should primarily expose:

```text
360 Representation
```

Internally, versions can retain provenance.

Recommended pipeline values:

```text
novel-view-splat
capture-splat
```

Meaning:

### `novel-view-splat`

Created from existing sparse listing photographs.

Some viewpoints were synthesized by AI.

### `capture-splat`

Created from a continuous photographic walkaround.

The geometry is reconstructed primarily from real observations.

The existing `Listing3DAsset` name can remain internally for now to avoid unnecessary refactoring.

---

# 15. Versioning

Generation should continue to be versioned.

Never overwrite previous results.

Example:

```text
Listing
│
├── Version 1
│   novel-view-splat
│   rejected
│
├── Version 2
│   novel-view-splat
│   approved
│
└── Version 3
    capture-splat
    approved
```

The currently approved version loads by default.

Experimental or rejected versions remain available only in editor mode.

---

# 16. Dashboard Generation Status

The dashboard should include a compact generation-progress section.

Example:

```text
┌────────────────────────────────────────────┐
│ 360 Generation                             │
│                                            │
│ 2018 Pierce Dash CF Pumper                 │
│                                            │
│ Generating intermediate views              │
│ ██████████████░░░░░░  16 / 24              │
│                                            │
│ Next: Gaussian reconstruction              │
└────────────────────────────────────────────┘
```

Multiple active jobs can appear as cards.

Example:

```text
Active Generations

┌────────────────────────────────────────────┐
│ Pierce Velocity Pumper                     │
│ Generating intermediate views              │
│ ████████████░░░░░░ 16 / 24                 │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│ E-One Cyclone Quint                        │
│ Reconstructing                             │
│ ███████████████░░░ 10,850 / 15,000         │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│ Horton Type I Ambulance                    │
│ ✓ Ready for Review                         │
│ [View Result]                              │
└────────────────────────────────────────────┘
```

---

# 17. Generation State Model

Progress should be based on real pipeline stages, not estimated timers.

Recommended stages:

```ts
type GenerationStage =
  | "queued"
  | "preparing"
  | "generating_views"
  | "building_cameras"
  | "reconstructing"
  | "exporting"
  | "ready"
  | "failed";
```

Possible UI labels:

```text
queued
→ Waiting

preparing
→ Preparing listing

generating_views
→ Generating intermediate views

building_cameras
→ Building camera poses

reconstructing
→ Reconstructing 360 view

exporting
→ Exporting result

ready
→ Ready for review

failed
→ Generation failed
```

---

# 18. Progress Data

Each stage should expose meaningful progress when possible.

Example:

```ts
type GenerationProgress = {
  stage: GenerationStage;

  current?: number;
  total?: number;

  message?: string;
};
```

Examples:

```json
{
  "stage": "generating_views",
  "current": 16,
  "total": 24
}
```

```json
{
  "stage": "reconstructing",
  "current": 10850,
  "total": 15000
}
```

```json
{
  "stage": "exporting",
  "message": "Converting splat to SPZ"
}
```

The dashboard progress bar should only show numeric progress when a meaningful numerator and denominator exist.

---

# 19. Dashboard Card Behavior

Each generation card should display:

- listing title
- listing number if useful
- current stage
- progress
- pipeline type
- final state
- action when completed

Example completed state:

```text
┌────────────────────────────────────────────┐
│ 2018 Pierce Dash CF Pumper                 │
│ Novel View Splat                           │
│                                            │
│ ✓ Ready for Review                         │
│                                            │
│ [View Result]                              │
└────────────────────────────────────────────┘
```

Failure:

```text
┌────────────────────────────────────────────┐
│ 2007 Pierce Dash Pumper                    │
│                                            │
│ Generation failed                          │
│ Novel views became inconsistent            │
│                                            │
│ [Retry]                                    │
└────────────────────────────────────────────┘
```

---

# 20. Generation Detail View

Clicking a progress card should eventually expose more detail.

For MVP, this can be minimal.

Example:

```text
Generating 360 Representation

✓ Preparing photos

✓ Detecting exterior views

✓ Generating views
  24 / 24

✓ Building camera poses

● Reconstructing
  10,850 / 15,000 iterations

○ Exporting

○ Ready for review
```

This does not need to become a full job-management system.

It only needs to make development and generation status understandable.

---

# 21. Existing Viewer Features to Keep

The current viewer work remains useful and should not be rewritten.

Keep:

- orbit
- zoom
- pan
- Front / Rear / Left / Right presets
- Reset
- Versions tab
- approve / reject
- inspection panel
- listing specs
- real listing photographs
- angle-matched real photo panel
- tag placement
- tag evidence links
- saved tag camera pose
- template tag seeding
- occlusion fading

The new pipeline changes how the primary visual asset is created.

It does not require rebuilding the viewer.

---

# 22. Tags

Tags remain bound to an individual generated version.

Example:

```text
Listing
   ↓
360 Asset Version
   ↓
Tags
```

Tags should continue to reference real evidence:

```text
tag
├── position in splat/model space
├── label
├── description
├── category
├── linked real photos
└── linked listing attributes
```

Generated imagery should never be treated as evidence for a tag.

The evidence remains:

- original Garage photographs
- listing specs

---

# 23. MVP Experiment Dataset

Do not immediately run this across the full inventory.

Start with **one listing** with the best available exterior coverage.

Ideal first test:

```text
6–10 exterior photos
good lighting
little obstruction
clear front
clear side
clear rear
consistent vehicle configuration
```

Prefer a conventional pumper before testing:

- aerials
- quints
- unusually long rescue vehicles

because those geometries introduce additional complexity.

---

# 24. First Experiment

The first end-to-end experiment should be:

```text
1 Garage listing
        ↓
collect exterior photos
        ↓
normalize images
        ↓
assign approximate azimuth
        ↓
generate 24 views
        ↓
generate camera poses
        ↓
train Splatfacto
        ↓
export PLY / SPZ
        ↓
load in Electron viewer
        ↓
compare with original photographs
```

Do this manually where necessary.

Do not build generalized infrastructure before proving the visual result.

---

# 25. MVP Success Criteria

The experiment succeeds if the resulting 360 representation provides noticeably more spatial understanding than the normal photo gallery.

## Geometry

The following should remain stable during rotation:

- cab shape
- vehicle length
- wheel placement
- major compartment placement
- module / body structure
- ladder placement when applicable

## Appearance

The following should remain reasonably consistent:

- primary paint
- major stripes
- body color divisions
- major equipment
- pump-panel region
- compartment boundaries

## Orbit Stability

The user should not see major:

- duplicated wheels
- disappearing wheels
- teleporting compartments
- body morphing
- moving mirrors
- cab size changes
- vehicle-length changes
- floating geometry

## Product Usefulness

A user looking at the generated representation should gain a better understanding of:

```text
front
rear
driver side
passenger side
major equipment locations
overall vehicle proportions
```

than they would from manually clicking through the listing gallery.

---

# 26. Acceptable MVP Errors

The MVP does **not** require perfect reconstruction.

Acceptable errors include:

- unreadable generated text
- slightly incorrect small decals
- minor reflective differences
- imperfect lighting
- small texture seams
- approximate details on surfaces that were never photographed

These areas remain backed by the original listing photographs.

---

# 27. Failure Criteria

The sparse-photo experiment should be stopped if repeated tests show:

- significant geometry morphing
- inconsistent compartment layouts
- duplicated wheels
- severe splat fragmentation
- unstable cab geometry
- generated views that contradict real photographs
- no meaningful visual improvement over the normal photo gallery
- unreasonable GPU cost relative to the result

The team should avoid endlessly tuning the reconstruction pipeline if the missing information simply cannot be inferred reliably.

---

# 28. Fallback Strategy

If sparse novel-view reconstruction fails, the product still has a valid path:

```text
Normal listing
        ↓
real-photo browsing
        +
angle-matched inspection interface
```

and:

```text
Premium / captured listing
        ↓
walkaround video
        ↓
capture-splat
        ↓
full 360 experience
```

The MVP experiment determines whether the sparse-photo 360 tier can exist between these two.

---

# 29. Local Experiment Structure

Add a dedicated development directory:

```text
experiments/
    novel-view/
```

Each listing experiment should produce:

```text
experiments/
└── <listing-id>/
    ├── real/
    ├── normalized/
    ├── generated/
    ├── poses/
    ├── output/
    └── manifest.json
```

Example:

```text
real/
    front.jpg
    front-left.jpg
    side.jpg
    rear-left.jpg
    rear.jpg

generated/
    000.png
    015.png
    030.png
    ...
    345.png

poses/
    transforms.json

output/
    splat.ply
```

---

# 30. Manifest

Each experiment should record its inputs and provenance.

Example:

```json
{
  "listingId": "example-id",

  "views": [
    {
      "azimuth": 0,
      "file": "000.png",
      "source": "real",
      "sourceImage": "front.jpg"
    },
    {
      "azimuth": 15,
      "file": "015.png",
      "source": "generated",
      "conditionedOn": [
        "front.jpg",
        "front-left.jpg"
      ]
    }
  ]
}
```

This will make debugging much easier when a generated viewpoint causes reconstruction problems.

---

# 31. Development Commands

Useful experimental commands could be added.

Example:

```bash
GI_NOVEL_PREP=<listingId>
```

Creates:

```text
real/
normalized/
manifest.json
```

Then:

```bash
GI_NOVEL_GENERATE=<listingId>
```

Creates the intermediate viewpoints.

Then:

```bash
GI_NOVEL_SPLAT=<listingId>
```

Generates poses and launches reconstruction.

Eventually:

```bash
GI_GENERATE=<listingId>
```

can orchestrate the entire pipeline.

For the first experiment, however, keeping these phases separate will make debugging easier.

---

# 32. Generation Pipeline Architecture

Long-running work should not depend on the Electron window remaining open.

The architecture should remain:

```text
Electron
   ↓
start generation
   ↓
remote/background job
   ↓
persist status
   ↓
Electron polls or refreshes status
```

The dashboard card reads that status.

The actual reconstruction job continues independently.

The exact production job system is not an MVP concern.

The existing Modal detached execution approach is sufficient.

---

# 33. Modal Pipeline

Reuse:

```text
pipeline/splat_modal.py
```

Add support for two input modes:

```text
capture
```

and:

```text
posed-images
```

### Capture mode

```text
images/video
    ↓
COLMAP / hloc
    ↓
Splatfacto
```

### Posed-images mode

```text
images
+
transforms.json
    ↓
Splatfacto
```

This keeps both reconstruction paths in one pipeline.

---

# 34. Alignment Gate

The existing alignment gate remains useful for real capture.

Example:

```text
aligned frames < 15
    ↓
STOP
```

However, this gate should not apply in the same way to explicitly posed synthetic images.

For `posed-images`, validation should instead check:

- all expected frames exist
- transforms exist
- matrices are valid
- image dimensions are consistent
- camera ordering is valid
- no obviously corrupt images exist

---

# 35. Viewer Asset Format

Continue using formats supported by Spark:

```text
.ply
.spz
.splat
```

Prefer the smallest practical production representation after the visual pipeline works.

Optimization is not part of the first experiment.

A large `.ply` is acceptable for MVP testing.

---

# 36. Dashboard Scope

The dashboard does not need to become an analytics page.

Its immediate purpose is:

> Show what Garage Intelligence is currently generating and whether something is ready for review.

Minimum sections:

```text
Garage Intelligence

Active Generations

Ready for Review

Recent Listings
```

This is enough for the MVP.

---

# 37. Recommended Dashboard Layout

Example:

```text
┌────────────────────────────────────────────────────┐
│ Garage Intelligence                                │
│                                                    │
│ Active Generations                                 │
│                                                    │
│ ┌───────────────────────────────────────────────┐  │
│ │ 2018 Pierce Dash CF Pumper                    │  │
│ │ Generating intermediate views                 │  │
│ │ █████████████░░░░░ 16 / 24                    │  │
│ └───────────────────────────────────────────────┘  │
│                                                    │
│ ┌───────────────────────────────────────────────┐  │
│ │ 2007 Pierce Velocity                          │  │
│ │ Reconstructing                                │  │
│ │ ███████████████░░ 11,204 / 15,000             │  │
│ └───────────────────────────────────────────────┘  │
│                                                    │
│ Ready for Review                                   │
│                                                    │
│ ┌───────────────────────────────────────────────┐  │
│ │ Horton Type I Ambulance                       │  │
│ │ ✓ 360 generated                               │  │
│ │                              [View Result]    │  │
│ └───────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

---

# 38. What Is Removed From MVP

The following should be removed from the main MVP plan:

- Meshy integration as the primary generation pipeline
- polygon mesh generation
- Meshy credits / tier selection
- mesh-specific transform behavior
- mesh-vs-splat product terminology
- open-source mesh generators such as Hunyuan3D or TRELLIS
- maintaining two parallel generation products

Old architecture:

```text
listing
├── generated mesh
└── photo-real splat
```

New architecture:

```text
listing
└── 360 representation
    ├── novel-view-splat
    └── capture-splat
```

This reduces the MVP surface considerably.

---

# 39. What Is Deferred

Do not prioritize:

- Clerk API-key integration
- Supabase production bucket
- Garage monorepo PR
- public listing embedding
- seller capture app
- automatic tag suggestion
- AI tag placement
- splat proxy meshes
- advanced occlusion logic
- Windows packaging
- code signing
- auto-update
- audit system
- role system
- production queue architecture
- model replacement strategy
- splat cropping
- compression optimization

until the sparse-photo visual experiment has been evaluated.

---

# 40. Immediate Implementation Order

## Phase 1 — Simplify UI

Remove generated-mesh-specific UI concepts.

Keep:

```text
360 View
Photos
Versions
Tags
```

Add:

```text
Generation Status Cards
```

---

## Phase 2 — Dataset Preparation

Build:

```bash
GI_NOVEL_PREP=<listingId>
```

Responsibilities:

- query listing
- select exterior images
- resize images
- map view labels to approximate angles
- write manifest
- save normalized inputs

---

## Phase 3 — Novel View Prototype

Pick one model.

Generate:

```text
24-view orbit
```

Do not initially automate model selection.

Inspect the images manually before reconstruction.

This step answers the most important question:

> Are adjacent generated views consistent enough?

---

## Phase 4 — Pose Generator

Create:

```text
generateTransforms.ts
```

or equivalent.

Input:

```text
24 azimuths
camera radius
camera height
focal parameters
```

Output:

```text
transforms.json
```

---

## Phase 5 — Posed Nerfstudio Pipeline

Extend Modal pipeline to accept:

```text
images/
transforms.json
```

without running COLMAP.

Train:

```text
Splatfacto
15k iterations
```

Export:

```text
PLY
```

---

## Phase 6 — Viewer Integration

Import the splat into the existing viewer.

Verify:

- orientation
- scale
- controls
- Front / Rear / Left / Right
- real-photo matching
- tags

---

## Phase 7 — Dashboard Progress

Add pipeline status to the dashboard.

During experiment mode this can use local state / JSON.

Example:

```json
{
  "listingId": "123",
  "stage": "generating_views",
  "current": 16,
  "total": 24
}
```

No backend persistence is required initially.

---

## Phase 8 — Evaluation

Compare:

```text
generated 360
vs.
original listing gallery
```

Evaluate:

- geometry stability
- appearance stability
- spatial usefulness
- obvious hallucinations
- viewer experience
- runtime
- GPU cost

Record the result.

---

# 41. MVP Decision Gate

After one or several representative vehicles:

## Continue sparse-photo 360 if:

- generated views remain reasonably consistent
- splat remains coherent
- the orbit is visually useful
- geometry is substantially stable
- the result provides meaningful spatial information
- inference cost is acceptable

Then:

```text
prototype
→ automate
→ test across vehicle categories
→ integrate backend
→ public product experiment
```

## Stop if:

- hallucinated geometry dominates
- trucks noticeably morph during orbit
- splats remain fragmented
- generated intermediate views contradict the real photos
- the result does not meaningfully improve understanding

Then the product strategy becomes:

```text
existing listing
→ enhanced real-photo viewer

walkaround capture
→ full photo-real 360
```

without a sparse-photo generated 360 tier.

---

# 42. Final MVP Architecture

```text
                    GARAGE LISTING
                          │
                    Exterior Photos
                          │
                          ▼
                  Image Preparation
                          │
                          ▼
                    View Mapping
                          │
                          ▼
                Novel View Generation
                          │
                 24-View Image Ring
                          │
                          ▼
                Deterministic Cameras
                          │
                          ▼
                     Splatfacto
                          │
                          ▼
                      PLY / SPZ
                          │
                          ▼
              Garage Intelligence Viewer
                          │
         ┌────────────────┴────────────────┐
         │                                 │
     360 Orbit                       Real Photos
         │                                 │
   Spatial Context                    Ground Truth
         │
         └────────────────┬────────────────┘
                          │
                    Inspection Tags
```

For listings with a real walkaround:

```text
Walkaround Video
       │
       ▼
Frame Extraction
       │
       ▼
COLMAP / hloc
       │
       ▼
Splatfacto
       │
       ▼
Same Viewer
```

---

# 43. Final MVP Definition

Garage Intelligence MVP is:

> A desktop tool that takes the exterior photos already attached to a Garage vehicle listing, attempts to generate consistent missing viewpoints, reconstructs them into an interactive Gaussian-splat 360 representation, shows generation progress in the dashboard, and keeps the original listing photographs available as ground-truth inspection evidence.

The MVP is successful when Garage can take **one real sparse listing** and produce a 360 representation that provides meaningfully better spatial understanding than the original gallery.

Everything else comes after that works.