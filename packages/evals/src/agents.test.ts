import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentArguments, normalizeAgentRecords } from "./agents";
import { agentTaskIncompatibility, discoverTasks, loadTask, modelCatalog, runTask } from "./index";

afterEach(() => vi.unstubAllEnvs());

describe("cross-product evaluation", () => {
  it("keeps prompts as a single argument and starts fresh product sessions", () => {
    const prompt = '中文任务 `echo secret` $(whoami) "quoted"\nsecond line';
    for (const agent of ["claude-code", "pi", "opencode", "dsh"] as const) {
      const args = agentArguments(agent, prompt, "C:/isolated/home");
      expect(args.at(-1)).toBe(prompt);
      expect(args).not.toContain("--continue");
      expect(args).not.toContain("--dangerously-skip-permissions");
    }
  });

  it("normalizes Claude aggregate usage without counting per-message usage twice", () => {
    const run = normalizeAgentRecords("claude-code", [
      {
        type: "assistant",
        message: {
          model: "claude-test",
          usage: { input_tokens: 999 },
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "source" }] },
      },
      {
        type: "result",
        result: "done",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 2,
        },
      },
    ]);
    expect(run.events.filter((event) => event.type === "model.usage")).toHaveLength(1);
    expect(run.events.find((event) => event.type === "model.usage")?.payload).toMatchObject({
      usage: { inputTokens: 35, outputTokens: 2 },
    });
    expect(run.events.at(-1)).toMatchObject({
      type: "turn.completed",
      payload: { finalText: "done" },
    });
  });

  it("handles Pi tool failures and rejects incomplete event streams", () => {
    const records = [
      {
        type: "tool_execution_start",
        toolCallId: "t",
        toolName: "bash",
        args: { command: "npm test" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "t",
        toolName: "bash",
        result: "failed",
        isError: true,
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "test failed" }],
          usage: { input: 10, cacheRead: 3, output: 2, totalTokens: 15 },
        },
      },
    ];
    expect(normalizeAgentRecords("pi", records).events.at(-1)?.type).toBe("turn.failed");
    const run = normalizeAgentRecords("pi", [...records, { type: "agent_end" }]);
    expect(run.events.at(-1)?.type).toBe("turn.completed");
    expect(run.events.find((event) => event.type === "tool.completed")?.payload).toMatchObject({
      status: "error",
    });
  });

  it("normalizes OpenCode result evidence and identifies missing DSH telemetry", () => {
    const run = normalizeAgentRecords("opencode", [
      { type: "step_start" },
      {
        type: "tool_use",
        part: {
          callID: "t",
          tool: "read",
          state: { input: { filePath: "a.ts" }, output: "source", status: "completed" },
        },
      },
      { type: "text", part: { text: "done" } },
      {
        type: "step_finish",
        part: {
          reason: "stop",
          tokens: { input: 10, output: 2, cache: { read: 5, write: 1 } },
          cost: 0.1,
        },
      },
    ]);
    expect(run.telemetry).toMatchObject({ usage: true, tools: true, permissions: false });
    expect(run.events.find((event) => event.type === "model.usage")?.payload).toMatchObject({
      usage: { inputTokens: 16 },
    });
    expect(normalizeAgentRecords("dsh", []).telemetry).toMatchObject({
      usage: false,
      tools: false,
    });
  });

  it("reuses every DreamCode provider and blocks product-specific assertions", async () => {
    const catalog = await modelCatalog();
    expect(catalog.map((item) => item.id)).toEqual(
      expect.arrayContaining(["openai", "deepseek", "qwen", "kimi", "mimo"]),
    );
    expect(JSON.stringify(catalog)).not.toMatch(/apiKey|baseURL/);
    const tasks = await discoverTasks();
    expect(
      agentTaskIncompatibility(await loadTask(tasks.find((item) => item.includes("K01-"))!), "pi"),
    ).toBeDefined();
    expect(
      agentTaskIncompatibility(await loadTask(tasks.find((item) => item.includes("B01-"))!), "pi"),
    ).toBeUndefined();
  });

  it("runs a Judge through a non-Mimo provider using the shared model transport", async () => {
    const content = JSON.stringify({
      taskCompletion: 1,
      toolSelectionQuality: 1,
      stepEfficiency: 1,
      summaryAccuracy: 1,
    });
    let requestedModel: string | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestedModel = JSON.parse(body).model;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "eval-model-transport-test-"));
    vi.stubEnv("DREAMCODE_JUDGE_QWEN_API_KEY", "test-only-key");
    vi.stubEnv("DREAMCODE_JUDGE_QWEN_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
    try {
      const task = await loadTask((await discoverTasks()).find((item) => item.includes("M02-"))!);
      const run = await runTask(task, {
        provider: "fake",
        judge: true,
        judgeProvider: "qwen",
        judgeModel: "qwen-test",
        outputRoot,
      });
      expect(requestedModel).toBe("qwen-test");
      expect(run.judge).toMatchObject({
        status: "completed",
        provider: "qwen",
        model: "qwen-test",
      });
      expect(run.scores.complete).toBe(true);
    } finally {
      server.close();
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("executes an external process in a fresh workspace on every repeat", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "eval-external-test-"));
    const script = path.join(outputRoot, "agent.mjs");
    await writeFile(
      script,
      `import {writeFileSync,existsSync} from 'node:fs';
if(existsSync('result.txt')) process.exit(2);
writeFileSync('result.txt','done');
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],usage:{input:1,output:1,totalTokens:2}}}));
console.log(JSON.stringify({type:'agent_end'}));`,
    );
    vi.stubEnv("DREAMCODE_EVAL_PI_COMMAND", JSON.stringify([process.execPath, script]));
    try {
      const task = await loadTask((await discoverTasks()).find((item) => item.includes("M02-"))!);
      task.assertions = [{ type: "file-contains", path: "result.txt", text: "done" }];
      const first = await runTask(task, { provider: "external", agent: "pi", outputRoot });
      const second = await runTask(task, { provider: "external", agent: "pi", outputRoot });
      expect(first.status).toBe("passed");
      expect(second.status).toBe("passed");
      expect(first.runId).not.toBe(second.runId);
      expect(
        JSON.parse(await readFile(path.join(first.artifactsDir, "snapshot-before.json"), "utf8"))[
          "result.txt"
        ],
      ).toBeUndefined();
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("excludes missing DSH process evidence from scores and records failed launches as invalid", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "eval-dsh-test-"));
    const script = path.join(outputRoot, "dsh.mjs");
    vi.stubEnv("DREAMCODE_EVAL_DSH_COMMAND", JSON.stringify([process.execPath, script]));
    try {
      const task = await loadTask((await discoverTasks()).find((item) => item.includes("M02-"))!);
      await writeFile(script, "console.log('analysis complete');");
      const run = await runTask(task, {
        agent: "dsh",
        provider: "external",
        judge: true,
        judgeEvaluator: async () => ({
          status: "completed",
          taskCompletion: 1,
          summaryAccuracy: 1,
          toolSelectionQuality: 1,
          stepEfficiency: 1,
        }),
        outputRoot,
      });
      expect(run.status).toBe("passed");
      expect(run.scores.deterministic.max).toBe(47);
      expect(run.scores.judge?.max).toBe(20);
      expect(run.scores.total).toBeLessThanOrEqual(67);
      expect(run.scores.complete).toBe(false);
      await writeFile(script, "console.error('missing credentials'); process.exit(1);");
      expect((await runTask(task, { agent: "dsh", provider: "external", outputRoot })).status).toBe(
        "invalid",
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
