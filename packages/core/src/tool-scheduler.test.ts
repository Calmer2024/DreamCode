import { createDefaultToolRegistry } from "@dreamcode/tools";
import { describe, expect, it } from "vitest";
import { buildToolCallWaves, mapWithConcurrency } from "./tool-scheduler";

const context = {
  workspaceRoot: process.cwd(),
  sessionDir: process.cwd(),
  mode: "yolo" as const,
  toolCallId: "scheduler",
};

describe("ToolScheduler", () => {
  it("groups consecutive parallel calls and keeps exclusive barriers", () => {
    const registry = createDefaultToolRegistry();
    const calls = [
      { id: "1", name: "file.read", input: { file_path: "a" } },
      { id: "2", name: "search.grep", input: { pattern: "b" } },
      { id: "3", name: "file.write", input: { path: "c", content: "c" } },
      { id: "4", name: "file.read", input: { file_path: "c" } },
    ];

    expect(
      buildToolCallWaves(registry, calls, context).map((wave) => ({
        mode: wave.mode,
        ids: wave.calls.map((call) => call.toolCall.id),
      })),
    ).toEqual([
      { mode: "parallel", ids: ["1", "2"] },
      { mode: "exclusive", ids: ["3"] },
      { mode: "parallel", ids: ["4"] },
    ]);
  });

  it("bounds concurrency while retaining input order", async () => {
    let active = 0;
    let maximum = 0;
    const output = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value * 2;
    });
    expect(maximum).toBe(2);
    expect(output).toEqual([2, 4, 6, 8]);
  });
});
