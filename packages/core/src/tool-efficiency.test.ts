import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, ModelEvent, ModelProvider, ModelStreamInput } from "@dreamcode/shared";
import { createDefaultToolRegistry } from "@dreamcode/tools";
import { describe, expect, it } from "vitest";
import { runTurn, selectToolSpecs } from "./index";

describe("tool exposure and turn cache", () => {
  it("keeps Skill loading available while gating web and MCP schemas", () => {
    const registry = createDefaultToolRegistry();
    const coding = selectToolSpecs(registry, "Fix the TypeScript build").map((tool) => tool.name);
    expect(coding).toContain("runtime.info");
    expect(coding).toContain("process.run");
    expect(coding.some((name) => name.startsWith("web."))).toBe(false);
    expect(coding).toContain("skill.load");
    expect(coding.some((name) => name.startsWith("mcp."))).toBe(false);

    const web = selectToolSpecs(registry, "Search the web for this API").map((tool) => tool.name);
    expect(web).toContain("web.search");
    const unconfiguredMcp = selectToolSpecs(registry, "Call the MCP server").map(
      (tool) => tool.name,
    );
    expect(unconfiguredMcp.some((name) => name.startsWith("mcp."))).toBe(false);
    const explicitlyLocal = selectToolSpecs(
      registry,
      "不需要联网、Skill 或 MCP，只处理本地代码。",
    ).map((tool) => tool.name);
    expect(explicitlyLocal.some((name) => name.startsWith("web."))).toBe(false);
    expect(explicitlyLocal.some((name) => name.startsWith("mcp."))).toBe(false);
    expect(explicitlyLocal).toContain("skill.load");
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
          input: { path: "README.md" },
        },
      };
    } else {
      yield { type: "text_delta", text: "Done." };
    }
    yield { type: "done" };
  }
}
