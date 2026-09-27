import { test } from "node:test";
import assert from "node:assert/strict";
import { azimuthFor, buildSplit, buildTransforms, planRing, poseFor, ringAzimuths, validatePosed } from "./novel.ts";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("cameras sit on the ring, face the target, and match the viewer frame", () => {
  const front = poseFor(0);
  close(front[0][3], 2.5); close(front[2][3], 0); // front camera on +X
  const left = poseFor(90);
  close(left[2][3], 2.5); close(left[0][3], 0); // driver-side camera on +Z
  for (const az of ringAzimuths()) {
    const m = poseFor(az);
    const p = [m[0][3], m[1][3], m[2][3]];
    const forward = [-m[0][2], -m[1][2], -m[2][2]]; // OpenGL looks down -Z
    const toTarget = [0 - p[0], 0.35 - p[1], 0 - p[2]];
    const l = Math.hypot(...toTarget);
    close(forward.reduce((s, v, i) => s + v * (toTarget[i] / l), 0), 1);
    close(m[1][1] > 0 ? 1 : 0, 1); // up vector points up
  }
});

test("real photos take their ring slots, everything else is generated", () => {
  const p = (id: string, viewLabel: string) => ({ id, url: id, viewLabel });
  const views = planRing([p("a", "cab_interior"), p("b", "side"), p("c", "side"), p("d", "front"), p("e", "rear_34")]);
  assert.equal(views.length, 24);
  assert.deepEqual(views.filter((v) => v.source === "real").map((v) => [v.azimuth, v.sourceImageId]), [[0, "d"], [90, "b"], [135, "e"]]);
  const split = buildSplit(views);
  assert.deepEqual(split.train_ids, [0, 6, 9]);
  assert.equal(split.test_ids.length, 21);
  const t = buildTransforms(views);
  assert.equal(t.frames[6].file_path, "images/090.png");
  assert.equal(t.frames[1].file_path, null);
});

test("posed validation catches missing images, bad matrices and bad ordering", () => {
  const views = planRing([{ id: "x", url: "x", viewLabel: "front" }]);
  const t = buildTransforms(views);
  assert.ok(validatePosed(t, 24).some((e) => e.includes("has no image")));
  const filled = { ...t, frames: t.frames.map((f, i) => ({ ...f, file_path: `images/${i}.png` })) };
  assert.deepEqual(validatePosed(filled, 24), []);
  const swapped = { ...filled, frames: [filled.frames[1], filled.frames[0], ...filled.frames.slice(2)] };
  assert.ok(validatePosed(swapped, 24).some((e) => e.includes("increasing")));
  const broken = { ...filled, frames: filled.frames.map((f, i) => (i === 3 ? { ...f, transform_matrix: [[1]] } : f)) };
  assert.ok(validatePosed(broken as never, 24).some((e) => e.includes("4x4")));
});

test("photos where the front points left sit on the officer side; unknowns follow the majority", () => {
  assert.equal(azimuthFor("front_34", { front_34: "left" }), 315);
  assert.equal(azimuthFor("rear_34", { rear_34: "left" }), 225);
  assert.equal(azimuthFor("side", { front_34: "left", rear_34: "left" }), 270); // side unknown -> majority
  assert.equal(azimuthFor("side", {}), 90);
  assert.equal(azimuthFor("front", { front_34: "left" }), 0);
  const p = (id: string, viewLabel: string) => ({ id, url: id, viewLabel });
  const views = planRing([p("f", "front"), p("f34", "front_34"), p("s", "side"), p("r34", "rear_34"), p("r", "rear")], { front_34: "left", side: "left", rear_34: "left" });
  assert.deepEqual(views.filter((v) => v.source === "real").map((v) => [v.azimuth, v.sourceImageId]), [[0, "f"], [180, "r"], [225, "r34"], [270, "s"], [315, "f34"]]);
  const overridden = planRing([p("s", "side")], {}, { side: 270 });
  assert.equal(overridden.find((v) => v.source === "real")?.azimuth, 270);
});
