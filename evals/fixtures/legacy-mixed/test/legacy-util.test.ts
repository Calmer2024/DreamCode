import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanName } from "../src/legacy-util.ts";

test("cleanName keeps the public behavior", () => {
  assert.equal(cleanName("  Ada Lovelace "), "ada lovelace");
});
