import fs from "node:fs";

// Gaussian-splat .ply cleanup at import (binary_little_endian, float32 vertex properties as written by ns-export).
// Drops splats that are nearly transparent or outside the region the camera ring can see; both are floaters by
// construction, and each one costs sort + raster time in the viewer.
export type PruneOptions = { minOpacity: number; maxRadius: number; minY: number; maxY: number };

export function pruneSplatPly(input: Buffer, o: PruneOptions): { data: Buffer; kept: number; total: number } {
  const headerEnd = input.indexOf("end_header\n") + "end_header\n".length;
  const header = input.subarray(0, headerEnd).toString("latin1");
  if (!header.includes("format binary_little_endian")) throw new Error("expected binary_little_endian ply");
  const total = Number(/element vertex (\d+)/.exec(header)![1]);
  const props = [...header.matchAll(/^property (\w+) (\w+)$/gm)].map((m) => ({ type: m[1], name: m[2] }));
  if (props.some((p) => p.type !== "float")) throw new Error("expected float32 vertex properties");
  const stride = props.length * 4;
  const at = (name: string) => props.findIndex((p) => p.name === name) * 4;
  const [ix, iy, iz, iop] = ["x", "y", "z", "opacity"].map(at);
  const body = input.subarray(headerEnd, headerEnd + total * stride);
  const keep: number[] = [];
  const logitMin = Math.log(o.minOpacity / (1 - o.minOpacity)); // opacity is stored as a logit
  for (let i = 0; i < total; i++) {
    const b = i * stride;
    const x = body.readFloatLE(b + ix), y = body.readFloatLE(b + iy), z = body.readFloatLE(b + iz);
    if (body.readFloatLE(b + iop) >= logitMin && Math.hypot(x, z) <= o.maxRadius && y >= o.minY && y <= o.maxY) keep.push(i);
  }
  const out = Buffer.alloc(keep.length * stride);
  keep.forEach((i, j) => body.copy(out, j * stride, i * stride, (i + 1) * stride));
  return { data: Buffer.concat([Buffer.from(header.replace(/element vertex \d+/, `element vertex ${keep.length}`), "latin1"), out]), kept: keep.length, total };
}

export function pruneSplatFile(src: string, dst: string, o: PruneOptions) {
  const r = pruneSplatPly(fs.readFileSync(src), o);
  fs.writeFileSync(dst, r.data);
  return r;
}
