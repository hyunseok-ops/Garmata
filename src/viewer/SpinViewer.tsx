import { useEffect, useRef, useState } from "react";
import type { Listing3DAsset, Listing3DTag } from "../data/types.ts";
import { focalPx, poseFor, RING } from "../data/novel.ts";
import type { ViewBucket } from "./Viewer.tsx";

// Photo spin: a turntable of frames. At photographed angles the frame is the real listing photo (aligned, not
// altered); in between, generated frames fill the gap. Frames are preloaded and cross-faded, and drag has momentum,
// so the lap feels continuous. Tags are projected into each frame from the exact ring camera used to make it.

type SpinFrame = { azimuth: number; file: string; source: "real" | "generated"; sourceImageId: string | null; view?: [number, number, number] };
type SpinData = { w: number; h: number; ring: typeof RING; frames: SpinFrame[] };

const DEG_PER_PX = 0.35;
const FRICTION = 0.92;
const WHEEL_DEG_PER_PX = 0.25;

function bucketFor(az: number): ViewBucket {
  const a = Math.abs((((az + 180) % 360) + 360) % 360 - 180); // 0 front .. 180 rear, either side
  return a < 25 ? "front" : a < 70 ? "front_34" : a < 110 ? "side" : a < 155 ? "rear_34" : "rear";
}

export default function SpinViewer(props: {
  asset: Listing3DAsset;
  tags: Listing3DTag[];
  selectedTagId: string | null;
  onSelectTag: (id: string | null) => void;
  onViewChange?: (b: ViewBucket) => void;
  goto?: { azimuth: number; n: number } | null; // preset jumps (n changes on every click)
}) {
  const base = props.asset.storageKey!.replace(/spin\.json$/, "");
  const [data, setData] = useState<SpinData | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [angle, setAngle] = useState(45);
  const images = useRef<HTMLImageElement[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const motion = useRef({ dragging: false, lastX: 0, v: 0, target: null as number | null, raf: 0 });
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    let cancelled = false;
    fetch(props.asset.storageKey!)
      .then((r) => r.json())
      .then(async (d: SpinData) => {
        if (cancelled) return;
        setData(d);
        images.current = d.frames.map(() => new Image());
        await Promise.all(d.frames.map(async (f, i) => {
          const im = images.current[i];
          im.src = base + f.file;
          await im.decode().catch(() => undefined); // decode off the main thread before first draw
          if (!cancelled) setLoaded((n) => n + 1);
        }));
      })
      .catch((e) => setError(String(e)));
    return () => { cancelled = true; };
  }, [props.asset.storageKey, base]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Momentum + preset easing loop.
  useEffect(() => {
    const m = motion.current;
    const tick = () => {
      if (!m.dragging) {
        if (m.target != null) {
          const diff = ((((m.target - angleRef.current) % 360) + 540) % 360) - 180;
          if (Math.abs(diff) < 0.2) m.target = null;
          else setAngle((a) => a + diff * 0.15);
        } else if (Math.abs(m.v) > 0.01) {
          setAngle((a) => a + m.v);
          m.v *= FRICTION;
        }
      }
      m.raf = requestAnimationFrame(tick);
    };
    m.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(m.raf);
  }, []);
  const angleRef = useRef(angle);
  angleRef.current = angle;

  useEffect(() => {
    if (props.goto) motion.current.target = props.goto.azimuth;
  }, [props.goto]);

  const n = data?.frames.length ?? 1;
  const step = 360 / n;
  const a = ((angle % 360) + 360) % 360;
  const i0 = Math.floor(a / step) % n;
  const i1 = (i0 + 1) % n;
  const t = a / step - Math.floor(a / step);
  const nearest = t < 0.5 ? i0 : i1;

  useEffect(() => props.onViewChange?.(bucketFor(a)), [bucketFor(a)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draw: contain-fit, cross-fade between the two frames around the current angle.
  const fit = data ? Math.min(size.w / data.w, size.h / data.h) : 1;
  const dw = data ? data.w * fit : 0, dh = data ? data.h * fit : 0;
  const dx = (size.w - dw) / 2, dy = (size.h - dh) / 2;
  // Resizing a canvas reallocates its buffer, so only do it when the viewport size changes, never per frame.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    c.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [size]);

  // Trackpad / wheel spins the truck. Native listener so the page can't scroll or swipe-navigate underneath;
  // macOS already sends momentum as wheel events, so no extra inertia here.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const m = motion.current;
      m.target = null;
      m.v = 0;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setAngle((x) => x + d * WHEEL_DEG_PER_PX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !data) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, size.w, size.h);
    const a0 = images.current[i0], a1 = images.current[i1];
    if (a0?.complete) {
      ctx.globalAlpha = 1;
      ctx.drawImage(a0, dx, dy, dw, dh);
    }
    if (a1?.complete && t > 0.02) {
      ctx.globalAlpha = t;
      ctx.drawImage(a1, dx, dy, dw, dh);
    }
    ctx.globalAlpha = 1;
  }, [data, i0, i1, t, size, loaded, dx, dy, dw, dh]);

  // Tag projection through the nearest frame's ring camera (viewer units -> ring world via the asset scale).
  const k = props.asset.transform?.scale ?? 1;
  const ring = data?.ring ?? RING;
  const tagPoints = data
    ? props.tags.flatMap((tag) => {
        const m = poseFor(data.frames[nearest].azimuth, ring);
        const w = tag.position.map((v) => v / k);
        const rel = [w[0] - m[0][3], w[1] - m[1][3], w[2] - m[2][3]];
        const cam = [0, 1, 2].map((c) => rel[0] * m[0][c] + rel[1] * m[1][c] + rel[2] * m[2][c]); // R^T (world - cam)
        const center = [ring.target[0] - m[0][3], ring.target[1] - m[1][3], ring.target[2] - m[2][3]];
        const centerZ = center[0] * m[0][2] + center[1] * m[1][2] + center[2] * m[2][2];
        if (cam[2] >= 0 || cam[2] < centerZ - 0.05) return []; // behind camera, or on the far side of the vehicle
        // Ring-camera pixel, then the frame's zoom/crop about (vx, vy), then output resolution.
        const fl = focalPx(ring);
        const [z, vx, vy] = data.frames[nearest].view ?? [1, ring.w / 2, ring.h / 2];
        const px = ((ring.w / 2 + (fl * cam[0]) / -cam[2] - vx) * z + ring.w / 2) * (data.w / ring.w);
        const py = ((ring.h / 2 - (fl * cam[1]) / -cam[2] - vy) * z + ring.h / 2) * (data.h / ring.h);
        return [{ tag, x: dx + px * fit, y: dy + py * fit }];
      })
    : [];

  const onDown = (e: React.PointerEvent) => {
    const m = motion.current;
    m.dragging = true;
    m.lastX = e.clientX;
    m.v = 0;
    m.target = null;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const m = motion.current;
    if (!m.dragging) return;
    const d = (e.clientX - m.lastX) * DEG_PER_PX;
    m.lastX = e.clientX;
    m.v = d;
    setAngle((x) => x - d); // drag right = truck turns right
  };
  const onUp = () => { motion.current.dragging = false; };

  const frame = data?.frames[nearest];
  return (
    <div
      ref={wrap}
      className="spin"
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") motion.current.target = angle + step;
        if (e.key === "ArrowRight") motion.current.target = angle - step;
      }}
      onClick={(e) => e.target === canvas.current && props.onSelectTag(null)}
    >
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
      {tagPoints.map(({ tag, x, y }) => (
        <button key={tag.id} className={`tag ${tag.id === props.selectedTagId ? "selected" : ""}`} style={{ position: "absolute", left: x, top: y, transform: "translate(-50%, -50%)" }}
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); props.onSelectTag(tag.id); }}>
          <span className="dot" />
          <span className="lbl">{tag.label}</span>
        </button>
      ))}
      {frame && <div className={`spin-badge ${frame.source}`}>{frame.source === "real" ? "Real listing photo" : "AI-generated angle"} · {Math.round(a)}°</div>}
      {error && <div className="viewport-state center">Spin failed to load: {error}</div>}
      {data && loaded < n && <div className="spin-loading">Loading frames {loaded}/{n}</div>}
    </div>
  );
}
