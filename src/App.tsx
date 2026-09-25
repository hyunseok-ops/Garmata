import { useCallback, useEffect, useState } from "react";
import type { Listing3DAsset, Listing3DTag, ListingDetail, ListingSummary, TagCategory, Vec3 } from "./data/types.ts";
import { TAG_CATEGORIES } from "./data/types.ts";
import { fixtureApi } from "./data/fixtures.ts";
import { desktop } from "./data/garageApi.ts";
import { CATEGORY_VIEWS, VIEW_LABELS, pickGenerationPhotos } from "./data/photos.ts";
import { addTag, deleteTag, updateTag } from "./data/tags.ts";
import Viewer, { PRESETS, validateAssetUrl, type Pose } from "./viewer/Viewer.tsx";

type Feature = "3d" | "settings";

// Desktop shell = live Garage data via the main process; plain browser = offline fixtures.
const api = desktop ?? fixtureApi;

const REPRESENTATION_LABEL = { illustrative: "Illustrative model", reconstructed: "Reconstructed from listing photos" } as const;
type Tab = "3d" | "versions";

const STATUS_LABEL = { none: "No 3D", queued: "Queued", processing: "Processing", ready: "Ready", failed: "Failed" } as const;

export default function App() {
  const [feature, setFeature] = useState<Feature>("3d");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ListingSummary[]>([]);
  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [asset, setAsset] = useState<Listing3DAsset | null>(null);
  const [versions, setVersions] = useState<Listing3DAsset[]>([]);
  const [tab, setTab] = useState<Tab>("3d");
  const [assetError, setAssetError] = useState<string | null>(null);
  const [tags, setTags] = useState<Listing3DTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [pose, setPose] = useState<Pose | null>(null);
  const [capturePose, setCapturePose] = useState<(() => Pose) | null>(null);
  const [status, setStatus] = useState<{ garage: boolean; provider: boolean }>({ garage: false, provider: false });
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => void desktop?.status().then(setStatus), []);

  // Poll while a job is live so the header and list reflect provider progress.
  useEffect(() => {
    if (!asset || !listing || (asset.processingStatus !== "queued" && asset.processingStatus !== "processing")) return;
    const t = setInterval(async () => {
      const a = await api.getCurrentAsset(listing.id);
      if (a && (a.processingStatus !== asset.processingStatus || a.id !== asset.id)) {
        setAsset(a);
        setTags(await api.listTags(a.id));
        setResults(await api.searchListings(query));
      }
    }, 5000);
    return () => clearInterval(t);
  }, [asset, listing, query]);

  useEffect(() => void api.searchListings(query).then(setResults), [query]);

  const openListing = async (id: string) => {
    const [l, a, vs] = await Promise.all([api.getListing(id), api.getCurrentAsset(id), api.listAssets(id)]);
    setListing(l);
    setAsset(a);
    setVersions(vs);
    setTab("3d");
    setSelectedTagId(null);
    setEditing(false);
    setPlacing(false);
    setPose(PRESETS.Reset);
    setTags(a ? await api.listTags(a.id) : []);
    setAssetError(a?.format === "glb" && a.storageKey ? await validateAssetUrl(a.storageKey) : null);
  };

  const commitTags = (next: Listing3DTag[]) => {
    setTags(next);
    if (asset) void api.saveTags(asset.id, next);
  };

  const selectTag = (id: string | null) => {
    setSelectedTagId(id);
    const t = tags.find((x) => x.id === id);
    if (t) setPose(t.camera ?? { position: [t.position[0] + 4, t.position[1] + 2, t.position[2] + 4], target: t.position });
  };

  const generate = async () => {
    if (!listing) return;
    setGenError(null);
    try {
      const a = await api.requestGeneration(listing.id);
      setAsset(a);
      setTags(await api.listTags(a.id));
      setResults(await api.searchListings(query));
    } catch (e) {
      setGenError((e as Error).message);
    }
  };

  const review = async (s: "approved" | "rejected", target: Listing3DAsset | null = asset) => {
    if (!target || !desktop) return;
    await desktop.reviewAsset(target.id, s);
    setVersions(await api.listAssets(target.listingId));
    if (asset?.id === target.id) setAsset({ ...target, reviewStatus: s });
  };

  // Viewing a specific version from the Versions tab; tags follow the version.
  const viewVersion = async (v: Listing3DAsset) => {
    setPickedVersion(v.id);
    setAsset(v);
    setTags(await api.listTags(v.id));
    setSelectedTagId(null);
    setTab("3d");
    setAssetError(v.format === "glb" && v.storageKey ? await validateAssetUrl(v.storageKey) : null);
  };

  const genInputs = listing ? pickGenerationPhotos(listing.photos) : [];

  const onCapturePose = useCallback((fn: () => Pose) => setCapturePose(() => fn), []);
  const selected = tags.find((t) => t.id === selectedTagId) ?? null;
  const [pickedVersion, setPickedVersion] = useState<string | null>(null);
  const viewable = asset && asset.processingStatus === "ready" && (asset.reviewStatus === "approved" || editing || pickedVersion === asset.id);

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">G</span>
          <div>
            <div className="brand-name">Garage Intelligence</div>
            <div className="brand-sub">Internal tools</div>
          </div>
        </div>
        <button className={feature === "3d" ? "active" : ""} onClick={() => setFeature("3d")}>3D Listings</button>
        <button className={feature === "settings" ? "active" : ""} onClick={() => setFeature("settings")}>Settings</button>
      </nav>

      {feature === "settings" ? (
        <main className="settings">
          <h2>Settings</h2>
          <p>Garage listings: <b>{desktop ? (status.garage ? "connected (read-only)" : "GARAGE_DATABASE_URL not set") : "offline fixtures (browser mode)"}</b></p>
          <p>Generation provider: <b>{status.provider ? "Meshy multi-image-to-3D" : "not configured (set MESHY_API_KEY in .env)"}</b></p>
          <p>Desktop bridge: {desktop?.platform ?? "browser (no Electron)"}</p>
        </main>
      ) : (
        <>
          <aside className="browser">
            <input placeholder="Search title or listing #" value={query} onChange={(e) => setQuery(e.target.value)} />
            <ul>
              {results.map((r) => (
                <li key={r.id} className={listing?.id === r.id ? "active" : ""} onClick={() => openListing(r.id)}>
                  {r.thumbnailUrl ? <img src={r.thumbnailUrl} alt="" /> : <div className="thumb-empty" />}
                  <div>
                    <div className="title">{r.listingTitle}</div>
                    <div className="meta">#{r.secondaryId} · <span className={`pill ${r.processingStatus}`}>{STATUS_LABEL[r.processingStatus]}</span></div>
                  </div>
                </li>
              ))}
              {results.length === 0 && <li className="empty">No listings match.</li>}
            </ul>
          </aside>

          <main className="viewer">
            {!listing ? (
              <div className="viewport-state center">Select a listing to open its 3D representation.</div>
            ) : (
              <>
                <header>
                  <div>
                    <div className="title">{listing.listingTitle} <span className="meta">#{listing.secondaryId}</span></div>
                    <div className="meta">
                      {asset ? <><span className={`pill ${asset.representation}`}>{REPRESENTATION_LABEL[asset.representation]}</span> · v{asset.version} · {STATUS_LABEL[asset.processingStatus]} · review {asset.reviewStatus}</> : "No 3D asset yet"}
                    </div>
                  </div>
                  <div className="actions">
                    {asset?.processingStatus === "ready" && <button onClick={() => { setEditing((e) => !e); setPlacing(false); }}>{editing ? "Done editing" : "Edit tags"}</button>}
                    {editing && asset && asset.reviewStatus !== "approved" && <button className="primary" onClick={() => review("approved")}>Approve</button>}
                    {editing && asset && asset.reviewStatus !== "rejected" && <button onClick={() => review("rejected")}>Reject</button>}
                    {(!asset || asset.processingStatus === "failed" || asset.processingStatus === "ready") && (
                      <button onClick={generate} disabled={genInputs.length === 0 || (desktop && !status.provider)}
                        title={genInputs.length === 0 ? "No exterior photos to generate from" : desktop && !status.provider ? "Set MESHY_API_KEY in .env" : `Uses ${genInputs.length} exterior photo(s)`}>
                        {asset ? "Regenerate" : "Generate 3D"}
                      </button>
                    )}
                  </div>
                </header>

                <div className="tabs">
                  <button className={tab === "3d" ? "active" : ""} onClick={() => setTab("3d")}>3D orbit</button>
                  <button className={tab === "versions" ? "active" : ""} onClick={() => setTab("versions")}>Versions{versions.length ? ` (${versions.length})` : ""}</button>
                </div>
                {tab === "versions" ? (
                  <div className="versions">
                    {versions.length === 0 && <p className="meta">No generated versions yet.</p>}
                    {versions.map((v) => (
                      <div key={v.id} className={`version ${asset?.id === v.id ? "active" : ""}`}>
                        <div>
                          <div className="title">v{v.version} <span className={`pill ${v.representation}`}>{REPRESENTATION_LABEL[v.representation]}</span> <span className={`pill ${v.processingStatus}`}>{STATUS_LABEL[v.processingStatus]}</span> <span className={`pill ${v.reviewStatus}`}>{v.reviewStatus}</span></div>
                          <div className="meta">{v.pipelineVersion} · {v.format} · {v.sourceImageIds.length ? `${v.sourceImageIds.length} source photos · ` : ""}{new Date(v.createdAt).toLocaleString()}{v.error ? ` · ${v.error}` : ""}</div>
                        </div>
                        <div className="row">
                          <button onClick={() => viewVersion(v)} disabled={v.processingStatus !== "ready"}>{asset?.id === v.id ? "Viewing" : "View"}</button>
                          {api === desktop && v.reviewStatus !== "approved" && v.processingStatus === "ready" && <button className="primary" onClick={() => review("approved", v)}>Approve</button>}
                          {api === desktop && v.reviewStatus !== "rejected" && <button onClick={() => review("rejected", v)}>Reject</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                <div className="viewport">
                  {viewable && asset && !assetError ? (
                    <Viewer asset={asset} tags={tags} selectedTagId={selectedTagId} onSelectTag={selectTag} placing={placing}
                      onPlace={(p: Vec3) => { const next = addTag(tags, asset.id, p); commitTags(next); setSelectedTagId(next[next.length - 1].id); setPlacing(false); }}
                      pose={pose} onCapturePose={onCapturePose} />
                  ) : (
                    <div className="viewport-state center">
                      {genError ? `Generation request failed: ${genError}` : assetError ?? (
                        !asset ? `No 3D representation yet. ${genInputs.length ? `Generate one from ${genInputs.length} exterior photos.` : "This listing has no labelled exterior photos."}` :
                        asset.processingStatus === "failed" ? `Generation failed: ${asset.error ?? "unknown error"}` :
                        asset.processingStatus === "ready" ? (asset.reviewStatus === "rejected" ? "This version was rejected. Regenerate or open the editor to re-review." : "Asset awaiting review. Click Edit tags to inspect and approve it.") :
                        `Generation ${STATUS_LABEL[asset.processingStatus].toLowerCase()}… this usually takes a few minutes.`
                      )}
                    </div>
                  )}
                  {viewable && !assetError && (
                    <div className="hud">
                      {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => <button key={k} onClick={() => setPose({ ...PRESETS[k] })}>{k}</button>)}
                      {editing && <button className={placing ? "primary" : ""} onClick={() => setPlacing((p) => !p)}>{placing ? "Click the model…" : "+ Add tag"}</button>}
                    </div>
                  )}
                  {asset?.representation === "illustrative" && viewable && <div className="disclaimer">Illustrative template: layout and proportions are not this vehicle's. Check the original photos.</div>}
                </div>
                )}
              </>
            )}
          </main>

          <aside className="panel">
            {!listing ? null : editing && selected && asset ? (
              <TagEditor tag={selected} listing={listing} capturePose={capturePose}
                onChange={(patch) => commitTags(updateTag(tags, selected.id, patch))}
                onDelete={() => { commitTags(deleteTag(tags, selected.id)); setSelectedTagId(null); }} />
            ) : (
              <Inspection listing={listing} tags={tags} selected={selected} onSelect={selectTag} />
            )}
          </aside>
        </>
      )}
    </div>
  );
}

function Inspection({ listing, tags, selected, onSelect }: { listing: ListingDetail; tags: Listing3DTag[]; selected: Listing3DTag | null; onSelect: (id: string) => void }) {
  const photos = selected ? listing.photos.filter((p) => selected.evidence.imageIds.includes(p.id)) : listing.photos;
  const fields = selected ? selected.evidence.fields : Object.keys(listing.attributes);
  return (
    <>
      <h3>{selected ? selected.label : "Listing"}</h3>
      {selected?.description && <p className="meta">{selected.description}</p>}
      {!selected && listing.listingDescription && <p className="meta">{listing.listingDescription}</p>}
      <section>
        <h4>Photos {selected && <span className="meta">from listing</span>}</h4>
        {photos.length === 0 ? <p className="meta">No photos linked.</p> : (
          <div className="photos">{photos.map((p) => <figure key={p.id}><img src={p.url} alt={p.viewLabel ?? ""} /><figcaption>{p.viewLabel ? VIEW_LABELS[p.viewLabel] ?? p.viewLabel : "Photo"}</figcaption></figure>)}</div>
        )}
      </section>
      <section>
        <h4>Specifications</h4>
        {fields.length === 0 ? <p className="meta">No specifications linked.</p> : (
          <dl>{fields.map((f) => <div key={f}><dt>{f}</dt><dd className={listing.attributes[f] ? "" : "meta"}>{listing.attributes[f] ?? "Unavailable"}</dd></div>)}</dl>
        )}
      </section>
      <section>
        <h4>Parts</h4>
        {tags.length === 0 ? <p className="meta">No tags on this asset version.</p> : (
          <ul className="parts">{tags.map((t) => <li key={t.id}><button className={t.id === selected?.id ? "active" : ""} onClick={() => onSelect(t.id)}>{t.label} <span className="meta">{t.category}</span></button></li>)}</ul>
        )}
      </section>
    </>
  );
}

function TagEditor({ tag, listing, capturePose, onChange, onDelete }: { tag: Listing3DTag; listing: ListingDetail; capturePose: (() => Pose) | null; onChange: (patch: Partial<Listing3DTag>) => void; onDelete: () => void }) {
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <>
      <h3>Edit tag</h3>
      <label>Label<input value={tag.label} onChange={(e) => onChange({ label: e.target.value })} /></label>
      <label>Category
        <select value={tag.category} onChange={(e) => { const category = e.target.value as TagCategory; const views = CATEGORY_VIEWS[category]; const imageIds = listing.photos.filter((p) => p.viewLabel && views.includes(p.viewLabel)).map((p) => p.id); onChange({ category, label: tag.label.startsWith("New ") ? category : tag.label, evidence: { ...tag.evidence, imageIds: imageIds.length ? imageIds : tag.evidence.imageIds } }); }}>{TAG_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
      </label>
      <label>Description<textarea rows={3} value={tag.description ?? ""} onChange={(e) => onChange({ description: e.target.value || undefined })} /></label>
      <section>
        <h4>Photos</h4>
        {listing.photos.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={tag.evidence.imageIds.includes(p.id)} onChange={() => onChange({ evidence: { ...tag.evidence, imageIds: toggle(tag.evidence.imageIds, p.id) } })} /><img src={p.url} alt="" className="mini" />{p.viewLabel ? VIEW_LABELS[p.viewLabel] ?? p.viewLabel : "Photo"}</label>)}
      </section>
      <section>
        <h4>Listing fields</h4>
        {Object.keys(listing.attributes).length === 0 && <p className="meta">This listing has no attributes.</p>}
        {Object.keys(listing.attributes).map((f) => <label key={f} className="check"><input type="checkbox" checked={tag.evidence.fields.includes(f)} onChange={() => onChange({ evidence: { ...tag.evidence, fields: toggle(tag.evidence.fields, f) } })} />{f}</label>)}
      </section>
      <section>
        <h4>Camera</h4>
        <p className="meta">{tag.camera ? "Saved view set." : "No saved view; focus falls back to the tag position."}</p>
        <div className="row">
          <button onClick={() => capturePose && onChange({ camera: capturePose() })} disabled={!capturePose}>Save current view</button>
          {tag.camera && <button onClick={() => onChange({ camera: undefined })}>Clear</button>}
        </div>
      </section>
      <p className="meta">Position (model-local): {tag.position.join(", ")} · asset {tag.assetVersionId}</p>
      <button className="danger" onClick={onDelete}>Delete tag</button>
    </>
  );
}
