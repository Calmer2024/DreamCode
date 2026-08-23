import assert from "node:assert/strict";
import { test } from "node:test";
import { greeting } from "../src/app.ts";

test("greeting", () => assert.equal(greeting("Ada"), "Hello, Ada!"));
