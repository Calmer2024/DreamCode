import type { ChatMessage } from "@dreamcode/shared";
import { describe, expect, it } from "vitest";
import { ContextBuilder, contextOptionsForModel } from "./index";

describe("ContextBuilder structured history", () => {
  it("keeps assistant tool calls paired with their tool results", async () => {
    const history = [
      { role: "user", content: "Does this project have a frontend?" },
      {
        role: "assistant",
        content: "I found a Vue application and will verify its entry point.",
        toolCalls: [{ id: "call_1", name: "file.read", input: { path: "frontend/src/main.ts" } }],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "file.read",
        content: "Read frontend/src/main.ts successfully.",
      },
    ] satisfies ChatMessage[];

    const result = await new ContextBuilder().build({
      mode: "guided",
      workspaceRoot: process.cwd(),
      messages: history,
      todoItems: [],
    } as any);

    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Vue application"),
          toolCalls: [expect.objectContaining({ id: "call_1", name: "file.read" })],
        }),
        expect.objectContaining({ role: "tool", toolCallId: "call_1" }),
      ]),
    );
    expect(result.maxTokens).toBe(64_000);
    const systemMessage = result.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain("You are DreamCode, an AI agent.");
    expect(systemMessage?.content).toContain("powered by the configured model");
    expect(systemMessage?.content).toContain("Respond in the same language as the user's latest message.");
    expect(systemMessage?.content).toContain("Current Policy Context:");
    expect(systemMessage?.content).not.toContain("Keep code, commands, file paths, identifiers");
  });

  it("compacts older complete interactions while retaining recent messages", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: `Investigate the frontend. ${"goal ".repeat(80)}` },
      { role: "assistant", content: `The frontend exists. ${"decision ".repeat(80)}` },
      { role: "user", content: `Now inspect the API. ${"next ".repeat(80)}` },
      { role: "assistant", content: "The API entry point is backend/main.py." },
    ];
    const builder = new ContextBuilder({
      maxContextTokens: 260,
      reservedOutputTokens: 40,
      compactionBufferTokens: 20,
      keepRecentTokens: 80,
    } as any);

    const result = await builder.build({
      mode: "guided",
      workspaceRoot: process.cwd(),
      messages,
      todoItems: [],
    } as any);

    expect(result.compressed).toBe(true);
    expect(result.maxTokens).toBe(260);
    expect(result.checkpoint?.summary.objective).toContain("Investigate the frontend");
    expect(result.messages.at(-1)?.content).toContain("backend/main.py");
  });

  it("selects the DeepSeek V4 context profile", () => {
    const options = contextOptionsForModel("deepseek", "deepseek-v4-pro");
    expect(options.maxContextTokens).toBe(1_000_000);
    expect(options.reservedOutputTokens).toBe(64_000);
    expect(options.tokenCounter?.exact).toBe(true);
  });

  it.each([
    ["openai", "gpt-5.5", 1_050_000],
    ["openai", "gpt-5.4-mini", 400_000],
    ["qwen", "qwen3.7-plus", 1_000_000],
    ["qwen", "qwen3-coder-next", 256_000],
    ["kimi", "kimi-k2.7-code", 256_000],
    ["zhipu", "glm-5.1", 200_000],
    ["zhipu", "glm-5.2[1m]", 1_000_000],
    ["siliconflow", "deepseek-ai/DeepSeek-V3.2", 128_000],
    ["minimax", "MiniMax-M3", 1_000_000],
    ["minimax", "MiniMax-M2.7", 204_800],
    ["mimo", "mimo-v2.5-pro", 1_000_000],
  ])("resolves %s/%s to %s tokens", (provider, model, expected) => {
    expect(contextOptionsForModel(provider, model).maxContextTokens).toBe(expected);
  });

  it("uses an injected tokenizer for context estimates", async () => {
    const result = await new ContextBuilder({
      maxContextTokens: 1_000,
      tokenCounter: { count: () => 321, exact: true },
    }).build({
      mode: "guided",
      workspaceRoot: process.cwd(),
      messages: [{ role: "user", content: "hello" }],
      todoItems: [],
    });
    expect(result.estimatedTokens).toBe(321);
  });

  it("includes the actual tool schemas in provider-aware request estimates", async () => {
    const seenToolCounts: number[] = [];
    const result = await new ContextBuilder({ maxContextTokens: 1_000 }).build({
      mode: "guided",
      workspaceRoot: process.cwd(),
      messages: [{ role: "user", content: "hello" }],
      todoItems: [],
      model: "fixture-model",
      tools: [
        {
          name: "job_list",
          description: "jobs",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      estimateInputTokens: async ({ tools }) => {
        seenToolCounts.push(tools.length);
        return {
          messageTokens: 100,
          toolDefinitionTokens: 25,
          providerOverheadTokens: 5,
          inputTokens: 130,
          exact: true,
          estimationMethod: "fixture",
        };
      },
    });
    expect(seenToolCounts).toEqual([1]);
    expect(result.tokenEstimate).toMatchObject({
      toolDefinitionTokens: 25,
      providerOverheadTokens: 5,
      inputTokens: 130,
      exact: true,
    });
  });
});
