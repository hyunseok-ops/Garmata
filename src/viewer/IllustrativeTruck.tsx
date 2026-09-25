// Procedural pumper silhouette. Explicitly an "Illustrative model": proportions are generic, not the listing's.
// Faces +X; driver side is +Z. Replace with a licensed GLB template per plan §4 when one is acquired.

const red = "#b3161b";
const dark = "#1f1f22";
const chrome = "#c9ccd1";

function Wheel({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0.55, z]} rotation={[Math.PI / 2, 0, 0]}>
      <mesh castShadow>
        <cylinderGeometry args={[0.55, 0.55, 0.4, 24]} />
        <meshStandardMaterial color={dark} roughness={0.9} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[0.3, 0.3, 0.42, 16]} />
        <meshStandardMaterial color={chrome} metalness={0.6} roughness={0.3} />
      </mesh>
    </group>
  );
}

export default function IllustrativeTruck() {
  return (
    <group>
      {/* chassis */}
      <mesh position={[0, 0.7, 0]} castShadow>
        <boxGeometry args={[8, 0.3, 1.6]} />
        <meshStandardMaterial color={dark} />
      </mesh>
      {/* cab */}
      <mesh position={[2.9, 1.7, 0]} castShadow>
        <boxGeometry args={[2.2, 1.9, 2.5]} />
        <meshStandardMaterial color={red} roughness={0.35} />
      </mesh>
      <mesh position={[3.4, 2.1, 0]}>
        <boxGeometry args={[1.25, 0.8, 2.3]} />
        <meshStandardMaterial color="#5b7f99" metalness={0.4} roughness={0.15} />
      </mesh>
      {/* light bar */}
      <mesh position={[3.2, 2.75, 0]}>
        <boxGeometry args={[0.3, 0.2, 2]} />
        <meshStandardMaterial color="#e8b400" emissive="#e8b400" emissiveIntensity={0.4} />
      </mesh>
      {/* bumper */}
      <mesh position={[4.1, 0.7, 0]}>
        <boxGeometry args={[0.2, 0.4, 2.5]} />
        <meshStandardMaterial color={chrome} metalness={0.7} roughness={0.3} />
      </mesh>
      {/* pump house */}
      <mesh position={[0.6, 1.6, 0]} castShadow>
        <boxGeometry args={[1.6, 1.8, 2.6]} />
        <meshStandardMaterial color={red} roughness={0.35} />
      </mesh>
      <mesh position={[0.6, 1.6, 1.31]}>
        <boxGeometry args={[1.3, 1.3, 0.05]} />
        <meshStandardMaterial color={chrome} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* body / compartments */}
      <mesh position={[-1.85, 1.55, 0]} castShadow>
        <boxGeometry args={[3.5, 1.7, 2.6]} />
        <meshStandardMaterial color={red} roughness={0.35} />
      </mesh>
      {[-2.6, -1.1].map((x) =>
        [1.31, -1.31].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 1.5, z]}>
            <boxGeometry args={[1.2, 1.3, 0.04]} />
            <meshStandardMaterial color={chrome} metalness={0.5} roughness={0.4} />
          </mesh>
        )),
      )}
      {/* hose bed */}
      <mesh position={[-1.3, 2.55, 0]}>
        <boxGeometry args={[4.5, 0.3, 2.2]} />
        <meshStandardMaterial color={dark} />
      </mesh>
      {/* rear step */}
      <mesh position={[-3.75, 0.75, 0]}>
        <boxGeometry args={[0.4, 0.15, 2.4]} />
        <meshStandardMaterial color={chrome} metalness={0.6} roughness={0.4} />
      </mesh>
      <Wheel x={2.6} z={0.95} />
      <Wheel x={2.6} z={-0.95} />
      <Wheel x={-2.2} z={0.95} />
      <Wheel x={-2.2} z={-0.95} />
    </group>
  );
}
