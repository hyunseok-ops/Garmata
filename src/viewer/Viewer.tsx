import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Listing3DAsset, Listing3DTag, Vec3 } from "../data/types.ts";
import IllustrativeTruck from "./IllustrativeTruck.tsx";

export type Pose = { position: Vec3; target: Vec3 };
export const PRESETS: Record<"Reset" | "Front" | "Rear" | "Left" | "Right", Pose> = {
  Reset: { position: [9, 5, 9], target: [0, 1.4, 0] },
  Front: { position: [13, 2.5, 0], target: [0, 1.4, 0] },
  Rear: { position: [-13, 2.5, 0], target: [0, 1.4, 0] },
  Left: { position: [0, 2.5, 13], target: [0, 1.4, 0] },
  Right: { position: [0, 2.5, -13], target: [0, 1.4, 0] },
};

const MAX_ASSET_BYTES = 100 * 1024 * 1024;

export async function validateAssetUrl(url: string): Promise<string | null> {
  if (!/\.glb(\?|$)/i.test(url)) return "Unsupported asset type; only .glb is rendered.";
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return `Asset not reachable (${res.status}).`;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_ASSET_BYTES) return `Asset too large (${(len / 1e6).toFixed(0)} MB).`;
    return null;
  } catch {
    return "Asset not reachable.";
  }
}

function Glb({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return <primitive object={scene} />;
}

// Eases camera + target toward a requested pose, then hands control back to OrbitControls.
function CameraRig({ pose, controls }: { pose: Pose | null; controls: React.RefObject<OrbitControlsImpl | null> }) {
  const { camera } = useThree();
  const goal = useRef<Pose | null>(null);
  useEffect(() => void (goal.current = pose), [pose]);
  useFrame(() => {
    const g = goal.current;
    const c = controls.current;
    if (!g || !c) return;
    camera.position.lerp(new THREE.Vector3(...g.position), 0.12);
    c.target.lerp(new THREE.Vector3(...g.target), 0.12);
    c.update();
    if (camera.position.distanceTo(new THREE.Vector3(...g.position)) < 0.02) goal.current = null;
  });
  return null;
}

// Own occlusion test: drei's `occlude` has no tolerance, so tags placed on a surface read as hidden.
function TagMarker({ tag, selected, onSelect, model }: { tag: Listing3DTag; selected: boolean; onSelect: () => void; model: React.RefObject<THREE.Group | null> }) {
  const [hidden, setHidden] = useState(false);
  const { camera } = useThree();
  const ray = useRef(new THREE.Raycaster());
  useFrame(() => {
    if (!model.current) return;
    const p = model.current.localToWorld(new THREE.Vector3(...tag.position));
    const dist = p.distanceTo(camera.position);
    ray.current.set(camera.position, p.sub(camera.position).normalize());
    const hit = ray.current.intersectObject(model.current, true)[0];
    const h = !!hit && hit.distance < dist - 0.15;
    if (h !== hidden) setHidden(h);
  });
  return (
    <Html position={tag.position} center zIndexRange={[10, 0]} style={{ pointerEvents: hidden ? "none" : "auto" }}>
      <button
        className={`tag ${selected ? "selected" : ""}`}
        style={{ opacity: hidden ? 0.15 : 1 }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title={tag.label}
      >
        <span className="dot" />
        <span className="lbl">{tag.label}</span>
      </button>
    </Html>
  );
}

class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function Viewer(props: {
  asset: Listing3DAsset;
  tags: Listing3DTag[];
  selectedTagId: string | null;
  onSelectTag: (id: string | null) => void;
  placing: boolean;
  onPlace: (position: Vec3) => void;
  pose: Pose | null;
  onCapturePose?: (capture: () => Pose) => void;
}) {
  const controls = useRef<OrbitControlsImpl | null>(null);
  const model = useRef<THREE.Group>(null);

  useEffect(() => {
    props.onCapturePose?.(() => {
      const c = controls.current!;
      return { position: c.object.position.toArray() as Vec3, target: c.target.toArray() as Vec3 };
    });
  }, [props.onCapturePose]);

  const onModelClick = (e: ThreeEvent<MouseEvent>) => {
    if (!props.placing || !model.current) return;
    e.stopPropagation();
    props.onPlace(model.current.worldToLocal(e.point.clone()).toArray() as Vec3);
  };

  const renderable = props.asset.format === "procedural" || props.asset.storageKey;

  return (
    <Canvas shadows camera={{ position: PRESETS.Reset.position, fov: 45 }} onPointerMissed={() => props.onSelectTag(null)} style={{ cursor: props.placing ? "crosshair" : "grab" }}>
      <color attach="background" args={["#15161a"]} />
      <hemisphereLight intensity={0.6} groundColor="#222" />
      <directionalLight position={[10, 12, 6]} intensity={1.6} castShadow shadow-mapSize={1024} />
      <gridHelper args={[40, 40, "#2c2e35", "#22242a"]} position={[0, 0.001, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <shadowMaterial opacity={0.35} />
      </mesh>

      <group ref={model} onClick={onModelClick}>
        {renderable ? (
          <ErrorBoundary fallback={<Html center><div className="viewport-state">Unsupported or corrupt asset. Original photos remain available.</div></Html>}>
            <Suspense fallback={<Html center><div className="viewport-state">Loading model…</div></Html>}>
              {props.asset.format === "glb" ? <Glb url={props.asset.storageKey!} /> : <IllustrativeTruck />}
            </Suspense>
          </ErrorBoundary>
        ) : (
          <Html center><div className="viewport-state">No renderable asset for this version.</div></Html>
        )}
      </group>

      {props.tags.map((t) => (
        <TagMarker key={t.id} tag={t} model={model} selected={t.id === props.selectedTagId} onSelect={() => props.onSelectTag(t.id)} />
      ))}

      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.1} minDistance={3} maxDistance={40} maxPolarAngle={Math.PI / 2 - 0.02} target={PRESETS.Reset.target} />
      <CameraRig pose={props.pose} controls={controls} />
    </Canvas>
  );
}
