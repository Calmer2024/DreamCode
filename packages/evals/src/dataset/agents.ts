import path from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadDreamCodeConfig } from "@dreamcode/store";
import { resolveModelProviderConfig } from "@dreamcode/models";
import { configuredProfileEntries } from "./configured-profiles.js";

export const DATASET_AGENTS = [
  { id: "dreamcode", label: "DreamCode" },
  { id: "claude-code", label: "Claude Code" },
  { id: "pi", label: "Pi" },
  { id: "dsh", label: "DeepSeek Harness" },
  { id: "opencode", label: "OpenCode" },
] as const;
export type DatasetAgent = (typeof DATASET_AGENTS)[number]["id"];
export type ExternalAgent = Exclude<DatasetAgent, "dreamcode">;
export interface AgentInstallation {
  version: 1;
  image: string;
  volume: string;
  lockDigest: string;
  agents: Record<ExternalAgent, { version: string; command: string[] }>;
}
export interface ModelEndpoint {
  protocol: "openai" | "anthropic";
  baseURL: string;
  apiKey: string;
  model: string;
  provider: string;
  authType?: "bearer" | "api-key";
}
/** Read afresh so cc-switch changes take effect without restarting the server. */
export async function configuredClaudeEndpoints(
  directory = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"),
): Promise<ModelEndpoint[]> {
  const text = await readFile(path.join(directory, "settings.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    },
  );
  let settings: { env?: Record<string, unknown>; model?: unknown };
  try {
    settings = JSON.parse(text);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw Error();
  } catch {
    throw Error("Claude Code settings.json 格式无效");
  }
  const env = { ...process.env, ...settings.env };
  const value = (key: string) => (typeof env[key] === "string" ? env[key]!.trim() : "");
  const token = value("ANTHROPIC_AUTH_TOKEN"),
    key = value("ANTHROPIC_API_KEY");
  if (!token && !key) return [];
  const baseURL = value("ANTHROPIC_BASE_URL") || "https://api.anthropic.com";
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw Error("Claude Code 模型端点必须是 HTTP(S) URL");
  const aliases = Object.fromEntries(
    ["OPUS", "SONNET", "HAIKU"].map((alias) => [
      alias.toLowerCase(),
      value(`ANTHROPIC_DEFAULT_${alias}_MODEL`),
    ]),
  );
  const resolve = (model: string) => {
    const alias = model.replace(/\[1m\]$/, "");
    return aliases[alias]
      ? `${aliases[alias]}${model.endsWith("[1m]") && !aliases[alias]!.endsWith("[1m]") ? "[1m]" : ""}`
      : model;
  };
  const active =
    value("ANTHROPIC_MODEL") || (typeof settings.model === "string" ? settings.model : "");
  return [...new Set([active, ...Object.values(aliases)].filter(Boolean).map(resolve))].map(
    (model) => ({
      protocol: "anthropic",
      baseURL: url.toString().replace(/\/$/, ""),
      apiKey: token || key,
      authType: token ? "bearer" : "api-key",
      model,
      provider: "claude-code-config",
    }),
  );
}
export function isDatasetAgent(value: unknown): value is DatasetAgent {
  return DATASET_AGENTS.some((agent) => agent.id === value);
}
export async function readAgentInstallation(repoRoot: string): Promise<AgentInstallation> {
  const file =
    process.env.DREAMEVAL_AGENT_INSTALLATION ??
    path.join(repoRoot, "evals/agents/installation.json");
  const value = JSON.parse(await readFile(file, "utf8")) as AgentInstallation;
  if (
    value.version !== 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(value.image) ||
    !/^dreameval-harness-[a-f0-9]{16,64}$/.test(value.volume) ||
    !/^[a-f0-9]{64}$/.test(value.lockDigest)
  )
    throw Error("Invalid Agent installation receipt");
  for (const agent of DATASET_AGENTS.filter((agent) => agent.id !== "dreamcode")) {
    const entry = value.agents[agent.id as ExternalAgent];
    if (
      !entry?.version ||
      !Array.isArray(entry.command) ||
      !entry.command.length ||
      entry.command.some((argument) => typeof argument !== "string" || /[\r\n]/.test(argument)) ||
      ![
        "node",
        "/opt/harness/node_modules/.bin/claude",
        "/opt/harness/node_modules/.bin/opencode",
      ].includes(entry.command[0]!)
    )
      throw Error(`Invalid installation entry: ${agent.id}`);
  }
  const { stdout } = await promisify(execFile)("docker", ["volume", "inspect", value.volume], {
    timeout: 10000,
  });
  const volume = JSON.parse(stdout)[0];
  if (
    volume.Labels?.["dreameval.image"] !== value.image ||
    volume.Labels?.["dreameval.lock"] !== value.lockDigest
  )
    throw Error("Agent volume does not match installation receipt");
  return value;
}
export async function datasetAgentCatalog(repoRoot: string) {
  const installation = await readAgentInstallation(repoRoot).catch(() => null);
  return DATASET_AGENTS.map((agent) => ({
    ...agent,
    available: agent.id === "dreamcode" || !!installation,
    version:
      agent.id === "dreamcode" ? "workspace" : (installation?.agents[agent.id].version ?? null),
    detail:
      agent.id === "dreamcode"
        ? "内置容器运行器"
        : installation
          ? "固定版本 · 同一题目容器 · 隔离会话"
          : "尚未安装评测容器内的框架运行环境",
  }));
}
/** Resolve credentials only on the host. The CLI receives a loopback bridge and a dummy key. */
export async function savedAgentEndpoint(
  model: string,
  agent: ExternalAgent,
): Promise<ModelEndpoint> {
  if (agent === "claude-code") {
    const endpoint = (await configuredClaudeEndpoints()).find((entry) => entry.model === model);
    if (endpoint) return endpoint;
  }
  const config = await loadDreamCodeConfig();
  const matches = configuredProfileEntries(config).filter((entry) => entry.model === model);
  if (matches.length !== 1) throw Error(`Expected one configured credential profile for ${model}`);
  const profile = matches[0]!.profile;
  const resolved = resolveModelProviderConfig({
    provider: profile.provider,
    model,
    apiKey: profile.apiKey ?? process.env[profile.apiKeyEnv!],
    baseURL: profile.baseURL,
  });
  if (!resolved.baseURL || !resolved.apiKey) throw Error("Model endpoint is not configured");
  const url = new URL(resolved.baseURL);
  if (agent === "claude-code" || agent === "dsh") {
    // Both vendors expose native Anthropic endpoints; no protocol translation.
    const official =
      (resolved.providerId === "mimo" && /(^|\.)xiaomimimo\.com$/.test(url.hostname)) ||
      (resolved.providerId === "deepseek" && url.hostname === "api.deepseek.com");
    if (!official)
      throw Error(
        `${agent === "dsh" ? "DeepSeek Harness" : "Claude Code"} 需要配置 MiMo 或 DeepSeek 官方 Anthropic 端点；不会自动转换其他服务的 API 协议`,
      );
    url.pathname = "/anthropic";
  }
  return {
    protocol: agent === "claude-code" || agent === "dsh" ? "anthropic" : "openai",
    baseURL: url.toString().replace(/\/$/, ""),
    apiKey: resolved.apiKey,
    model,
    provider: resolved.providerId,
  };
}
