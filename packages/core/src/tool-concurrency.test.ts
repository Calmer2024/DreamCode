import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeModelProvider } from "@dreamcode/models";
import type { Tool } from "@dreamcode/shared";
import { createDefaultToolRegistry, ToolRegistry } from "@dreamcode/tools";
import { describe, expect, it } from "vitest";
import { runTurn } from "./index";

describe("runTurn multi-tool scheduling", () => {
  it("executes independent calls from one assistant message concurrently", async () => {
    const registry = new ToolRegistry();
    let active = 0;
    let maximum = 0;
    const delayTool: Tool = {
      name: "test.delay_read",
      description: "test",
      inputSchema: createDefaultToolRegistry().get("job_list")!.inputSchema,
      risk: { tags: [] },
      schedule: { mode: "parallel" },
      async execute(rawInput, context) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return {
          toolCallId: context.toolCallId,
          status: "success",
          summary: "done",
          data: rawInput,
        };
      },
    };
    registry.register(delayTool);
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-parallel-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-parallel-home-"));
    const provider = new FakeModelProvider([
      {
        toolCalls: [
          { id: "parallel_1", name: delayTool.name, input: { value: 1 } },
          { id: "parallel_2", name: delayTool.name, input: { value: 2 } },
        ],
      },
      { text: "done" },
    ]);

    const events = [];
    for await (const event of runTurn({
      prompt: "run both independent checks",
      workspaceRoot,
      home,
      provider,
      registry,
      mode: "full",
    }))
      events.push(event);

    expect(maximum).toBe(2);
    expect(events.find((event) => event.type === "tool.schedule.planned")?.payload).toMatchObject({
      toolCallCount: 2,
      parallelCallCount: 2,
      waves: [{ mode: "parallel", maxConcurrency: 8 }],
    });
    expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(2);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
  });
});
