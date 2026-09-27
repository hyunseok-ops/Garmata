import { useState } from "react";
import type { Generation, GenerationStage, Listing3DAsset } from "../data/types.ts";

// docs/PLAN.md §16-§20, §36: what is generating, what is ready for review, and recent listings. Not an analytics page.

export const STAGE_LABEL: Record<GenerationStage, string> = {
  queued: "Waiting",
  preparing: "Preparing listing",
  generating_views: "Generating intermediate views",
  building_cameras: "Building camera poses",
  reconstructing: "Reconstructing 360 view",
  exporting: "Exporting result",
  ready: "Ready for review",
  failed: "Generation failed",
};

const ORDER: GenerationStage[] = ["preparing", "generating_views", "building_cameras", "reconstructing", "exporting", "ready"];

export function pipelineLabel(p: string): string {
  if (p === "novel-view-splat") return "Novel View Splat";
  if (p === "capture-splat") return "Capture Splat";
  if (p === "posed-test") return "Pipeline Test";
  if (p.startsWith("meshy")) return "Legacy Mesh";
  return p;
}

export type RecentListing = { id: string; title: string; secondaryId: number };

function Progress({ g }: { g: Generation }) {
  // Only show a bar when there is a real numerator and denominator (§18).
  if (g.total == null || g.current == null) return null;
  const pct = Math.max(0, Math.min(100, (g.current / g.total) * 100));
  return (
    <div className="progress">
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <span className="meta">{g.current.toLocaleString()} / {g.total.toLocaleString()}</span>
    </div>
  );
}

function Detail({ g }: { g: Generation }) {
  const at = ORDER.indexOf(g.stage === "failed" ? lastReached(g) : g.stage);
  const steps = g.pipeline === "posed-test" ? ORDER.filter((s) => s !== "generating_views") : ORDER;
  return (
    <ol className="steps">
      {steps.map((s) => {
        const i = ORDER.indexOf(s);
        const state = g.stage === "ready" || i < at ? "done" : i === at ? (g.stage === "failed" ? "failed" : "active") : "todo";
        return (
          <li key={s} className={state}>
            <span className="mark">{state === "done" ? "✓" : state === "active" ? "●" : state === "failed" ? "✕" : "○"}</span>
            {STAGE_LABEL[s]}
            {state === "active" && g.total != null && g.current != null && <span className="meta"> {g.current.toLocaleString()} / {g.total.toLocaleString()}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function lastReached(g: Generation): GenerationStage {
  if (g.done.splat) return "exporting";
  if (g.done.cameras) return "reconstructing";
  if (g.done.views || (g.pipeline === "posed-test" && g.done.prep)) return "building_cameras";
  if (g.done.prep) return "generating_views";
  return "preparing";
}

function Card({ g, onOpen, onRetry }: { g: Generation; onOpen: (listingId: string, assetId?: string) => void; onRetry: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`gen-card ${g.stage}`}>
      <div className="gen-head" onClick={() => setOpen((o) => !o)} title="Show pipeline steps">
        <div>
          <div className="title">{g.title} {g.secondaryId && <span className="meta">#{g.secondaryId}</span>}</div>
          <div className="meta">{pipelineLabel(g.pipeline)}{g.paused ? " · paused for inspection" : ""}</div>
        </div>
        <span className="meta">{open ? "▾" : "▸"}</span>
      </div>
      <div className={`gen-stage ${g.stage}`}>{g.stage === "ready" ? "✓ " : ""}{STAGE_LABEL[g.stage]}</div>
      {g.stage === "failed" ? <p className="meta err">{g.error}</p> : g.message && g.stage !== "ready" && <p className="meta">{g.message}</p>}
      {g.stage !== "failed" && <Progress g={g} />}
      {open && <Detail g={g} />}
      <div className="row">
        {g.stage === "ready" && <button className="primary" onClick={() => onOpen(g.listingId, g.assetId)}>View Result</button>}
        {g.stage === "failed" && <button onClick={() => onRetry(g.id)}>Retry</button>}
      </div>
    </div>
  );
}

export default function Dashboard(props: {
  generations: Generation[];
  pending: Listing3DAsset[];
  titles: Record<string, string>;
  recent: RecentListing[];
  onOpen: (listingId: string, assetId?: string) => void;
  onRetry: (id: string) => void;
}) {
  const active = props.generations.filter((g) => g.stage !== "ready" && g.stage !== "failed");
  // A failure stays visible only until a newer run of the same listing + pipeline exists (list is newest first).
  const latest = new Map<string, Generation>();
  for (const g of props.generations) if (!latest.has(`${g.listingId}:${g.pipeline}`)) latest.set(`${g.listingId}:${g.pipeline}`, g);
  const failed = [...latest.values()].filter((g) => g.stage === "failed").slice(0, 5);
  const readyGens = props.generations.filter((g) => g.stage === "ready" && props.pending.some((a) => a.id === g.assetId));
  const pendingWithoutGen = props.pending.filter((a) => !readyGens.some((g) => g.assetId === a.id));
  return (
    <main className="dashboard">
      <h2>Garage Intelligence</h2>
      <section>
        <h4>Active Generations</h4>
        {active.length === 0 && failed.length === 0 && <p className="meta">Nothing generating. Open a listing and choose Generate 360.</p>}
        <div className="cards">
          {active.map((g) => <Card key={g.id} g={g} onOpen={props.onOpen} onRetry={props.onRetry} />)}
          {failed.map((g) => <Card key={g.id} g={g} onOpen={props.onOpen} onRetry={props.onRetry} />)}
        </div>
      </section>
      <section>
        <h4>Ready for Review</h4>
        {readyGens.length === 0 && pendingWithoutGen.length === 0 && <p className="meta">No 360 versions waiting for review.</p>}
        <div className="cards">
          {readyGens.map((g) => <Card key={g.id} g={g} onOpen={props.onOpen} onRetry={props.onRetry} />)}
          {pendingWithoutGen.map((a) => (
            <div key={a.id} className="gen-card ready">
              <div className="title">{props.titles[a.listingId] ?? a.listingId}</div>
              <div className="meta">{pipelineLabel(a.pipelineVersion)} · v{a.version}</div>
              <div className="gen-stage ready">✓ 360 generated</div>
              <div className="row"><button className="primary" onClick={() => props.onOpen(a.listingId, a.id)}>View Result</button></div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h4>Recent Listings</h4>
        {props.recent.length === 0 && <p className="meta">Listings you open appear here.</p>}
        <ul className="recent">
          {props.recent.map((r) => <li key={r.id}><button onClick={() => props.onOpen(r.id)}>{r.title} <span className="meta">#{r.secondaryId}</span></button></li>)}
        </ul>
      </section>
    </main>
  );
}
