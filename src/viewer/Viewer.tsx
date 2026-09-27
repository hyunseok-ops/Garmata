import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Bvh, ContactShadows, Environment, Html, OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
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
  if (url.startsWith("gi-asset://")) return null; // main process validated and stored it
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

// Normalizes any GLB into the viewer's frame: longest side = 8 units, centered on x/z, resting on y=0.
// Deterministic from geometry, so tag coordinates stay reproducible for the same asset version.
function Glb({ url, transform }: { url: string; transform?: Listing3DAsset["transform"] }) {
  const { scene } = useGLTF(url);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const k = 8 / Math.max(size.x, size.y, size.z, 1e-6);
  const c = box.getCenter(new THREE.Vector3());
  // Meshes auto-fit; the reviewed transform only supplies yaw (generators don't agree on which way is forward).
  const yaw = ((transform?.rotationDeg[1] ?? 0) * Math.PI) / 180;
  return (
    <group rotation={[0, yaw, 0]}>
      <primitive object={scene} scale={k} position={[-c.x * k, -box.min.y * k, -c.z * k]} />
    </group>
  );
}

// Gaussian splat (Nerfstudio Splatfacto export). Appearance only: no mesh, so tag occlusion raycasts pass through it.
function Splat({ url, transform }: { url: string; transform?: Listing3DAsset["transform"] }) {
  const { scene, gl } = useThree();
  useEffect(() => {
    const spark = new SparkRenderer({ renderer: gl });
    const mesh = new SplatMesh({ url });
    // Nerfstudio/COLMAP exports are y-down; default flip gives y-up. The reviewed transform refines scale/offset/yaw.
    const t = transform ?? { scale: 1, position: [0, 0, 0] as Vec3, rotationDeg: [180, 0, 0] as Vec3 };
    mesh.rotation.set(...(t.rotationDeg.map((d) => (d * Math.PI) / 180) as Vec3));
    mesh.scale.setScalar(t.scale);
    mesh.position.set(...t.position);
    scene.add(spark, mesh);
    return () => {
      scene.remove(spark, mesh);
      mesh.dispose();
    };
  }, [scene, gl, url, transform]);
  return null;
}

export type ViewBucket = "front" | "front_34" | "side" | "rear_34" | "rear";

// Which labelled listing view best matches the current camera angle. Vehicle faces +X.
function bucketFor(camera: THREE.Camera): ViewBucket {
  const az = Math.abs((Math.atan2(camera.position.z, camera.position.x) * 180) / Math.PI); // 0 = front, 180 = rear
  return az < 25 ? "front" : az < 70 ? "front_34" : az < 110 ? "side" : az < 155 ? "rear_34" : "rear";
}

function ViewReporter({ onChange }: { onChange: (b: ViewBucket) => void }) {
  const { camera } = useThree();
  const last = useRef<ViewBucket | null>(null);
  useFrame(() => {
    const b = bucketFor(camera);
    if (b !== last.current) {
      last.current = b;
      onChange(b);
    }
  });
  return null;
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
// Occlusion is a visual hint, not per-frame critical: re-test at most ~8x/s and only after the camera moved.
// Raycasts go through the model's BVH (<Bvh> below), so each test is cheap even on 500k-triangle meshes.
const OCCLUSION_INTERVAL_MS = 120;
function TagMarker({ tag, selected, onSelect, model }: { tag: Listing3DTag; selected: boolean; onSelect: () => void; model: React.RefObject<THREE.Group | null> }) {
  const [hidden, setHidden] = useState(false);
  const { camera } = useThree();
  const st = useRef({ ray: new THREE.Raycaster(), p: new THREE.Vector3(), lastCam: new THREE.Vector3(Infinity, 0, 0), lastAt: 0 });
  useFrame(() => {
    const s = st.current;
    const now = performance.now();
    if (!model.current || now - s.lastAt < OCCLUSION_INTERVAL_MS || camera.position.distanceToSquared(s.lastCam) < 1e-6) return;
    s.lastAt = now;
    s.lastCam.copy(camera.position);
    const p = model.current.localToWorld(s.p.set(...tag.position));
    const dist = p.distanceTo(camera.position);
    s.ray.firstHitOnly = true;
    s.ray.set(camera.position, p.sub(camera.position).normalize());
    const hit = s.ray.intersectObject(model.current, true)[0];
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
  onViewChange?: (bucket: ViewBucket) => void;
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
  const isSplat = props.asset.format === "splat";

  return (
    // Splats: no shadow maps, and a 1.5x pixel-ratio cap (splat cost scales with pixels x splats).
    <Canvas shadows={!isSplat} dpr={isSplat ? [1, 1.5] : [1, 2]} gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05, powerPreference: "high-performance" }} camera={{ position: PRESETS.Reset.position, fov: 45 }} onPointerMissed={() => props.onSelectTag(null)} style={{ cursor: props.placing ? "crosshair" : "grab" }}>
      <color attach="background" args={["#15161a"]} />
      <Suspense fallback={<hemisphereLight intensity={1} groundColor="#222" />}>
        <Environment preset="city" environmentIntensity={0.9} />
      </Suspense>
      <directionalLight position={[10, 12, 6]} intensity={1.2} castShadow={!isSplat} shadow-mapSize={2048} />
      {/* Splats carry their own photographed ground and surroundings; synthetic floor cues only fight them. */}
      {!isSplat && <gridHelper args={[40, 40, "#2c2e35", "#22242a"]} position={[0, 0.001, 0]} />}
      {!isSplat && <ContactShadows frames={1} position={[0, 0, 0]} opacity={0.6} scale={30} blur={2.2} far={6} /> /* static model: bake once, not every frame */}

      <Bvh firstHitOnly>
      <group ref={model} onClick={onModelClick}>
        {renderable ? (
          <ErrorBoundary fallback={<Html center><div className="viewport-state">Unsupported or corrupt asset. Original photos remain available.</div></Html>}>
            <Suspense fallback={<Html center><div className="viewport-state">Loading model…</div></Html>}>
              {props.asset.format === "glb" ? <Glb url={props.asset.storageKey!} transform={props.asset.transform} /> : props.asset.format === "splat" ? <Splat url={props.asset.storageKey!} transform={props.asset.transform} /> : <IllustrativeTruck />}
            </Suspense>
          </ErrorBoundary>
        ) : (
          <Html center><div className="viewport-state">No renderable asset for this version.</div></Html>
        )}
      </group>
      </Bvh>

      {props.tags.map((t) => (
        <TagMarker key={t.id} tag={t} model={model} selected={t.id === props.selectedTagId} onSelect={() => props.onSelectTag(t.id)} />
      ))}

      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.1} minDistance={3} maxDistance={40} maxPolarAngle={Math.PI / 2 - 0.02} target={PRESETS.Reset.target} />
      <CameraRig pose={props.pose} controls={controls} />
      {props.onViewChange && <ViewReporter onChange={props.onViewChange} />}
    </Canvas>
  );
}
