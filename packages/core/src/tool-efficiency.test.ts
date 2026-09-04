import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, ModelEvent, ModelProvider, ModelStreamInput } from "@dreamcode/shared";
import { createDefaultToolRegistry } from "@dreamcode/tools";
import { describe, expect, it } from "vitest";
import { runTurn } from "./index";

describe("tool exposure and turn cache", () => {
  it("exposes only mode-available tool schemas to the model", () => {
    const registry = createDefaultToolRegistry();
    const coding = registry.toModelSpecs("yolo").map((tool) => tool.name);
    expect(coding.every((name) => !/^(runtime|process|shell)[._]/.test(name))).toBe(true);
    expect(coding).toEqual(
      expect.arrayContaining([
        process.platform === "win32" ? "pwsh" : "bash",
        "job_output",
        "job_list",
        "job_kill",
      ]),
    );
    expect(coding).toEqual(expect.arrayContaining(["web.search", "web.fetch"]));
    expect(coding).toContain("skill.load");
    expect(coding).toEqual(expect.arrayContaining(["mcp.list", "mcp.call"]));

    const plan = registry.toModelSpecs("plan").map((tool) => tool.name);
    expect(plan).not.toEqual(expect.arrayContaining(["file.write", "file.patch", "web.search", "web.fetch", "mcp.list", "mcp.call", "job_kill"]));
    expect(plan).toContain("file.read");
    expect(plan).toContain(process.platform === "win32" ? "pwsh" : "bash");
  });

  it("returns a compact reference for a repeated read-only call", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-cache-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-cache-home-"));
    await writeFile(
      path.join(workspaceRoot, "README.md"),
      "cached evidence\n".repeat(1500),
      "utf8",
    );
    const provider = new RepeatedReadProvider();
    const events: AgentEvent[] = [];
    for await (const event of runTurn({
      prompt: "Read the README once and reuse the evidence.",
      workspaceRoot,
      home,
      provider,
      mode: "yolo",
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1);
    const cached = events.find(
      (event) =>
        event.type === "tool.completed" && (event.payload as { cached?: boolean }).cached === true,
    );
    expect(cached?.payload).toMatchObject({
      cached: true,
      cache: { outcome: "cache_hit", workspaceRevision: 0 },
    });
    const sourceMessage = provider.inputs[1]?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "read_1",
    );
    const cachedMessage = provider.inputs[2]?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "read_2",
    );
    expect(sourceMessage).toBeDefined();
    expect(cachedMessage).toBeDefined();
    expect(cachedMessage!.content.length).toBeLessThanOrEqual(sourceMessage!.content.length * 0.1);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
  });
});

class RepeatedReadProvider implements ModelProvider {
  readonly name = "fixture";
  readonly inputs: ModelStreamInput[] = [];
  private call = 0;

  async *stream(input: ModelStreamInput): AsyncIterable<ModelEvent> {
    this.inputs.push(input);
    this.call += 1;
    if (this.call <= 2) {
      yield {
        type: "tool_call",
        toolCall: {
          id: `read_${this.call}`,
          name: "file.read",
          input: { file_path: "README.md" },
        },
      };
    } else {
      yield { type: "text_delta", text: "Done." };
    }
    yield { type: "done" };
  }
}
