import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSandboxPolicy } from "@dreamcode/safety";
import type { AgentEvent, ModelUsage, RunMode } from "@dreamcode/shared";
import { prepareSandboxedSpawn } from "@dreamcode/tools";

export const AGENT_PRODUCTS = [
  { id: "dreamcode", label: "DreamCode" },
  { id: "dsh", label: "DeepSeek Harness" },
  { id: "claude-code", label: "Claude Code" },
  { id: "pi", label: "Pi" },
  { id: "opencode", label: "OpenCode" },
] as const;
export type AgentProduct = (typeof AGENT_PRODUCTS)[number]["id"];
export interface ExternalRun {
  events: AgentEvent[];
  raw: unknown[];
  stderr: string;
  model?: string;
  telemetry: { usage: boolean; tools: boolean; permissions: boolean };
}

export async function resolveAgentCommand(
  agent: Exclude<AgentProduct, "dreamcode">,
  repoRoot: string,
): Promise<string[]> {
  const override =
    process.env[`DREAMCODE_EVAL_${agent.replaceAll("-", "_").toUpperCase()}_COMMAND`];
  if (override) {
    const command: unknown = JSON.parse(override);
    if (
      !Array.isArray(command) ||
      !command.length ||
      !command.every((item) => typeof item === "string" && item.length)
    )
      throw new Error("Agent command must be a non-empty JSON string array.");
    return command;
  }
  if (agent === "dsh") {
    const root =
      process.env.DREAMCODE_EVAL_DSH_ROOT ??
      path.resolve(repoRoot, "../GithubProjects/deepseek-harness");
    const bin = path.join(root, "apps/cli/lib/bin.js");
    if (await exists(bin)) return [process.execPath, bin];
  }
  const name = agent === "claude-code" ? "claude" : agent;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".ps1"] : [""]) {
      const executable = path.join(directory.replace(/^"|"$/g, ""), name + suffix);
      if (await exists(executable))
        return suffix === ".ps1" ? ["pwsh", "-NoProfile", "-File", executable] : [executable];
    }
  }
  throw new Error(`${name} 未安装或未配置启动入口。`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function agentCatalog(repoRoot: string) {
  return Promise.all(
    AGENT_PRODUCTS.map(async (product) => {
      if (product.id === "dreamcode") return { ...product, available: true, detail: "内置运行器" };
      try {
        await resolveAgentCommand(product.id, repoRoot);
        return {
          ...product,
          available: true,
          detail: product.id === "dsh" ? "本地 headless 入口，过程指标暂不完整" : "本地 CLI",
        };
      } catch (error) {
        return { ...product, available: false, detail: String(error) };
      }
    }),
  );
}

export function agentArguments(
  agent: Exclude<AgentProduct, "dreamcode">,
  prompt: string,
  home: string,
  model?: string,
): string[] {
  if (agent === "claude-code")
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      ...(model ? ["--model", model] : []),
      "--",
      prompt,
    ];
  if (agent === "pi")
    return [
      "--print",
      "--mode",
      "json",
      "--session-dir",
      path.join(home, "pi-sessions"),
      ...(model ? ["--model", model] : []),
      "--",
      prompt,
    ];
  if (agent === "opencode")
    return ["run", "--format", "json", ...(model ? ["--model", model] : []), "--", prompt];
  return ["--profile", "headless", "--", prompt];
}

/** Convert product-owned events without fabricating missing permission/usage evidence. */
export function normalizeAgentRecords(
  agent: AgentProduct,
  records: Record<string, any>[],
  sessionId = randomUUID(),
): ExternalRun {
  const events: AgentEvent[] = [];
  let observedAt: string | undefined;
  const emit = (type: AgentEvent["type"], payload: unknown, timestamp?: string) =>
    events.push({
      id: randomUUID(),
      sessionId,
      turnId: sessionId,
      type,
      timestamp: timestamp ?? observedAt ?? new Date().toISOString(),
      payload,
    });
  let final = "";
  let model: string | undefined;
  let usage = false;
  let tools = false;
  let failed = false;
  let terminalSeen = false;
  const addUsage = (value: ModelUsage) => {
    usage = true;
    emit("model.usage", { usage: value });
  };
  const tool = (id: string, name: string, input: unknown, result?: unknown, error = false) => {
    tools = true;
    emit("model.tool_call", { toolCall: { id, name, input } });
    emit("tool.started", { toolCallId: id, tool: name });
    if (result !== undefined)
      emit("tool.completed", {
        toolCallId: id,
        tool: name,
        status: error ? "error" : "success",
        summary: typeof result === "string" ? result : JSON.stringify(result),
        output: result,
      });
  };
  for (const record of records) {
    observedAt = record._evalObservedAt;
    if (agent === "claude-code") {
      if (record.type === "assistant") {
        model = record.message?.model ?? model;
        emit("model.started", { model });
        for (const block of record.message?.content ?? []) {
          if (block.type === "text") {
            final = block.text;
            emit("assistant.message", { content: block.text });
          }
          if (block.type === "tool_use") tool(block.id, block.name, block.input);
        }
      }
      if (record.type === "user")
        for (const block of record.message?.content ?? []) {
          if (block.type === "tool_result")
            emit("tool.completed", {
              toolCallId: block.tool_use_id,
              status: block.is_error ? "error" : "success",
              output: block.content,
              summary: JSON.stringify(block.content),
            });
        }
      if (record.type === "result") {
        terminalSeen = true;
        tools = true;
        final = record.result ?? final;
        failed ||= record.is_error === true;
        const u = record.usage;
        if (u)
          addUsage({
            inputTokens:
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0),
            outputTokens: u.output_tokens,
            cachedInputTokens: u.cache_read_input_tokens,
            costUsd: record.total_cost_usd,
          });
      }
    } else if (agent === "pi") {
      if (record.type === "agent_end") {
        terminalSeen = true;
        tools = true;
      }
      if (record.type === "message_end" && record.message?.role === "assistant") {
        const m = record.message;
        model = m.model ?? model;
        emit("model.started", { model });
        final = (m.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        emit("assistant.message", { content: final });
        failed ||= m.stopReason === "error" || m.stopReason === "aborted";
        if (m.usage)
          addUsage({
            inputTokens:
              (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0),
            outputTokens: m.usage.output,
            totalTokens: m.usage.totalTokens,
            cachedInputTokens: m.usage.cacheRead,
            costUsd: m.usage.cost?.total,
          });
      }
      if (record.type === "tool_execution_start")
        tool(record.toolCallId, record.toolName, record.args);
      if (record.type === "tool_execution_end")
        emit("tool.completed", {
          toolCallId: record.toolCallId,
          tool: record.toolName,
          status: record.isError ? "error" : "success",
          output: record.result,
          summary: JSON.stringify(record.result),
        });
    } else if (agent === "opencode") {
      const part = record.part ?? {};
      if (record.type === "text") {
        final = part.text ?? "";
        emit("assistant.message", { content: final });
      }
      if (record.type === "tool_use")
        tool(
          part.callID ?? part.id,
          part.tool,
          part.state?.input,
          part.state?.output ?? part.state?.error,
          part.state?.status === "error",
        );
      if (record.type === "step_start") emit("model.started", {});
      if (record.type === "step_finish" && part.reason === "stop") {
        terminalSeen = true;
        tools = true;
      }
      if (record.type === "step_finish" && part.tokens)
        addUsage({
          inputTokens:
            (part.tokens.input ?? 0) +
            (part.tokens.cache?.read ?? 0) +
            (part.tokens.cache?.write ?? 0),
          outputTokens: part.tokens.output,
          cachedInputTokens: part.tokens.cache?.read,
          costUsd: part.cost,
        });
      if (record.type === "error") {
        failed = true;
        emit("assistant.message", { error: record.error });
      }
    }
  }
  observedAt = undefined;
  emit(failed || (!terminalSeen && agent !== "dsh") ? "turn.failed" : "turn.completed", {
    finalText: final,
  });
  return {
    events,
    raw: records,
    stderr: "",
    model,
    telemetry: { usage, tools, permissions: false },
  };
}

export async function runExternalAgent(input: {
  agent: Exclude<AgentProduct, "dreamcode">;
  repoRoot: string;
  prompt: string;
  workspaceRoot: string;
  home: string;
  mode: RunMode;
  model?: string;
  timeoutMs?: number;
}): Promise<ExternalRun> {
  const command = await resolveAgentCommand(input.agent, input.repoRoot);
  const args = agentArguments(input.agent, input.prompt, input.home, input.model);
  const env = {
    ...process.env,
    DSH_HOME: path.join(input.home, "dsh"),
    XDG_DATA_HOME: path.join(input.home, "data"),
    XDG_CACHE_HOME: path.join(input.home, "cache"),
    XDG_CONFIG_HOME: path.join(input.home, "config"),
    CLAUDE_CONFIG_DIR: path.join(input.home, "claude"),
    PI_CODING_AGENT_DIR: path.join(input.home, "pi"),
  };
  const copyConfig = async (sourceRoot: string, destinationRoot: string, names: string[]) => {
    await mkdir(destinationRoot, { recursive: true });
    for (const name of names)
      if (await exists(path.join(sourceRoot, name)))
        await copyFile(path.join(sourceRoot, name), path.join(destinationRoot, name));
  };
  // Copy authentication/model settings, never prior sessions. All writes stay in the run home.
  if (input.agent === "dsh")
    await copyConfig(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), env.DSH_HOME, [
      ".env",
      ".credentials.yaml",
      "settings.yaml",
    ]);
  if (input.agent === "pi")
    await copyConfig(
      process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent"),
      env.PI_CODING_AGENT_DIR,
      ["auth.json", "models.json", "settings.json"],
    );
  if (input.agent === "claude-code") {
    await copyConfig(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      env.CLAUDE_CONFIG_DIR,
      [".credentials.json", "settings.json"],
    );
    const userConfig = path.join(os.homedir(), ".claude.json");
    if (await exists(userConfig))
      await copyFile(userConfig, path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"));
  }
  if (input.agent === "opencode") {
    await copyConfig(
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode"),
      path.join(env.XDG_CONFIG_HOME, "opencode"),
      ["opencode.json", "opencode.jsonc"],
    );
    await copyConfig(
      path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"), "opencode"),
      path.join(env.XDG_DATA_HOME, "opencode"),
      ["auth.json"],
    );
  }
  const policy = buildSandboxPolicy({
    mode: input.mode,
    workspaceRoot: input.workspaceRoot,
    sessionDir: input.home,
  });
  // Agent-owned session data is writable; the source project and user home remain outside the write roots.
  if (policy.enforcement === "managed")
    policy.writableRoots = [input.home, ...policy.writableRoots];
  await mkdir(input.home, { recursive: true });
  const spec = await prepareSandboxedSpawn({
    program: command[0]!,
    args: [...command.slice(1), ...args],
    cwd: input.workspaceRoot,
    env,
    policy,
  });
  const startedAt = new Date().toISOString();
  const records: Record<string, any>[] = [];
  let pending = "";
  const consumeLine = (line: string) => {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value))
        records.push({ ...value, _evalObservedAt: new Date().toISOString() });
    } catch {
      /* Non-JSON output remains captured below. */
    }
  };
  const output = await new Promise<{
    stdout: string;
    stderr: string;
    code: number;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(spec.program, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid)
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else child.kill("SIGTERM");
    }, input.timeoutMs ?? 600_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      if (stdout.length > 16_000_000) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-64_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1, timedOut });
    });
  });
  if (pending.trim()) consumeLine(pending);
  const normalized = normalizeAgentRecords(input.agent, records);
  if (input.agent === "dsh") {
    normalized.raw = [{ stdout: output.stdout }];
    normalized.events.at(-1)!.payload = { finalText: output.stdout.trim() };
  } else if (!records.length) {
    normalized.raw = [{ stdout: output.stdout }];
    normalized.events.at(-1)!.type = "turn.failed";
    normalized.events.at(-1)!.payload = {
      error: `没有输出有效 JSON 事件：${output.stderr.slice(-1000)}`,
    };
  }
  normalized.events.unshift({
    id: randomUUID(),
    sessionId: normalized.events[0]!.sessionId,
    type: "turn.started",
    timestamp: startedAt,
    payload: { agent: input.agent, model: input.model },
  });
  if (output.code !== 0 || output.timedOut || !output.stdout.trim()) {
    normalized.events.at(-1)!.type = "turn.failed";
    normalized.events.at(-1)!.payload = {
      ...(normalized.events.at(-1)!.payload as object),
      exitCode: output.code,
      timedOut: output.timedOut,
      error: output.stderr,
    };
  }
  normalized.stderr = output.stderr;
  return normalized;
}
