import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneSplatPly } from "./ply.ts";

test("prune drops transparent and out-of-ring splats and rewrites the vertex count", () => {
  const names = ["x", "y", "z", "opacity", "f_dc_0"];
  const rows = [
    [0, 0.3, 0, 2, 1], // opaque, centre: keep
    [0, 0.3, 0, -6, 1], // ~0.25% opacity: drop
    [3, 0.3, 0, 2, 1], // outside radius: drop
    [0, 5, 0, 2, 1], // above the vehicle: drop
    [0.5, 0.1, -0.4, 0, 1], // 50% opacity, inside: keep
  ];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${names.map((n) => `property float ${n}\n`).join("")}end_header\n`;
  const body = Buffer.alloc(rows.length * names.length * 4);
  rows.flat().forEach((v, i) => body.writeFloatLE(v, i * 4));
  const r = pruneSplatPly(Buffer.concat([Buffer.from(header), body]), { minOpacity: 0.05, maxRadius: 1.5, minY: -0.2, maxY: 1.5 });
  assert.equal(r.total, 5);
  assert.equal(r.kept, 2);
  assert.match(r.data.toString("latin1", 0, 200), /element vertex 2\n/);
  const headerLen = r.data.indexOf("end_header\n") + 11;
  assert.equal(r.data.length - headerLen, 2 * names.length * 4);
  assert.equal(r.data.readFloatLE(headerLen + names.length * 4), 0.5); // second kept row is the 50% one
});
