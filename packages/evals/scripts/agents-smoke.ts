import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runContainerTurn } from "../src/dataset/container.js";
import { readAgentInstallation, type ExternalAgent } from "../src/dataset/agents.js";
import { createModelBridge } from "../src/dataset/model-bridge.js";
import type { AgentEvent, ModelUsage } from "@dreamcode/shared";

const directory = path.resolve("evals/runs/agents-smoke", randomUUID());
const installation = await readAgentInstallation(process.cwd());
const image = JSON.parse(
  await readFile("evals/dataset/runtimes/click-engineering.json", "utf8"),
).image;
const selected = (
  process.argv.slice(2).length ? process.argv.slice(2) : ["claude-code", "pi", "opencode", "dsh"]
) as ExternalAgent[];
const results: unknown[] = [];
for (const agent of selected) {
  const root = path.join(directory, agent),
    workspace = path.join(root, "workspace"),
    home = path.join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(workspace, "README.md"),
    "Adapter smoke fixture. This is not a dataset case.\n",
  );
  const evidence: { type: string; data: unknown }[] = [],
    events: AgentEvent[] = [],
    usage: (ModelUsage | null)[] = [];
  let invokedTool = false,
    generations = 0;
  const mockFetch: typeof fetch = async (_url, input) => {
    const body = JSON.parse(String(input?.body));
    if (String(_url).endsWith("count_tokens"))
      return new Response(
        '{"error":{"type":"not_found_error","message":"count_tokens unavailable"}}',
        { status: 404 },
      );
    generations++;
    const anthropic = agent === "claude-code" || agent === "dsh";
    const tools = (body.tools ?? []).map((tool: any) => (anthropic ? tool : tool.function));
    const bash = tools.find((tool: any) =>
      /bash|exec_command|run_command/.test(tool.name.toLowerCase()),
    );
    let call: { id: string; name: string; input: Record<string, unknown> } | undefined;
    if (!invokedTool && bash) {
      invokedTool = true;
      const properties = (bash.input_schema ?? bash.parameters)?.properties ?? {};
      const arguments_: Record<string, unknown> = {
        command: "printf 'adapter-ok' > /workspace/probe.txt",
        description: "Create smoke marker",
        timeout: 10000,
      };
      for (const key of (bash.input_schema ?? bash.parameters)?.required ?? [])
        if (!(key in arguments_)) {
          if (properties[key]?.type === "string")
            arguments_[key] = key === "workdir" || key === "cwd" ? "/workspace" : "Smoke";
          else if (properties[key]?.type === "number" || properties[key]?.type === "integer")
            arguments_[key] = 10000;
          else if (properties[key]?.type === "boolean") arguments_[key] = false;
          else throw Error(`Smoke needs explicit native input for ${bash.name}.${key}`);
        }
      call = { id: `smoke-${generations}`, name: bash.name, input: arguments_ };
    }
    const frames = anthropic
      ? [
          {
            type: "message_start",
            message: {
              id: `msg-${generations}`,
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 11, cache_read_input_tokens: 7, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: call
              ? { type: "tool_use", id: call.id, name: call.name, input: {} }
              : { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: call
              ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
              : { type: "text_delta", text: "Created the marker." },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]
      : [
          {
            id: `chat-${generations}`,
            object: "chat.completion.chunk",
            model: body.model,
            choices: [
              {
                index: 0,
                delta: call
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: call.id,
                          type: "function",
                          function: { name: call.name, arguments: JSON.stringify(call.input) },
                        },
                      ],
                    }
                  : { role: "assistant", content: "Created the marker." },
                finish_reason: null,
              },
            ],
          },
          {
            id: `chat-${generations}`,
            object: "chat.completion.chunk",
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 5,
              total_tokens: 23,
              prompt_tokens_details: { cached_tokens: 7 },
            },
          },
        ];
    if (body.stream === false)
      return Response.json(
        anthropic
          ? {
              ...frames[0]!.message,
              content: call
                ? [{ type: "tool_use", ...call }]
                : [{ type: "text", text: "Created the marker." }],
              stop_reason: call ? "tool_use" : "end_turn",
              usage: { input_tokens: 18, output_tokens: 5 },
            }
          : {
              id: `chat-${generations}`,
              object: "chat.completion",
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: call ? null : "Created the marker.",
                    ...(call
                      ? {
                          tool_calls: [
                            {
                              id: call.id,
                              type: "function",
                              function: { name: call.name, arguments: JSON.stringify(call.input) },
                            },
                          ],
                        }
                      : {}),
                  },
                  finish_reason: call ? "tool_calls" : "stop",
                },
              ],
              usage: { prompt_tokens: 18, completion_tokens: 5 },
            },
      );
    return new Response(
      frames
        .map(
          (frame) =>
            `${anthropic ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`,
        )
        .join("") + (anthropic ? "" : "data: [DONE]\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const onEvent = (event: AgentEvent) => {
    events.push(event);
    evidence.push({ type: event.type, data: event });
  };
  const bridge = createModelBridge({
    endpoint: {
      protocol: agent === "claude-code" || agent === "dsh" ? "anthropic" : "openai",
      model: "mimo-v2.5-pro",
      provider: "mock",
      baseURL: "https://mock.invalid/v1",
      apiKey: "host-only-smoke-secret",
    },
    maxModelRequests: 8,
    signal: AbortSignal.timeout(90000),
    add: (type, data) => evidence.push({ type, data }),
    onEvent,
    usage,
    fetch: mockFetch,
  });
  let error: string | undefined;
  try {
    await runContainerTurn({
      execution: {
        backend: "docker",
        image,
        worker: path.resolve("packages/evals/dist-dataset-container/worker.mjs"),
      },
      workspace,
      home,
      runtimeDir: path.join(root, "runtime"),
      prompt: "Use a shell tool to write adapter-ok into probe.txt, then finish.",
      environment: {},
      model: "mimo-v2.5-pro",
      provider: {
        name: "unused",
        async *stream() {
          throw Error("External framework must not invoke DreamCode model loop");
        },
      },
      signal: AbortSignal.timeout(90000),
      onEvent,
      onReady: (data) => evidence.push({ type: "runtime", data }),
      questionHandler: async () => "No clarification available",
      external: { agent, installation },
      onHttp: (input, signal) => {
        console.log(JSON.stringify({ agent, bridgePath: input.path }));
        return bridge(input, signal);
      },
      onExternal: (data) => evidence.push({ type: "agent.native_event", data }),
    });
    if ((await readFile(path.join(workspace, "probe.txt"), "utf8")) !== "adapter-ok")
      throw Error("Native shell tool did not modify the isolated workspace");
    if (!events.some((event) => event.type === "tool.completed"))
      throw Error("No normalized tool result");
    if (
      !usage.length ||
      usage.some(
        (entry) => !entry || entry.inputTokens === undefined || entry.outputTokens === undefined,
      )
    )
      throw Error("Incomplete provider telemetry");
    if (JSON.stringify(evidence).includes("host-only-smoke-secret"))
      throw Error("Credential leaked to persisted evidence");
  } catch (failure) {
    error = String(failure);
  }
  const result = {
    agent,
    status: error ? "failed" : "passed",
    error,
    generations,
    tools: events.filter((event) => event.type === "tool.completed").length,
    usage,
  };
  await writeFile(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(
  path.join(directory, "report.json"),
  JSON.stringify({ directory, results }, null, 2),
);
console.log(JSON.stringify({ directory }));
if (results.some((result: any) => result.status !== "passed")) process.exitCode = 1;
