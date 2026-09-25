import { test } from "node:test";
import assert from "node:assert/strict";
import { addTag, deleteTag, forAssetVersion, updateTag } from "./tags.ts";

test("tags stay bound to their asset version and keep order dense", () => {
  let tags = addTag([], "asset-v1", [1.23456, 0, -2]);
  tags = addTag(tags, "asset-v1", [0, 1, 0], "Cab");
  tags = addTag(tags, "asset-v2", [0, 0, 0]);

  assert.deepEqual(tags[0].position, [1.235, 0, -2]);
  assert.equal(tags[1].label, "New Cab");
  assert.equal(forAssetVersion(tags, "asset-v1").length, 2);
  assert.equal(forAssetVersion(tags, "asset-v2").length, 1);

  tags = updateTag(tags, tags[0].id, { label: "Pump Panel", assetVersionId: "hijack" } as never);
  assert.equal(tags[0].label, "Pump Panel");
  assert.equal(tags[0].assetVersionId, "asset-v1", "assetVersionId is immutable through updateTag");

  tags = deleteTag(tags, tags[0].id);
  assert.deepEqual(forAssetVersion(tags, "asset-v1").map((t) => t.order), [0]);
});
