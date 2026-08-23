import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePort } from "../src/target.ts";

test("normalizes an invalid port", () => assert.equal(normalizePort("not-a-port"), 3000));
