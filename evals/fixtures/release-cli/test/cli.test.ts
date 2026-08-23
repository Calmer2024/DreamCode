import assert from "node:assert/strict";
import { test } from "node:test";
import { validateManifest } from "../src/cli.ts";

test("requires name and version", () => {
  assert.deepEqual(validateManifest({}), ["name is required", "version is required"]);
  assert.deepEqual(validateManifest({ name: "demo", version: "1.0.0" }), []);
});
