import { test } from "node:test";
import assert from "node:assert/strict";
import { pickGenerationPhotos } from "./photos.ts";

test("generation inputs are distinct exterior views, max 4, interiors excluded", () => {
  const p = (id: string, viewLabel?: string) => ({ id, url: id, viewLabel });
  const photos = [p("a", "cab_interior"), p("b", "side"), p("c", "side"), p("d", "front_34"), p("e", "rear"), p("f", "rear_34"), p("g", "front"), p("h", "pump_panel")];
  assert.deepEqual(pickGenerationPhotos(photos).map((x) => x.id), ["d", "b", "f", "e"]);
  assert.deepEqual(pickGenerationPhotos([p("x"), p("y")]).map((x) => x.id), ["x", "y"], "unlabelled legacy photos fall through");
  assert.deepEqual(pickGenerationPhotos([p("a", "cab_interior")]), []);
});
