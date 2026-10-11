import { describe, expect, it } from "vitest";
import type { AgentEvent, ModelUsage } from "@dreamcode/shared";
import { AgentEventNormalizer } from "./agent-events.js";
import { agentLaunch, publicAgentData, usageFromResponse } from "./agent-protocol.js";
import { createModelBridge } from "./model-bridge.js";
import { dockerAgentArguments } from "./container.js";

describe("dataset framework adapters", () => {
  it("isolates sessions, pins the model, disables ambient extensions and shares the offline case container", () => {
    for (const agent of ["claude-code", "pi", "dsh", "opencode"] as const) {
      const launch = agentLaunch(agent, "mimo-v2.5-pro", "fix", "http://127.0.0.1:9");
      expect(JSON.stringify(launch)).toContain("mimo-v2.5-pro");
      expect(JSON.stringify(launch)).not.toContain("real-api-key");
    }
    const args = dockerAgentArguments(
      `sha256:${"a".repeat(64)}`,
      "work",
      "home",
      "runtime",
      "test",
      true,
      `dreameval-harness-${"b".repeat(24)}`,
    );
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args.find((arg) => arg.includes("dst=/opt/harness"))).toContain(
      "readonly,volume-nocopy",
    );
    expect(args.find((arg) => arg.includes("dst=/workspace"))).toContain("readonly");
    expect(() =>
      dockerAgentArguments(`sha256:${"a".repeat(64)}`, "w", "h", "r", "test", false, "bad,volume"),
    ).toThrow();
  });
  it("strips private thinking recursively while retaining public tool outputs and reasoning token counts", () => {
    const public_ = publicAgentData({
      type: "assistant",
      message: {
        reasoning_content: "private",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "public" },
          { type: "tool_use", id: "T1", name: "read", input: { file: "x" } },
        ],
        usage: { output_tokens: 5 },
      },
    });
    expect(JSON.stringify(public_)).not.toContain("private");
    expect(JSON.stringify(public_)).toContain("public");
    expect(
      publicAgentData({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "private" },
      }),
    ).toBeUndefined();
  });
  it("pairs Claude native calls/results, rejects failed or incomplete traces and does not infer completion from exit", () => {
    const events: AgentEvent[] = [];
    const adapter = new AgentEventNormalizer("claude-code", (event) => events.push(event));
    adapter.consume({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "T", name: "Bash", input: { command: "test" } }],
      },
    });
    expect(() => adapter.verify()).toThrow("terminal");
    adapter.consume({ type: "result", is_error: false, result: "done" });
    expect(() => adapter.verify()).toThrow("incomplete");
    adapter.consume({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "T", content: "exit 1", is_error: true }],
      },
    });
    adapter.verify();
    expect(events.filter((event) => event.type === "model.tool_call")).toHaveLength(1);
    expect(events.find((event) => event.type === "tool.completed")?.payload).toMatchObject({
      tool: "Bash",
      status: "error",
    });
    expect(events.every((event) => !!event.timestamp)).toBe(true);
    const failed = new AgentEventNormalizer("claude-code", () => {});
    failed.consume({ type: "result", is_error: true, errors: ["API failure"] });
    expect(() => failed.verify()).toThrow("API failure");
  });
  it("normalizes Pi and OpenCode without double-counting native usage or duplicate tools", () => {
    const events: AgentEvent[] = [];
    const pi = new AgentEventNormalizer("pi", (event) => events.push(event));
    pi.consume({ type: "tool_execution_start", toolCallId: "T", toolName: "bash", args: {} });
    pi.consume({
      type: "tool_execution_end",
      toolCallId: "T",
      toolName: "bash",
      result: "ok",
      isError: false,
    });
    pi.consume({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1 },
      },
    });
    pi.consume({ type: "agent_end" });
    pi.verify();
    expect(events.filter((event) => event.type === "model.usage")).toHaveLength(0);
    const codeEvents: AgentEvent[] = [];
    const code = new AgentEventNormalizer("opencode", (event) => codeEvents.push(event));
    for (const status of ["running", "completed", "completed"])
      code.consume({
        type: "tool_use",
        part: { callID: "T", tool: "bash", state: { status, input: {}, output: "ok" } },
      });
    code.consume({ type: "step_finish", part: { reason: "stop" } });
    code.verify();
    expect(codeEvents.filter((event) => event.type === "model.tool_call")).toHaveLength(1);
    expect(codeEvents.filter((event) => event.type === "tool.completed")).toHaveLength(1);
  });
  it("keeps native cumulative usage and does not add cached or reasoning tokens twice", () => {
    expect(
      usageFromResponse("anthropic", {
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 3,
            output_tokens: 2,
          },
        },
      }),
    ).toEqual({ inputTokens: 33, outputTokens: 2, cachedInputTokens: 20 });
    expect(usageFromResponse("anthropic", { usage: { output_tokens: 12 } })).toEqual({
      outputTokens: 12,
    });
    expect(
      usageFromResponse("openai", {
        usage: {
          prompt_tokens: 30,
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 10 },
          prompt_tokens_details: { cached_tokens: 5 },
        },
      }),
    ).toEqual({ inputTokens: 30, outputTokens: 20, cachedInputTokens: 5 });
  });
  it("reads committed DeepSeek SDK session events and does not persist its internal model stream", () => {
    const events: AgentEvent[] = [];
    const adapter = new AgentEventNormalizer("dsh", (event) => events.push(event));
    const envelope = (type: string, data: unknown) => ({
      method: "session.event",
      params: { event: { type, time: 1791615600000, data } },
    });
    adapter.consume(
      envelope("tool/call", { callId: "T", name: "bash", arguments: '{"command":"test"}' }),
    );
    adapter.consume(
      envelope("tool/result", {
        message: { callId: "T", content: [{ type: "text", text: "ok" }], isError: false },
      }),
    );
    adapter.consume(
      envelope("assistant/message", {
        message: { content: [{ type: "text", text: "done" }] },
        stream: [{ delta: "PRIVATE" }],
      }),
    );
    adapter.consume({ type: "dsh.result", finalResponse: "done" });
    adapter.verify();
    expect(events.find((event) => event.type === "tool.completed")?.payload).toMatchObject({
      toolCallId: "T",
      timestampSource: "native",
    });
    expect(
      JSON.stringify(
        publicAgentData(envelope("assistant/message", { stream: [{ delta: "PRIVATE" }] })),
      ),
    ).not.toContain("PRIVATE");
  });
  it("forwards native API parameters, meters split SSE frames, enforces budgets and keeps secrets on the host", async () => {
    const evidence: { type: string; data: unknown }[] = [],
      usage: (ModelUsage | null)[] = [];
    let transmitted: any;
    const bridge = createModelBridge({
      endpoint: {
        protocol: "anthropic",
        baseURL: "https://mock.invalid/anthropic",
        apiKey: "SECRET",
        model: "mimo",
        provider: "mimo",
      },
      maxModelRequests: 1,
      signal: new AbortController().signal,
      usage,
      onEvent: () => {},
      add: (type, data) => evidence.push({ type, data }),
      fetch: async (url, input) => {
        expect(String(url)).toBe("https://mock.invalid/anthropic/v1/messages?beta=true");
        transmitted = input;
        const text =
          'data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":0}}}\n\ndata: {"usage":{"output_tokens":9}}\n\n';
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text.slice(0, 30)));
            controller.enqueue(new TextEncoder().encode(text.slice(30)));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const request = {
      path: "/v1/messages?beta=true",
      body: {
        model: "mimo",
        max_tokens: 123,
        messages: [
          {
            content: [
              { type: "thinking", thinking: "PRIVATE" },
              { type: "text", text: "fix" },
            ],
          },
        ],
      },
    };
    for await (const _ of bridge(request)) {
      /* wire only */
    }
    expect(JSON.parse(transmitted.body).max_tokens).toBe(123);
    expect(transmitted.headers.authorization).toBe("Bearer SECRET");
    expect(usage).toEqual([{ inputTokens: 15, outputTokens: 9, cachedInputTokens: 5 }]);
    expect(JSON.stringify(evidence)).not.toMatch(/SECRET|PRIVATE/);
    await expect(async () => {
      for await (const _ of bridge(request)) {
      }
    }).rejects.toThrow("budget");
    await expect(async () => {
      for await (const _ of bridge({ ...request, path: "https://evil/v1/messages" })) {
      }
    }).rejects.toThrow("Invalid bridge path");
  });
  it("does not report partial usage as complete when a response stream fails", async () => {
    const usage: (ModelUsage | null)[] = [];
    const bridge = createModelBridge({
      endpoint: {
        protocol: "anthropic",
        baseURL: "https://mock.invalid",
        apiKey: "SECRET",
        model: "mimo",
        provider: "mimo",
      },
      maxModelRequests: 1,
      signal: new AbortController().signal,
      usage,
      onEvent: () => {},
      add: () => {},
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
                ),
              );
            },
            pull(controller) {
              controller.error(Error("upstream disconnected"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    await expect(async () => {
      for await (const _ of bridge({ path: "/v1/messages", body: { model: "mimo" } })) {
      }
    }).rejects.toThrow("upstream disconnected");
    expect(usage).toEqual([null]);
  });
});
