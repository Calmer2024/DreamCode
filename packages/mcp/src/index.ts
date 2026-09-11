import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@dreamcode/shared";
import type { ToolRegistry } from "@dreamcode/tools";
import {
  type CallToolResult,
  Client,
  type Tool as McpSdkTool,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Ajv, { type ValidateFunction } from "ajv";
import { z } from "zod";

export const MCP_RUNTIME_VERSION = "0.1.0";
const CONNECT_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_FAILURE_LIMIT = 2;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TOOLS_PER_SERVER = 256;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const MAX_RESULT_BYTES = 50 * 1024 * 1024;
const PUBLIC_TOOL_NAME_LIMIT = 64;
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const TEMPLATE_PATTERN = /\$\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const PROTECTED_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "origin",
  "host",
  "content-length",
]);

const reconnectSchema = z
  .object({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().int().min(50).max(60_000).default(500),
    maxDelayMs: z.number().int().min(100).max(300_000).default(30_000),
    maxAttempts: z.number().int().min(1).max(100).default(10),
  })
  .strict()
  .default({});

const commonSchema = {
  enabled: z.boolean(),
  toolCallTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30 * 60_000)
    .default(60_000),
  reconnect: reconnectSchema,
};

const stdioSchema = z
  .object({
    transport: z.literal("stdio"),
    ...commonSchema,
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    cwd: z.string().trim().min(1).optional(),
  })
  .strict();

const httpSchema = z
  .object({
    transport: z.literal("streamable-http"),
    ...commonSchema,
    url: z.string().trim().url(),
    headers: z.record(z.string()).default({}),
  })
  .strict();

export const mcpServerConfigSchema = z.discriminatedUnion("transport", [stdioSchema, httpSchema]);
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpTransportKind = McpServerConfig["transport"];
export type McpRuntimeState =
  | "disabled"
  | "invalid"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "stopping";

export interface McpConfigItem {
  serverId: string;
  valid: boolean;
  enabled: boolean;
  transport?: McpTransportKind;
  config?: McpServerConfig;
  error?: string;
}

export interface McpConfigSnapshot {
  items: McpConfigItem[];
}
export interface McpServerStatus {
  serverId: string;
  transport?: McpTransportKind;
  enabled: boolean;
  state: McpRuntimeState;
  toolCount: number;
  reconnectAttempt?: number;
  error?: string;
  command?: string;
  url?: string;
  protocolVersion?: string;
}
export interface McpRuntimeSnapshot {
  generation: number;
  servers: McpServerStatus[];
}

export function parseMcpServerConfigs(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): McpConfigSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { items: [] };
  return {
    items: Object.entries(input).map(([serverId, raw]): McpConfigItem => {
      if (!SERVER_ID_PATTERN.test(serverId))
        return invalidItem(serverId, false, "Server 名必须匹配 [A-Za-z0-9_-]{1,32}。", raw);
      const parsed = mcpServerConfigSchema.safeParse(raw);
      if (!parsed.success)
        return invalidItem(serverId, readEnabled(raw), firstZodError(parsed.error), raw);
      try {
        const config = resolveConfig(parsed.data, environment);
        validateConfigSecurity(config);
        return {
          serverId,
          valid: true,
          enabled: config.enabled,
          transport: config.transport,
          config,
        };
      } catch (error) {
        return invalidItem(serverId, parsed.data.enabled, safeError(error), raw);
      }
    }),
  };
}

function invalidItem(
  serverId: string,
  enabled: boolean,
  error: string,
  raw: unknown,
): McpConfigItem {
  const transport = readTransport(raw);
  return { serverId, valid: false, enabled, ...(transport ? { transport } : {}), error };
}
function readEnabled(raw: unknown): boolean {
  return Boolean(isRecord(raw) && raw.enabled === true);
}
function readTransport(raw: unknown): McpTransportKind | undefined {
  if (!isRecord(raw)) return undefined;
  return raw.transport === "stdio" || raw.transport === "streamable-http"
    ? raw.transport
    : undefined;
}
function firstZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "配置"}: ${issue.message}` : "MCP 配置无效。";
}
function resolveConfig(config: McpServerConfig, environment: NodeJS.ProcessEnv): McpServerConfig {
  if (config.transport === "stdio")
    return {
      ...config,
      env: mapValues(config.env, (value) => expandEnvironment(value, environment)),
    };
  return {
    ...config,
    headers: mapValues(config.headers, (value) => expandEnvironment(value, environment)),
  };
}
function expandEnvironment(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(
    TEMPLATE_PATTERN,
    (_whole, escaped: string | undefined, expanded: string | undefined) => {
      if (escaped) return `\${${escaped}}`;
      const resolved = expanded ? environment[expanded] : undefined;
      if (resolved === undefined) throw new Error(`缺少环境变量 ${expanded ?? ""}。`);
      return resolved;
    },
  );
}
function mapValues(
  input: Record<string, string>,
  map: (value: string) => string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, map(value)]));
}
function validateConfigSecurity(config: McpServerConfig): void {
  if (config.transport === "stdio") {
    if (config.cwd && !path.isAbsolute(config.cwd)) throw new Error("stdio cwd 必须是绝对路径。");
    return;
  }
  const url = new URL(config.url);
  if (url.username || url.password) throw new Error("MCP URL 不允许包含用户名或密码。");
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("远程 MCP Server 必须使用 HTTPS。");
  for (const header of Object.keys(config.headers)) {
    if (PROTECTED_HEADERS.has(header.toLowerCase()))
      throw new Error(`header ${header} 由 MCP transport 管理。`);
  }
}

interface RuntimeEntry {
  item: McpConfigItem;
  status: McpServerStatus;
  client?: Client;
  transport?: Transport;
  stdio?: StdioClientTransport;
  tools: McpSdkTool[];
  queue: Promise<void>;
  stopping: boolean;
  reconnectTimer?: NodeJS.Timeout;
  stableTimer?: NodeJS.Timeout;
  healthTimer?: NodeJS.Timeout;
  reconnectAttempt: number;
  healthFailures: number;
  stderr: string;
  secrets: string[];
  changeTimestamps: number[];
}

export interface McpRuntimeOptions {
  registry: ToolRegistry;
  onSnapshot?: (snapshot: McpRuntimeSnapshot) => void;
}

export class McpRuntime {
  readonly registry: ToolRegistry;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly listeners = new Set<(snapshot: McpRuntimeSnapshot) => void>();
  private generation = 0;
  private disposed = false;

  constructor(options: McpRuntimeOptions) {
    this.registry = options.registry;
    if (options.onSnapshot) this.listeners.add(options.onSnapshot);
  }
  current(): McpRuntimeSnapshot {
    return {
      generation: this.generation,
      servers: [...this.entries.values()].map((entry) => ({ ...entry.status })),
    };
  }
  subscribe(listener: (snapshot: McpRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.current());
    return () => this.listeners.delete(listener);
  }
  async reconcile(
    snapshot: McpConfigSnapshot,
    options: { force?: boolean } = {},
  ): Promise<McpRuntimeSnapshot> {
    if (this.disposed) throw new Error("MCP Runtime 已关闭。");
    const nextIds = new Set(snapshot.items.map((item) => item.serverId));
    await Promise.all(
      [...this.entries.keys()].filter((id) => !nextIds.has(id)).map((id) => this.remove(id)),
    );
    for (const item of snapshot.items) {
      const existing = this.entries.get(item.serverId);
      if (!existing) {
        const entry = createEntry(item);
        this.entries.set(item.serverId, entry);
        this.publish();
        if (item.valid && item.enabled) void this.connect(entry, false);
        continue;
      }
      if (
        !options.force &&
        sameConnectionConfig(existing.item.config, item.config) &&
        existing.item.enabled === item.enabled &&
        existing.item.valid === item.valid
      ) {
        existing.item = item;
        continue;
      }
      await this.stop(existing, true);
      existing.item = item;
      existing.status = statusForItem(item);
      existing.tools = [];
      existing.reconnectAttempt = 0;
      existing.healthFailures = 0;
      existing.stopping = false;
      existing.secrets = secretsFor(item.config);
      this.publish();
      if (item.valid && item.enabled) void this.connect(existing, false);
    }
    return this.current();
  }
  async setEnabled(serverId: string, enabled: boolean): Promise<McpRuntimeSnapshot> {
    const entry = this.entries.get(serverId);
    if (!entry) throw new Error(`MCP Server 不存在: ${serverId}`);
    if (!entry.item.valid && enabled) throw new Error(entry.item.error ?? "MCP 配置无效。");
    entry.item = {
      ...entry.item,
      enabled,
      config: entry.item.config ? { ...entry.item.config, enabled } : undefined,
    };
    if (!enabled) {
      await this.stop(entry, true);
      entry.status = {
        ...entry.status,
        enabled: false,
        state: "disabled",
        toolCount: 0,
        error: undefined,
      };
      entry.stopping = false;
      this.publish();
    } else {
      entry.stopping = false;
      entry.status = { ...entry.status, enabled: true, state: "connecting", error: undefined };
      this.publish();
      void this.connect(entry, false);
    }
    return this.current();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.entries.values()].map((entry) => this.stop(entry, true)));
    this.entries.clear();
    this.publish();
  }
  private async remove(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    await this.stop(entry, true);
    this.entries.delete(serverId);
    this.publish();
  }
  private async connect(entry: RuntimeEntry, reconnecting: boolean): Promise<void> {
    if (entry.stopping || !entry.item.enabled || !entry.item.config || this.disposed) return;
    entry.status = {
      ...entry.status,
      enabled: true,
      state: reconnecting ? "reconnecting" : "connecting",
      reconnectAttempt: reconnecting ? entry.reconnectAttempt : undefined,
      error: undefined,
    };
    this.publish();
    const config = entry.item.config;
    try {
      const client = new Client(
        { name: "DreamCode", version: MCP_RUNTIME_VERSION },
        {
          capabilities: {},
          versionNegotiation: {
            mode: "auto",
            probe: { timeoutMs: CONNECT_TIMEOUT_MS, maxRetries: 0 },
          },
          inputRequired: { autoFulfill: false },
          listMaxPages: 64,
          listChanged: {
            tools: {
              debounceMs: 250,
              onChanged: (error, tools) => void this.handleToolsChanged(entry, error, tools),
            },
          },
        },
      );
      const transport = this.createTransport(entry, config);
      entry.client = client;
      entry.transport = transport;
      client.onerror = (error) => this.noteError(entry, error);
      client.onclose = () => {
        if (!entry.stopping && entry.item.enabled && entry.client === client)
          this.scheduleReconnect(entry, new Error("MCP 连接已关闭。"));
      };
      await client.connect(transport, {
        timeout: CONNECT_TIMEOUT_MS,
        maxTotalTimeout: CONNECT_TIMEOUT_MS,
      });
      if (entry.stopping || entry.client !== client) return;
      const listed = await client.listTools(undefined, {
        timeout: LIST_TIMEOUT_MS,
        maxTotalTimeout: LIST_TIMEOUT_MS,
        cacheMode: "refresh",
      });
      await this.publishTools(entry, listed.tools);
      entry.healthFailures = 0;
      entry.status = {
        ...entry.status,
        state: "connected",
        toolCount: entry.tools.length,
        reconnectAttempt: undefined,
        error: undefined,
        protocolVersion: client.getNegotiatedProtocolVersion(),
      };
      clearTimer(entry.stableTimer);
      entry.stableTimer = setTimeout(() => {
        entry.reconnectAttempt = 0;
      }, config.reconnect.maxDelayMs);
      this.scheduleHealth(entry);
      this.publish();
    } catch (error) {
      if (entry.stopping) return;
      await this.closeClient(entry);
      if (isRetryable(error)) this.scheduleReconnect(entry, error);
      else this.fail(entry, error);
    }
  }
  private createTransport(entry: RuntimeEntry, config: McpServerConfig): Transport {
    if (config.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: { ...getDefaultEnvironment(), ...config.env },
        stderr: "pipe",
        maxBufferSize: MAX_LIST_BYTES,
      });
      entry.stdio = transport;
      transport.stderr?.on("data", (chunk) => {
        entry.stderr = redact(`${entry.stderr}${String(chunk)}`, entry.secrets).slice(
          -MAX_STDERR_BYTES,
        );
      });
      return transport;
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers, redirect: "error" },
      onInsufficientScope: "throw",
    });
  }
  private async handleToolsChanged(
    entry: RuntimeEntry,
    error: Error | null,
    tools: McpSdkTool[] | null,
  ): Promise<void> {
    const now = Date.now();
    entry.changeTimestamps = entry.changeTimestamps.filter((value) => now - value < 60_000);
    entry.changeTimestamps.push(now);
    if (entry.changeTimestamps.length > 30) {
      entry.status = { ...entry.status, error: "工具列表变化过于频繁，继续使用上一版本。" };
      this.publish();
      return;
    }
    if (error || !tools) {
      entry.status = { ...entry.status, error: "工具刷新失败，继续使用上一版本。" };
      this.publish();
      return;
    }
    try {
      await this.publishTools(entry, tools);
      entry.status = { ...entry.status, toolCount: tools.length, error: undefined };
      this.publish();
    } catch (syncError) {
      entry.status = {
        ...entry.status,
        error: `工具刷新失败，继续使用上一版本：${safeError(syncError)}`,
      };
      this.publish();
    }
  }
  private async publishTools(entry: RuntimeEntry, tools: McpSdkTool[]): Promise<void> {
    validateToolList(tools);
    this.registry.replaceNamespace(
      namespaceFor(entry.item.serverId),
      tools.map((tool) => this.adaptTool(entry, tool)),
    );
    entry.tools = tools;
  }
  private adaptTool(entry: RuntimeEntry, definition: McpSdkTool): Tool {
    const config = entry.item.config!;
    const validate = compileSchema(definition.inputSchema as Record<string, unknown>);
    return {
      name: publicToolName(entry.item.serverId, definition.name),
      description:
        definition.description?.trim() ||
        `MCP tool ${definition.name} from ${entry.item.serverId}.`,
      inputSchema: sanitizeSchema(definition.inputSchema as Record<string, unknown>),
      source: { kind: "mcp", serverId: entry.item.serverId, rawToolName: definition.name },
      risk: { tags: ["mcp_tool", "external_side_effect"], externalSideEffects: true },
      schedule: { mode: "parallel", concurrencyGroup: `mcp:${entry.item.serverId}` },
      preflight: (input: unknown, context: ToolExecutionContext) =>
        validate(input)
          ? undefined
          : toolError(
              context.toolCallId,
              "mcp_input_invalid",
              "MCP 工具输入不符合 Server Schema。",
              false,
              validate.errors,
            ),
      execute: (input: unknown, context: ToolExecutionContext) =>
        this.enqueueCall(entry.item.serverId, definition, input, context, config.toolCallTimeoutMs),
    };
  }
  private async enqueueCall(
    serverId: string,
    definition: McpSdkTool,
    input: unknown,
    context: ToolExecutionContext,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const entry = this.entries.get(serverId);
    if (!entry?.item.enabled)
      return toolError(context.toolCallId, "tool_unavailable", "MCP Server 已关闭。", true);
    let resolve!: (result: ToolResult) => void;
    const result = new Promise<ToolResult>((done) => {
      resolve = done;
    });
    entry.queue = entry.queue
      .then(async () => {
        if (context.signal?.aborted) {
          resolve(cancelled(context.toolCallId));
          return;
        }
        const current = this.entries.get(serverId);
        if (!current?.client || current.status.state !== "connected") {
          resolve(
            toolError(
              context.toolCallId,
              "mcp_connection_lost",
              "MCP Server 当前不可用或正在重连。",
              true,
            ),
          );
          return;
        }
        try {
          const output = await current.client.callTool(
            { name: definition.name, arguments: isRecord(input) ? input : {} },
            {
              signal: context.signal,
              timeout: timeoutMs,
              maxTotalTimeout: timeoutMs,
              toolDefinition: definition,
            },
          );
          resolve(await projectCallResult(context, serverId, definition.name, output));
        } catch (error) {
          resolve(mapCallError(context.toolCallId, error, current.secrets));
        }
      })
      .catch(() => undefined);
    return result;
  }
  private scheduleHealth(entry: RuntimeEntry): void {
    clearTimer(entry.healthTimer);
    entry.healthTimer = setTimeout(async () => {
      if (entry.stopping || entry.status.state !== "connected" || !entry.client) return;
      try {
        await entry.client.ping({
          timeout: CONNECT_TIMEOUT_MS,
          maxTotalTimeout: CONNECT_TIMEOUT_MS,
        });
        entry.healthFailures = 0;
        this.scheduleHealth(entry);
      } catch (error) {
        entry.healthFailures += 1;
        if (entry.healthFailures >= HEALTH_FAILURE_LIMIT) {
          await this.closeClient(entry);
          this.scheduleReconnect(entry, error);
        } else this.scheduleHealth(entry);
      }
    }, HEALTH_INTERVAL_MS);
  }
  private scheduleReconnect(entry: RuntimeEntry, error: unknown): void {
    if (entry.stopping || !entry.item.config || !entry.item.enabled) return;
    clearTimer(entry.healthTimer);
    clearTimer(entry.stableTimer);
    const policy = entry.item.config.reconnect;
    if (!policy.enabled || entry.reconnectAttempt >= policy.maxAttempts) {
      this.fail(entry, error);
      return;
    }
    entry.reconnectAttempt += 1;
    const delay = Math.min(
      policy.maxDelayMs,
      policy.initialDelayMs * 2 ** (entry.reconnectAttempt - 1),
    );
    entry.status = {
      ...entry.status,
      state: "reconnecting",
      reconnectAttempt: entry.reconnectAttempt,
      error: redact(safeError(error), entry.secrets),
    };
    this.publish();
    clearTimer(entry.reconnectTimer);
    entry.reconnectTimer = setTimeout(() => void this.connect(entry, true), delay);
  }
  private fail(entry: RuntimeEntry, error: unknown): void {
    this.registry.removeNamespace(namespaceFor(entry.item.serverId));
    entry.tools = [];
    entry.status = {
      ...entry.status,
      state: "failed",
      toolCount: 0,
      reconnectAttempt: undefined,
      error: redact(safeError(error), entry.secrets),
    };
    this.publish();
  }
  private noteError(entry: RuntimeEntry, error: Error): void {
    entry.status = { ...entry.status, error: redact(safeError(error), entry.secrets) };
    this.publish();
  }
  private async stop(entry: RuntimeEntry, unregister: boolean): Promise<void> {
    entry.stopping = true;
    clearTimer(entry.reconnectTimer);
    clearTimer(entry.stableTimer);
    clearTimer(entry.healthTimer);
    entry.status = { ...entry.status, state: "stopping" };
    if (unregister) this.registry.removeNamespace(namespaceFor(entry.item.serverId));
    await this.closeClient(entry);
    entry.tools = [];
    entry.stderr = "";
  }
  private async closeClient(entry: RuntimeEntry): Promise<void> {
    const client = entry.client;
    const pid = entry.stdio?.pid ?? undefined;
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdio = undefined;
    if (!client) return;
    let closed = false;
    await Promise.race([
      client
        .close()
        .catch(() => undefined)
        .then(() => {
          closed = true;
        }),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
    if (pid && !closed) await killProcessTree(pid).catch(() => undefined);
  }
  private publish(): void {
    this.generation += 1;
    const snapshot = this.current();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function createEntry(item: McpConfigItem): RuntimeEntry {
  return {
    item,
    status: statusForItem(item),
    tools: [],
    queue: Promise.resolve(),
    stopping: false,
    reconnectAttempt: 0,
    healthFailures: 0,
    stderr: "",
    secrets: secretsFor(item.config),
    changeTimestamps: [],
  };
}
function statusForItem(item: McpConfigItem): McpServerStatus {
  return {
    serverId: item.serverId,
    transport: item.transport,
    enabled: item.enabled,
    state: item.valid ? (item.enabled ? "connecting" : "disabled") : "invalid",
    toolCount: 0,
    error: item.error,
    ...(item.config?.transport === "stdio" ? { command: item.config.command } : {}),
    ...(item.config?.transport === "streamable-http" ? { url: item.config.url } : {}),
  };
}
function sameConnectionConfig(
  left: McpServerConfig | undefined,
  right: McpServerConfig | undefined,
): boolean {
  if (!left || !right) return left === right;
  const omitReconnect = (value: McpServerConfig) => {
    const { reconnect: _reconnect, ...rest } = value;
    return rest;
  };
  return JSON.stringify(omitReconnect(left)) === JSON.stringify(omitReconnect(right));
}
function validateToolList(tools: McpSdkTool[]): void {
  if (tools.length > MAX_TOOLS_PER_SERVER)
    throw new Error(`Tool 数量超过上限 ${MAX_TOOLS_PER_SERVER}。`);
  if (Buffer.byteLength(JSON.stringify({ tools }), "utf8") > MAX_LIST_BYTES)
    throw new Error("tools/list 响应超过 8 MiB。");
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.name?.trim()) throw new Error("MCP Tool 名不能为空。");
    if (names.has(tool.name)) throw new Error(`MCP Server 返回了重复 Tool：${tool.name}`);
    names.add(tool.name);
    if (Buffer.byteLength(tool.description ?? "", "utf8") > MAX_DESCRIPTION_BYTES)
      throw new Error(`Tool ${tool.name} description 超限。`);
    validateSchemaLimits(tool.inputSchema, tool.name, "inputSchema");
    if (tool.outputSchema) validateSchemaLimits(tool.outputSchema, tool.name, "outputSchema");
    compileSchema(tool.inputSchema as Record<string, unknown>);
    if (tool.outputSchema) compileSchema(tool.outputSchema as Record<string, unknown>);
  }
}
function validateSchemaLimits(schema: unknown, toolName: string, field: string): void {
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES)
    throw new Error(`Tool ${toolName} ${field} 超过 256 KiB。`);
  if (valueDepth(schema) > MAX_SCHEMA_DEPTH)
    throw new Error(`Tool ${toolName} ${field} 嵌套超过 64 层。`);
}
function valueDepth(value: unknown, seen = new Set<object>()): number {
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value as object)) throw new Error("Schema 包含循环引用。");
  seen.add(value as object);
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const depth = 1 + children.reduce((max, child) => Math.max(max, valueDepth(child, seen)), 0);
  seen.delete(value as object);
  return depth;
}
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  return ajv.compile(schema);
}
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  delete clone.$schema;
  return clone.type === "object" ? clone : { ...clone, type: "object" };
}
export function publicToolName(serverId: string, rawToolName: string): string {
  const source = `mcp__${serverId}__${rawToolName}`;
  const normalized = source.replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized === source && normalized.length <= PUBLIC_TOOL_NAME_LIMIT) return normalized;
  const hash = createHash("sha256")
    .update(`${serverId}\0${rawToolName}`)
    .digest("hex")
    .slice(0, 12);
  return `${normalized.slice(0, PUBLIC_TOOL_NAME_LIMIT - hash.length - 2)}__${hash}`;
}
async function projectCallResult(
  context: ToolExecutionContext,
  serverId: string,
  rawToolName: string,
  result: CallToolResult,
): Promise<ToolResult> {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES)
    return toolError(
      context.toolCallId,
      "mcp_result_too_large",
      "MCP 工具结果超过 50 MiB。",
      false,
    );
  const content: unknown[] = [];
  const text: string[] = [];
  const artifactRefs: string[] = [];
  for (let index = 0; index < result.content.length; index += 1) {
    const block = result.content[index] as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      content.push(block);
      continue;
    }
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      const bytes = Buffer.from(block.data, "base64");
      const artifactRef = await writeMcpArtifact(
        context.sessionDir,
        context.toolCallId,
        index,
        String(block.mimeType ?? "application/octet-stream"),
        bytes,
      );
      artifactRefs.push(artifactRef);
      content.push({
        type: block.type,
        mimeType: block.mimeType,
        bytes: bytes.length,
        artifactRef,
      });
      text.push(`[${String(block.type)} ${String(block.mimeType ?? "")} ${artifactRef}]`);
      continue;
    }
    if (
      block.type === "resource" &&
      isRecord(block.resource) &&
      typeof block.resource.blob === "string"
    ) {
      const bytes = Buffer.from(block.resource.blob, "base64");
      const mimeType = String(block.resource.mimeType ?? "application/octet-stream");
      const artifactRef = await writeMcpArtifact(
        context.sessionDir,
        context.toolCallId,
        index,
        mimeType,
        bytes,
      );
      artifactRefs.push(artifactRef);
      content.push({
        type: "resource",
        uri: block.resource.uri,
        mimeType,
        bytes: bytes.length,
        artifactRef,
      });
      text.push(`[MCP resource ${String(block.resource.uri ?? "")} ${artifactRef}]`);
      continue;
    }
    const bytes = Buffer.from(JSON.stringify(block), "utf8");
    const artifactRef = await writeMcpArtifact(
      context.sessionDir,
      context.toolCallId,
      index,
      "application/json",
      bytes,
    );
    artifactRefs.push(artifactRef);
    content.push({ type: block.type, bytes: bytes.length, artifactRef });
    text.push(`[MCP ${String(block.type ?? "content")} block ${artifactRef}]`);
  }
  const summary = text.join("\n").trim() || `Called MCP tool ${serverId}.${rawToolName}.`;
  if (result.isError) {
    const projected = toolError(
      context.toolCallId,
      "mcp_tool_error",
      summary.slice(0, 8_000),
      false,
      {
        content,
        structuredContent: result.structuredContent,
      },
    );
    return { ...projected, ...(artifactRefs.length ? { artifactRefs } : {}) };
  }
  return {
    toolCallId: context.toolCallId,
    status: "success",
    summary: summary.slice(0, 8_000),
    data: { content, structuredContent: result.structuredContent },
    ...(artifactRefs.length ? { artifactRefs } : {}),
  };
}
async function writeMcpArtifact(
  sessionDir: string,
  toolCallId: string,
  index: number,
  mimeType: string,
  bytes: Buffer,
): Promise<string> {
  const disk = await statfs(sessionDir);
  if (disk.bavail * disk.bsize < bytes.length + 64 * 1024 * 1024)
    throw new Error("保存 MCP artifact 的磁盘空间不足。");
  const extension = mimeExtension(mimeType);
  const fileName = `mcp-${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}-${index}.${extension}`;
  const directory = path.join(sessionDir, "artifacts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), bytes);
  return `artifact://${encodeURIComponent(fileName)}`;
}
function mimeExtension(mimeType: string): string {
  return (
    (
      {
        "application/json": "json",
        "text/plain": "txt",
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "audio/mpeg": "mp3",
        "audio/wav": "wav",
      } as Record<string, string>
    )[mimeType] ?? "bin"
  );
}
function mapCallError(toolCallId: string, error: unknown, secrets: string[]): ToolResult {
  const message = redact(safeError(error), secrets).slice(0, 8_000);
  if (isAbort(error)) return cancelled(toolCallId);
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)
    return toolError(toolCallId, "mcp_tool_timeout", message, true, undefined, true);
  if (
    error instanceof SdkError &&
    [SdkErrorCode.ConnectionClosed, SdkErrorCode.NotConnected, SdkErrorCode.SendFailed].includes(
      error.code,
    )
  )
    return toolError(toolCallId, "mcp_connection_lost", message, true);
  return toolError(toolCallId, "mcp_protocol_error", message, false);
}
function toolError(
  toolCallId: string,
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
  sideEffectsUncertain?: boolean,
): ToolResult {
  return {
    toolCallId,
    status: "error",
    summary: message,
    error: {
      code,
      category: code.includes("timeout") ? "timeout" : "execution",
      message,
      retryable,
      details,
    },
    ...(sideEffectsUncertain
      ? {
          execution: {
            outcome: "timed_out",
            started: true,
            timedOut: true,
            sideEffectsUncertain: true,
          },
        }
      : {}),
  };
}
function cancelled(toolCallId: string): ToolResult {
  return {
    toolCallId,
    status: "cancelled",
    summary: "MCP 工具调用已取消。",
    error: {
      code: "mcp_cancelled",
      category: "cancelled",
      message: "MCP 工具调用已取消。",
      retryable: false,
    },
  };
}
function isRetryable(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return false;
  if (error instanceof SdkError)
    return ![
      SdkErrorCode.ClientHttpAuthentication,
      SdkErrorCode.ClientHttpForbidden,
      SdkErrorCode.InvalidResult,
      SdkErrorCode.MethodNotSupportedByProtocolVersion,
    ].includes(error.code);
  const candidate = error as { code?: unknown; status?: unknown } | undefined;
  if (candidate?.code === "ENOENT" || candidate?.code === "EACCES") return false;
  if (candidate?.status === 401 || candidate?.status === 403) return false;
  return true;
}
function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|cancelled/i.test(error.message))
  );
}
function namespaceFor(serverId: string): string {
  return `mcp:${serverId}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function clearTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer) clearTimeout(timer);
}
function secretsFor(config: McpServerConfig | undefined): string[] {
  if (!config) return [];
  const values =
    config.transport === "stdio" ? Object.values(config.env) : Object.values(config.headers);
  return values.filter((value) => value.length >= 8);
}
function redact(value: string, secrets: string[]): string {
  let output = value;
  for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
  return output.replace(/(?:bearer\s+|api[_-]?key[=:]\s*)[A-Za-z0-9._~+/-]{8,}/gi, "$1[REDACTED]");
}
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* exited */
      }
    }
    return;
  }
  await new Promise<void>((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => resolve());
  });
}
