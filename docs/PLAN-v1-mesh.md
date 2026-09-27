# Garage Intelligence — Implementation Plan

Date: September 25, 2026  
Status: Proposed MVP; no implementation or generation provider selected yet.

## 1. Product goal

Build Garage Intelligence, a desktop application with a persistent sidebar for multiple Garage tools. Its first feature, **3D Listings**, lets users select a vehicle, explore a 3D representation, and click tagged parts to inspect listing photos and specifications.

The target experience is inspired by Schemata's interactive equipment exploration. The first version supports navigation and informational tags. Moving equipment, opening doors, mechanical simulations, and reconstructed interiors are outside the MVP.

## 2. MVP experience

1. Open Garage Intelligence and sign in with an authorized Garage account.
2. Select **3D Listings** in the sidebar.
3. Search listings by title or ID and select a vehicle.
4. Open an existing 3D asset or request generation from available listing photos.
5. Rotate, zoom, and pan around the vehicle; use Front, Rear, Left, Right, and Reset controls.
6. Click a part tag to select it and focus the camera on that area.
7. Read the part's details and view original listing photos in an inspection panel.

Example: clicking **Pump Panel** displays the listing's pump-panel photos, manufacturer, rated GPM, and pump hours when those facts are available.

## 3. Interface

| Area | Contents |
| --- | --- |
| Persistent sidebar | Garage Intelligence branding, 3D Listings, Settings; additional features added as they ship |
| Listing browser | Search, thumbnail, title, listing ID, and 3D processing status |
| Viewer header | Selected listing, asset representation label, generation/retry action for authorized users |
| Main viewport | Vehicle, anchored tags, navigation controls, preset viewpoints |
| Inspection panel | Selected part, original photos, specifications, descriptions, and source information |
| Editor mode | Add, move, rename, and delete tags; attach photos and approved listing fields |

Keep the viewer reusable so it can later be embedded in Garage's web listing pages. Desktop packaging should not be required for its core interaction logic.

## 4. Strategy for obtaining the 3D vehicle

### Preferred path: reconstruct the actual listing

Use available exterior listing photos as input to a reconstruction or image-to-3D pipeline. Evaluate the result before exposing it to users. Sparse photos may produce distorted geometry or invented details, especially on unseen surfaces.

Do not promise automatic, accurate reconstruction for every listing. A generated model is a visual aid, not proof of vehicle condition or dimensions. Keep original photos readily accessible.

### Optional fallback: illustrative templates

If reconstruction quality is insufficient, use a licensed or commissioned 3D template for a vehicle category such as a pumper, aerial, tanker, or ambulance. Attach the selected listing's real photos and facts to that template.

Label this mode **Illustrative model**. Do not present its compartment layout or proportions as an exact match. Templates are an optional fallback, not a replacement for the goal of reconstructing actual listings.

The supplied side-view truck illustration can inform a future 2D fallback. A flat illustration alone does not supply the geometry needed to rotate a vehicle in 3D.

### Role of vPIC

Use vPIC optionally to enrich available VIN-derived vehicle facts. Its documented API provides vehicle/manufacturer information, not a library of 3D models or vehicle drawings. Missing fields remain unknown. Do not infer pump, tank, compartment, or aftermarket equipment details solely from VIN decoding.

## 5. First milestone: validate the hardest dependency

Before selecting a generation provider or building the full desktop workflow:

- Select 5–10 representative listings with permission to process their images.
- Include both good exterior coverage and sparse photo sets.
- Evaluate candidate reconstruction approaches against the same inputs.
- Compare body shape, axle count, cab shape, major equipment, texture quality, and all visible sides with source photos.
- Record generation time, cost, asset size, viewer performance, and manual cleanup required.
- Verify commercial usage rights and available output formats.
- Identify whether improved walkaround capture is necessary.

**Decision gate:** choose a reconstruction approach only if it produces useful, reviewable results on representative listings. Otherwise ship an explicitly illustrative pilot and/or define a guided photo capture workflow. Do not select a provider based only on its demo examples.

## 6. Proposed architecture

These are implementation proposals, to be checked against the Garage repository before coding.

| Component | Responsibility |
| --- | --- |
| Electron desktop shell | Application window, desktop lifecycle, controlled integration with the operating system |
| React + TypeScript UI | Sidebar, listing browser, inspection panel, generation states, tag editor |
| Three.js-based viewer | Render assets, camera controls, picking, anchored labels; evaluate React Three Fiber for React integration |
| Garage backend | Authorize access, retrieve listing data, manage assets and tags, start generation jobs |
| Background worker | Prepare photos, invoke selected generation service, validate output, store result |
| Object storage | Versioned 3D assets, thumbnails, and generated supporting files |
| Database | Asset lifecycle, provenance, job references, tags, review status |

Prefer GLB for mesh assets if supported by the selected pipeline. If reconstruction quality favors Gaussian splats, explicitly evaluate renderer compatibility and tag placement before adopting them. Keep generation behind a provider adapter so provider changes do not require rewriting the UI.

Run heavy generation on the backend. The Electron app submits jobs and displays results. Reuse existing Garage infrastructure where suitable; confirm exact worker, storage, and authentication integrations during implementation.

## 7. Generation lifecycle

1. Backend checks access to the listing and collects selected source image IDs.
2. Create an asset version and job keyed by listing, source-image fingerprint, and pipeline version.
3. Worker prepares inputs and calls the selected generation pipeline.
4. Validate output format, size, loadability, and basic orientation; normalize coordinates where necessary.
5. Store the asset and mark it ready for review.
6. Reviewer checks it against source photos, adds tags, and approves or rejects it.
7. Approved assets become available in the viewer.

Suggested processing states: `queued`, `processing`, `ready`, `failed`. Keep review states separate: `pending`, `approved`, `rejected`.

Retries must not create duplicate jobs or overwrite approved assets. Retain the previous approved version if regeneration fails. Changed source photos should mark the existing asset as potentially stale, not silently replace it.

## 8. Part tagging

Start with manual placement. An editor clicks the model surface, names the tag, and attaches relevant photos and listing fields.

Initial categories: Cab, Pump Panel, Compartments, Engine, Wheels/Tires, Rear, and Other. Only create tags supported by available information. An engine tag can link to an engine-bay photo without reconstructing the engine itself.

- Store tags in model-local coordinates and bind them to an exact asset version.
- Save an optional camera position and target for each tag.
- Distinguish selected tags clearly; hide or fade tags behind the vehicle.
- Provide a parts list so users can select tags without relying on tiny markers.
- Re-review or remap tags after regeneration; old coordinates may no longer match.
- Consider automated tag suggestions only after the manual workflow is useful.

## 9. Proposed data model

| Entity | Main fields |
| --- | --- |
| Listing3DAsset | ID, listing ID, version, representation type, asset storage key, format, source image IDs/fingerprint, provider/pipeline version, processing status, review status, error, timestamps |
| Listing3DTag | ID, asset version ID, label, category, local position, optional camera pose, description, display order |
| Tag evidence | Tag ID, source image IDs, linked listing field names, optional reviewed overrides and provenance |

Use existing listing fields as the authoritative source wherever possible. Avoid copying facts into disconnected descriptions that become stale. Record model orientation and normalization so placement and preset views are reproducible.

## 10. Proposed backend operations

- List/search authorized listings with their current 3D status.
- Retrieve the current approved asset and its tags.
- Request generation or retry for a listing.
- Retrieve job status and readable errors.
- Create, update, and delete tags for an asset version.
- Approve or reject an asset version.

These are logical operations, not committed route names. Follow existing Garage API conventions when implementing them.

## 11. Access and reliability

- Enforce existing listing permissions server-side for both assets and linked photos.
- Restrict generation, editing, and approval to appropriate roles.
- Keep provider credentials on the backend.
- Use an isolated Electron renderer with a narrow desktop bridge; do not give listing content arbitrary system access.
- Validate downloaded asset types and sizes before rendering.
- Provide loading, failed, missing-photo, and unsupported-rendering states.
- Cap generation concurrency and record per-job cost where available.
- Obtain appropriate asset licenses for any reusable templates.

## 12. Delivery sequence

### Phase 0 — Reconstruction evaluation

Complete the representative-listing experiment and choose the initial asset approach. Deliver a small reviewed sample and documented limitations.

### Phase 1 — Desktop shell and viewer

Create the branded Electron/React shell and 3D Listings screen. Load one known-good asset, implement camera controls, and display example tags. This phase can use fixtures and does not establish reconstruction success.

### Phase 2 — Garage listing integration

Connect authentication, listing search, photos, and specs. Load stored assets by listing and show honest processing and review states.

### Phase 3 — Tag editor

Implement placement, editing, linked evidence, camera focus, and persistence. Verify saved tags reload correctly on the same asset version.

### Phase 4 — Generation and review

Integrate the selected pipeline, jobs, storage, retries, asset versioning, and approval workflow. Keep unapproved results out of the default viewer.

### Phase 5 — Internal pilot

Package for the team's target desktop OS, validate on representative hardware, and collect feedback on usefulness, accuracy, and navigation. Expand only after the pilot meets acceptance criteria.

## 13. MVP acceptance criteria

- Garage Intelligence opens with a working sidebar and 3D Listings feature.
- An authorized user can search for a listing and load its available 3D representation.
- Rotation, zoom, pan, reset, and preset views work without losing the vehicle.
- Tags stay attached while the camera moves and open the correct listing evidence.
- Edited tags persist and remain bound to the correct asset version.
- Generated and illustrative representations are clearly distinguishable.
- Missing specifications are shown as unavailable rather than invented.
- Failed generation can be retried without losing an existing approved model.
- Access restrictions apply to assets, tags, and original photos.
- Pilot assets render responsively on agreed target hardware; measure performance before setting a production budget.

## 14. Deferred work

Automated part tagging, reconstructed cab interiors, moving equipment, dimension measurement, mechanical simulation, offline synchronization, public listing-page embedding, and additional Garage Intelligence tools.

## 15. Open implementation decisions

- Generation provider and acceptable reconstruction quality, cost, and latency.
- Whether illustrative templates are sufficient for the first internal pilot.
- Target desktop operating systems and distribution/update mechanism.
- Worker/storage integrations and authentication flow in the existing repository.
- Who reviews generated assets and maintains tags.
- Whether sellers need a guided capture workflow for reliable reconstruction.

## References

- [Schemata](https://www.schemata.com/) — interaction inspiration; no assumption that it exposes a suitable generation API.
- [NHTSA vPIC API](https://vpic.nhtsa.dot.gov/api/) — optional VIN-derived specification enrichment.

This plan defines proposed work. No repository integration, provider benchmark, or reconstruction quality claim has been verified by implementation yet.
