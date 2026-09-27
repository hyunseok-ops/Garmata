import { useEffect } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { desktop } from "../data/garageApi.ts";
import { estimatedVehicleLength, focalPx, poseFor, RING, ringAzimuths } from "../data/novel.ts";

// posed-test (hidden window): renders an existing model from the exact ring cameras in src/data/novel.ts and streams
// the frames to the main process. Same pose code feeds SEVA and Splatfacto, so a clean test splat proves the camera
// convention end to end.
export default function RingRender({ assetId }: { assetId: string }) {
  useEffect(() => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    // Transparent background: Splatfacto learns alpha-0 pixels as empty space instead of filling it with white splats.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(1);
    renderer.setSize(RING.w, RING.h, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(4, 6, 3);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera((2 * Math.atan(RING.h / 2 / focalPx()) * 180) / Math.PI, RING.w / RING.h, 0.01, 100);
    camera.matrixAutoUpdate = false;

    new GLTFLoader().load(
      `gi-asset://${assetId}`,
      async (gltf) => {
        try {
          const model = gltf.scene;
          // Same normalization as the viewer, but sized to the ring's assumed vehicle length; front faces +X.
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const k = estimatedVehicleLength() / Math.max(size.x, size.y, size.z);
          const c = box.getCenter(new THREE.Vector3());
          model.scale.setScalar(k);
          model.position.set(-c.x * k, -box.min.y * k, -c.z * k);
          const yawGroup = new THREE.Group();
          yawGroup.rotation.y = Math.PI; // legacy meshes face -X (see Viewer Glb transform)
          yawGroup.add(model);
          scene.add(yawGroup);
          for (const az of ringAzimuths()) {
            const m = poseFor(az);
            camera.matrix.set(...(m.flat() as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
            camera.matrixWorld.copy(camera.matrix);
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
            camera.updateProjectionMatrix();
            renderer.render(scene, camera);
            desktop?.ringFrame(az, canvas.toDataURL("image/png"));
            await new Promise((r) => setTimeout(r, 10));
          }
          desktop?.ringDone();
        } catch (e) {
          desktop?.ringDone((e as Error).message);
        }
      },
      undefined,
      (e) => desktop?.ringDone(String((e as ErrorEvent)?.message ?? e)),
    );
    return () => renderer.dispose();
  }, [assetId]);
  return null;
}
