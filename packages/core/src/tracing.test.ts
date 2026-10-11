import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeModelProvider } from "@dreamcode/models";
import type { PermissionEngine } from "@dreamcode/safety";
import type { AgentEvent, ModelProvider } from "@dreamcode/shared";
import { getConfigPath, saveDreamCodeConfig } from "@dreamcode/store";
import { Client } from "langsmith";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "./index";
import { loadTraceOptions, resolveTraceOptions, TurnTrace } from "./tracing";

function captureClient() {
  const client = new Client({ apiKey: "test", autoBatchTracing: false });
  const created: any[] = [];
  const updated = new Map<string, any>();
  const create = vi.spyOn(client, "createRun").mockImplementation(async (run) => {
    created.push(structuredClone(run));
  });
  const update = vi.spyOn(client, "updateRun").mockImplementation(async (id, run) => {
    updated.set(id, structuredClone(run));
  });
  const flush = vi.spyOn(client, "awaitPendingTraceBatches").mockResolvedValue();
  return { client, created, updated, create, update, flush };
}

const temporary: string[] = [];
async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-trace-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-trace-home-"));
  temporary.push(workspaceRoot, home);
  await writeFile(path.join(workspaceRoot, "README.md"), "trace fixture");
  return { workspaceRoot, home };
}

async function collect(stream: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LangSmith turn traces", () => {
  it("uses config.json automatically for runTurn and redacts file credentials", async () => {
    const captured = captureClient();
    const locations = await fixture();
    vi.stubEnv("LANGSMITH_TRACING", "");
    vi.stubEnv("LANGSMITH_PROJECT", "");
    vi.stubEnv("LANGSMITH_HIDE_OUTPUTS", "");
    await saveDreamCodeConfig(
      {
        version: 3,
        profiles: {},
        langsmith: {
          enabled: true,
          apiKey: "file-smith-secret",
          projectName: "file-project",
          hideOutputs: false,
        },
      },
      locations.home,
    );
    await collect(
      runTurn({
        ...locations,
        prompt: "file-smith-secret",
        provider: new FakeModelProvider([{ text: "file-smith-secret" }]),
        tracing: { client: captured.client },
      }),
    );
    expect(captured.created[0].session_name).toBe("file-project");
    expect(captured.created[0].inputs.prompt).toBe("[redacted]");
    expect(JSON.stringify([...captured.updated.values()])).not.toContain("file-smith-secret");
    vi.stubEnv("LANGSMITH_TRACING", "false");
    const disabled = captureClient();
    await collect(
      runTurn({
        ...locations,
        prompt: "test",
        provider: new FakeModelProvider([{ text: "done" }]),
        tracing: { client: disabled.client },
      }),
    );
    expect(disabled.create).not.toHaveBeenCalled();
  });

  it("resolves explicit options before environment, then file settings", () => {
    const config = {
      profiles: {},
      langsmith: {
        enabled: true,
        apiKey: "file-key",
        apiKeyEnv: "CUSTOM_KEY",
        projectName: "file-project",
        endpoint: "https://file.example",
        workspaceId: "file-workspace",
        hideInputs: true,
        hideOutputs: true,
        flushTimeoutMs: 1200,
      },
    };
    expect(resolveTraceOptions(config, {}, {})).toMatchObject({
      enabled: true,
      apiKey: "file-key",
      projectName: "file-project",
      hideInputs: true,
      flushTimeoutMs: 1200,
    });
    expect(resolveTraceOptions(config, {}, { CUSTOM_KEY: "custom-env-key" }).apiKey).toBe(
      "custom-env-key",
    );
    const env = {
      LANGSMITH_TRACING: " false ",
      LANGSMITH_API_KEY: "env-key",
      CUSTOM_KEY: "custom-env-key",
      LANGSMITH_PROJECT: "env-project",
      LANGSMITH_ENDPOINT: "https://env.example",
      LANGSMITH_WORKSPACE_ID: "env-workspace",
      LANGSMITH_HIDE_INPUTS: "false",
      LANGSMITH_HIDE_OUTPUTS: "false",
    };
    expect(resolveTraceOptions(config, {}, env)).toMatchObject({
      enabled: false,
      apiKey: "env-key",
      projectName: "env-project",
      endpoint: "https://env.example",
      workspaceId: "env-workspace",
      hideInputs: false,
      hideOutputs: false,
    });
    expect(
      resolveTraceOptions(
        config,
        {
          enabled: true,
          apiKey: "explicit-key",
          projectName: "explicit-project",
          hideInputs: true,
        },
        env,
      ),
    ).toMatchObject({
      enabled: true,
      apiKey: "explicit-key",
      projectName: "explicit-project",
      hideInputs: true,
    });
    expect(resolveTraceOptions({ profiles: {} }, {}, {}).enabled).toBe(false);
  });

  it("keeps trace config errors from breaking a turn", async () => {
    const locations = await fixture();
    await writeFile(getConfigPath(locations.home), "invalid json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const options = await loadTraceOptions(locations.home, { enabled: false });
    expect(options.enabled).toBe(false);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("keeps simultaneous turns isolated and renders tool calls in OpenAI format", async () => {
    const captured = captureClient();
    const locations = await fixture();
    await Promise.all(
      ["one", "two"].map(async (prompt) =>
        collect(
          runTurn({
            ...locations,
            prompt,
            tracing: { enabled: true, client: captured.client },
            provider: new FakeModelProvider([
              {
                toolCalls: [
                  {
                    id: prompt,
                    name: "file.read",
                    input: { file_path: "README.md", apiKey: "inline-secret" },
                  },
                ],
              },
              { text: "done" },
            ]),
          }),
        ),
      ),
    );
    const roots = captured.created.filter((run) => !run.parent_run_id);
    expect(roots).toHaveLength(2);
    expect(roots[0].trace_id).not.toBe(roots[1].trace_id);
    for (const root of roots) {
      const children = captured.created.filter((run) => run.parent_run_id === root.id);
      expect(children.every((run) => run.trace_id === root.id)).toBe(true);
      expect(children.find((run) => run.run_type === "tool").extra.metadata.toolCallId).toBe(
        root.inputs.prompt,
      );
    }
    const llm = captured.created.find((run) => run.run_type === "llm");
    const message = captured.updated.get(llm.id).outputs.choices[0].message;
    expect(message.tool_calls[0].function.name).toBe("file.read");
    expect(JSON.parse(message.tool_calls[0].function.arguments).apiKey).toBe("[redacted]");
    expect(JSON.stringify(captured.created)).not.toContain("inline-secret");
    expect(JSON.stringify([...captured.updated.values()])).not.toContain("inline-secret");
  });

  it("traces validation failures before permission evaluation", async () => {
    const captured = captureClient();
    await collect(
      runTurn({
        ...(await fixture()),
        prompt: "test",
        tracing: { enabled: true, client: captured.client },
        provider: new FakeModelProvider([
          { toolCalls: [{ id: "invalid", name: "file.read", input: {} }] },
          { text: "done" },
        ]),
      }),
    );
    const tool = captured.created.find((run) => run.run_type === "tool");
    expect(captured.updated.get(tool.id).outputs.status).toBe("error");
    expect(captured.updated.get(tool.id).error).toBeTruthy();
  });

  it("links models, context and parallel cached tools to the turn and flushes all runs", async () => {
    const captured = captureClient();
    const events = await collect(
      runTurn({
        ...(await fixture()),
        prompt: "Read twice",
        model: "test-model",
        mode: "read-only",
        tracing: { enabled: true, client: captured.client, projectName: "trace-test" },
        provider: new FakeModelProvider([
          {
            toolCalls: [
              { id: "read1", name: "file.read", input: { file_path: "README.md" } },
              { id: "read2", name: "file.read", input: { file_path: "README.md" } },
            ],
          },
          { text: "done" },
        ]),
      }),
    );
    const root = captured.created.find((run) => !run.parent_run_id);
    const tools = captured.created.filter((run) => run.run_type === "tool");
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((run) => run.id)).size).toBe(2);
    expect(captured.created.filter((run) => run.run_type === "llm")).toHaveLength(2);
    expect(captured.created.filter((run) => run.name === "context.build")).toHaveLength(2);
    for (const run of captured.created) {
      expect(run.trace_id).toBe(root.id);
      expect(run.session_name).toBe("trace-test");
      if (run !== root) expect(run.parent_run_id).toBe(root.id);
      expect(captured.updated.get(run.id)?.end_time).toBeDefined();
    }
    expect(tools.some((run) => captured.updated.get(run.id).outputs.cached)).toBe(true);
    const completed = captured.updated.get(root.id);
    expect(completed.outputs.status).toBe("turn.completed");
    expect(completed.extra.metadata.thread_id).toBe(events[0]!.sessionId);
    expect(completed.extra.metadata.turn_id).toBe(events[0]!.turnId);
    const llm = captured.created.find((run) => run.run_type === "llm");
    expect(llm.inputs.messages.length).toBeGreaterThan(0);
    expect(captured.updated.get(llm.id).outputs.usage_metadata.total_tokens).toBeGreaterThan(0);
    expect(captured.flush).toHaveBeenCalledOnce();
  });

  it("records permission denial as a tool error without executing it", async () => {
    const captured = captureClient();
    await collect(
      runTurn({
        ...(await fixture()),
        prompt: "read",
        tracing: { enabled: true, client: captured.client },
        permissionEngine: {
          decide: () => ({ decision: "deny", reason: "test denied", reviewer: "rules", risk: [] }),
        } as unknown as PermissionEngine,
        provider: new FakeModelProvider([
          { toolCalls: [{ id: "denied", name: "file.read", input: { file_path: "README.md" } }] },
          { text: "done" },
        ]),
      }),
    );
    const tool = captured.created.find((run) => run.run_type === "tool");
    expect(captured.updated.get(tool.id)).toMatchObject({
      error: expect.stringContaining("test denied"),
      outputs: { status: "denied" },
    });
    expect(captured.updated.get(tool.id).events.map((event: any) => event.name)).toEqual([
      "permission.decided",
    ]);
  });

  it.each(["failure", "abort", "return"])("closes a partial model on %s", async (kind) => {
    const captured = captureClient();
    const abort = new AbortController();
    const provider: ModelProvider = {
      name: "test",
      async *stream() {
        yield { type: "text_delta", text: "partial" };
        if (kind === "abort") abort.abort("cancelled");
        throw new Error("model failed");
      },
    };
    const stream = runTurn({
      ...(await fixture()),
      prompt: "test",
      provider,
      signal: abort.signal,
      tracing: { enabled: true, client: captured.client },
    });
    if (kind === "return") {
      for await (const event of stream) if (event.type === "model.delta") break;
    } else await collect(stream);
    const root = captured.created.find((run) => !run.parent_run_id);
    const model = captured.created.find((run) => run.run_type === "llm");
    expect(captured.updated.get(root.id).error).toBeTruthy();
    expect(captured.updated.get(model.id).outputs.choices[0].message.content).toBe("partial");
    expect(captured.updated.size).toBe(captured.created.length);
    expect(captured.flush).toHaveBeenCalledOnce();
  });

  it("does no uploads when disabled and preserves task completion on upload failure", async () => {
    const captured = captureClient();
    const base = { ...(await fixture()), prompt: "test" };
    await collect(
      runTurn({
        ...base,
        provider: new FakeModelProvider([{ text: "done" }]),
        tracing: { enabled: false, client: captured.client },
      }),
    );
    expect(captured.create).not.toHaveBeenCalled();
    expect(captured.flush).not.toHaveBeenCalled();
    captured.create.mockRejectedValue(new Error("offline"));
    captured.update.mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await collect(
      runTurn({
        ...base,
        provider: new FakeModelProvider([{ text: "done" }]),
        tracing: { enabled: true, client: captured.client },
      }),
    );
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("redacts credentials and honors input/output hiding", async () => {
    vi.stubEnv("TEST_API_KEY", "private-credential");
    const captured = captureClient();
    const trace = new TurnTrace(
      { enabled: true, client: captured.client },
      { prompt: "private-credential", apiKey: "other-key" },
    );
    await trace.close(new Error("private-credential"));
    expect(JSON.stringify(captured.created)).not.toContain("private-credential");
    expect(captured.created[0].inputs.apiKey).toBe("[redacted]");
    expect(JSON.stringify([...captured.updated.values()])).not.toContain("private-credential");
    const hidden = captureClient();
    await collect(
      runTurn({
        ...(await fixture()),
        prompt: "sensitive",
        provider: new FakeModelProvider([{ text: "sensitive" }]),
        tracing: { enabled: true, client: hidden.client, hideInputs: true, hideOutputs: true },
      }),
    );
    for (const run of hidden.created) expect(run.inputs).toEqual({});
    for (const run of hidden.updated.values()) expect(run.outputs).toEqual({});
  });

  it("bounds a stalled flush", async () => {
    const captured = captureClient();
    captured.flush.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const trace = new TurnTrace({ enabled: true, client: captured.client, flushTimeoutMs: 10 }, {});
    await trace.close();
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
