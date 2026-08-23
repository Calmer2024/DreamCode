import assert from "node:assert/strict";
import { test } from "node:test";
import { countOpenTasks, listTasks } from "../src/services/task-service.ts";

test("filters tasks by status without mutating them", () => {
  assert.deepEqual(
    listTasks("open").map((task) => task.id),
    ["t-1", "t-3"],
  );
  assert.equal(countOpenTasks(), 2);
});

test("returns no tasks for an unknown status", () => {
  assert.deepEqual(listTasks("missing"), []);
});
