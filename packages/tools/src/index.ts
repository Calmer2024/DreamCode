import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPermissionCapabilityContract,
  isSecretPath,
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "@dreamcode/safety";
import type {
  ChangedFile,
  ExecutionOutcome,
  RuntimeInfo,
  ShellKind,
  TodoItem,
  Tool,
  ToolExecutionContext,
  ToolModelSpec,
  ToolResult,
} from "@dreamcode/shared";
import { todoItemSchema, toErrorMessage } from "@dreamcode/shared";
import { createTwoFilesPatch } from "diff";
import fg from "fast-glob";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ProcessSupervisor,
  type ProcessLogCursor,
  type ProcessScope,
} from "./process-supervisor.js";

export {
  ProcessSupervisor,
  type ManagedProcessInfo,
  type ManagedProcessState,
  type ProcessLogCursor,
  type ProcessLogsResult,
  type ProcessScope,
  type ProcessStopResult,
  type ProcessSupervisorOptions,
} from "./process-supervisor.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ToolRegistryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  webSearch?: {
    exaApiKey?: string;
    exaBaseUrl?: string;
  };
  processSupervisor?: ProcessSupervisor;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(
    private readonly configuredOptionalFamilies = new Set<string>(),
    readonly processSupervisor = new ProcessSupervisor(),
  ) {}

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  isOptionalFamilyConfigured(family: "web" | "skill" | "mcp"): boolean {
    return this.configuredOptionalFamilies.has(family);
  }

  toModelSpecs(): ToolModelSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toToolInputSchema(tool.inputSchema),
    }));
  }
}

function toToolInputSchema(inputSchema: z.ZodTypeAny): Record<string, unknown> {
  const schema = zodToJsonSchema(inputSchema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete schema.$schema;
  delete schema.definitions;

  if (schema.type !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
  }

  return schema;
}

export function createDefaultToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const configuredFamilies = new Set<string>(["web", "skill"]);
  if (Object.keys(options.mcpServers ?? {}).length) configuredFamilies.add("mcp");
  const processSupervisor = options.processSupervisor ?? new ProcessSupervisor();
  const registry = new ToolRegistry(configuredFamilies, processSupervisor);
  for (const tool of createBuiltinTools({ ...options, processSupervisor })) {
    registry.register(tool);
  }
  return registry;
}

export function createBuiltinTools(options: ToolRegistryOptions = {}): Tool[] {
  const processSupervisor = options.processSupervisor ?? new ProcessSupervisor();
  return [
    runtimeInfoTool,
    fileReadTool,
    artifactReadTool,
    fileWriteTool,
    filePatchTool,
    fileListTool,
    searchGrepTool,
    searchGlobTool,
    processRunTool,
    ...createManagedProcessTools(processSupervisor),
    shellRunTool,
    gitStatusTool,
    gitDiffTool,
    todoWriteTool,
    questionAskTool,
    createWebSearchTool(options.webSearch),
    webFetchTool,
    skillLoadTool,
    skillReadResourceTool,
    createMcpListTool(options.mcpServers ?? {}),
    createMcpCallTool(options.mcpServers ?? {}),
];
}

const MAX_COMMAND_TIMEOUT_MS = 120_000;
const STREAM_PREVIEW_BYTES = 4 * 1024;

const runtimeInfoTool: Tool<Record<string, never>, RuntimeInfo> = {
  name: "runtime.info",
  description:
    "Return the current OS, command dialect, path style, stateless execution semantics, and safety constraints. Call before platform-specific shell work.",
  inputSchema: z.object({}),
  risk: { tags: [] },
  async execute(_rawInput, context) {
    const info = buildRuntimeInfo(context.workspaceRoot, context.mode);
    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Runtime is ${info.platform.os}/${info.platform.arch}; default shell is ${info.command.defaultShell}.`,
      data: info,
    };
  },
};

function buildRuntimeInfo(workspaceRoot: string, mode: ToolExecutionContext["mode"]): RuntimeInfo {
  const windows = process.platform === "win32";
  return {
    platform: {
      os: process.platform,
      arch: process.arch,
      pathSeparator: path.sep,
      lineEnding: windows ? "crlf" : "lf",
    },
    command: {
      defaultShell: windows ? "cmd" : "sh",
      supportedShells: windows ? ["cmd", "powershell"] : ["sh", "bash"],
      environmentVariableStyle: windows ? "percent" : "posix",
      pathStyle: windows ? "windows" : "posix",
    },
    execution: {
      stateless: true,
      workspaceRoot: path.resolve(workspaceRoot),
      defaultCwd: path.resolve(workspaceRoot),
      maxTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
      managedProcesses: {
        supported: true,
        scope: "session",
        survivesHostRestart: false,
        maxLogReadBytes: 64 * 1024,
      },
    },
    constraints: {
      currentMode: mode,
      externalCwdPolicy: "mode_dependent",
      processRunUsesShell: false,
      shellRunAllowsPipeline: true,
      shellRunAllowsMultipleSteps: false,
      externalCwdUsesPermissionEngine: true,
    },
    permission: buildPermissionCapabilityContract(mode, process.platform),
  };
}

const fileReadSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(200000).default(40000),
});

const fileReadTool: Tool<z.infer<typeof fileReadSchema>> = {
  name: "file.read",
  description: "Read a UTF-8 text file inside the workspace. Secret-like files are refused.",
  inputSchema: fileReadSchema,
  risk: { tags: ["read_workspace"], readsFiles: true },
  async execute(rawInput, context) {
    const input = fileReadSchema.parse(rawInput);
    if (isSecretPath(input.path)) {
      return denied(context.toolCallId, "Refused to read a secret-like file.");
    }

    const resolved = await safeExistingInside(context.workspaceRoot, input.path);
    if (!resolved.ok) {
      return errorResult(context.toolCallId, resolved.summary, resolved.code);
    }

    const content = await readFile(resolved.absolutePath);
    if (content.includes(0)) {
      return errorResult(context.toolCallId, "Refused to read a binary file.", "binary_file");
    }

    const text = content.toString("utf8");
    const truncated = Buffer.byteLength(text, "utf8") > input.maxBytes;
    const visible = truncated ? text.slice(0, input.maxBytes) : text;

    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: truncated
        ? `Read ${resolved.relativePath} (${content.length} bytes, truncated).`
        : `Read ${resolved.relativePath} (${content.length} bytes).`,
      data: {
        path: resolved.relativePath,
        content: visible,
        bytes: content.length,
        truncated,
      },
    };
  },
};

const artifactReadSchema = z.object({
  ref: z.string().startsWith("artifact://"),
  offset: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().positive().max(200000).default(40000),
});

const artifactReadTool: Tool<z.infer<typeof artifactReadSchema>> = {
  name: "artifact.read",
  description: "Read a byte range from a large tool output previously saved as artifact://... .",
  inputSchema: artifactReadSchema,
  risk: { tags: ["read_workspace"], readsFiles: true },
  async execute(rawInput, context) {
    const input = artifactReadSchema.parse(rawInput);
    const name = decodeURIComponent(input.ref.slice("artifact://".length));
    if (!name || name !== path.basename(name)) {
      return denied(context.toolCallId, "Refused to read an invalid artifact reference.");
    }
    const artifactsRoot = path.resolve(context.sessionDir, "artifacts");
    const artifactPath = path.resolve(artifactsRoot, name);
    if (path.dirname(artifactPath) !== artifactsRoot || !existsSync(artifactPath)) {
      return errorResult(
        context.toolCallId,
        `Artifact not found: ${input.ref}`,
        "artifact_not_found",
      );
    }
    const content = await readFile(artifactPath);
    const visible = content.subarray(input.offset, input.offset + input.maxBytes);
    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Read ${visible.length} byte(s) from ${input.ref} at offset ${input.offset}.`,
      data: {
        ref: input.ref,
        offset: input.offset,
        content: visible.toString("utf8"),
        bytes: content.length,
        truncated: input.offset + visible.length < content.length,
        nextOffset: input.offset + visible.length,
      },
    };
  },
};

const fileWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const fileWriteTool: Tool<z.infer<typeof fileWriteSchema>> = {
  name: "file.write",
  description: "Create or overwrite a UTF-8 text file inside the workspace.",
  inputSchema: fileWriteSchema,
  risk: { tags: ["write_workspace"], writesFiles: true },
  async execute(rawInput, context) {
    const input = fileWriteSchema.parse(rawInput);
    const resolved = resolveWorkspacePath(context.workspaceRoot, input.path);
    if (!resolved.isInside) {
      return denied(context.toolCallId, "Refused to write outside the workspace.");
    }

    const before = existsSync(resolved.absolutePath)
      ? await readFile(resolved.absolutePath, "utf8")
      : undefined;
    await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    await writeFile(resolved.absolutePath, input.content, "utf8");

    const changedFile = await makeChangedFile({
      relativePath: resolved.relativePath,
      before,
      after: input.content,
      sessionDir: context.sessionDir,
    });

    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `${before === undefined ? "Created" : "Updated"} ${resolved.relativePath}.`,
      data: { path: resolved.relativePath },
      changedFiles: [changedFile],
    };
  },
};

const singlePatchEditSchema = z.object({
  search: z.string().min(1),
  replace: z.string(),
});

const filePatchSchema = z
  .object({
    path: z.string().min(1),
    search: z.string().min(1).optional(),
    replace: z.string().optional(),
    edits: z.array(singlePatchEditSchema).min(1).optional(),
  })
  .refine((input) => input.edits || (input.search !== undefined && input.replace !== undefined), {
    message: "Provide either edits[] or search + replace.",
  });

type FilePatchInput = z.infer<typeof filePatchSchema>;

const filePatchTool: Tool<FilePatchInput> = {
  name: "file.patch",
  description:
    "Patch a file inside the workspace by replacing exact text. Provide search+replace or edits[].",
  inputSchema: filePatchSchema,
  risk: { tags: ["write_workspace"], writesFiles: true },
  async execute(rawInput, context) {
    const input = filePatchSchema.parse(rawInput);
    const resolved = await safeExistingInside(context.workspaceRoot, input.path);
    if (!resolved.ok) {
      return errorResult(context.toolCallId, resolved.summary, resolved.code);
    }

    const before = await readFile(resolved.absolutePath, "utf8");
    let after = before;
    const edits = input.edits ?? [{ search: input.search ?? "", replace: input.replace ?? "" }];

    for (const edit of edits) {
      if (!after.includes(edit.search)) {
        return errorResult(
          context.toolCallId,
          `Patch search text was not found in ${resolved.relativePath}.`,
          "patch_search_not_found",
        );
      }
      after = after.replace(edit.search, edit.replace);
    }

    await writeFile(resolved.absolutePath, after, "utf8");
    const changedFile = await makeChangedFile({
      relativePath: resolved.relativePath,
      before,
      after,
      sessionDir: context.sessionDir,
    });

    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Patched ${resolved.relativePath} with ${edits.length} replacement(s).`,
      data: { path: resolved.relativePath, replacements: edits.length },
      changedFiles: [changedFile],
    };
  },
};

const fileListSchema = z.object({
  path: z.string().default("."),
  recursive: z.boolean().default(false),
  maxEntries: z.number().int().positive().max(2000).default(200),
});

const fileListTool: Tool<z.infer<typeof fileListSchema>> = {
  name: "file.list",
  description: "List files and directories inside the workspace.",
  inputSchema: fileListSchema,
  risk: { tags: ["read_workspace"], readsFiles: true },
  async execute(rawInput, context) {
    const input = fileListSchema.parse(rawInput);
    const resolved = resolveWorkspacePath(context.workspaceRoot, input.path);
    if (!resolved.isInside) {
      return denied(context.toolCallId, "Refused to list outside the workspace.");
    }

    const entries = input.recursive
      ? await listRecursive(resolved.absolutePath, context.workspaceRoot, input.maxEntries)
      : await listShallow(resolved.absolutePath, context.workspaceRoot, input.maxEntries);

    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Listed ${entries.length} entr${entries.length === 1 ? "y" : "ies"} under ${resolved.relativePath}.`,
      data: {
        path: resolved.relativePath,
        entries,
        truncated: entries.length >= input.maxEntries,
      },
    };
  },
};

const searchGrepSchema = z.object({
  pattern: z.string().min(1),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().max(1000).default(100),
});

const searchGrepTool: Tool<z.infer<typeof searchGrepSchema>> = {
  name: "search.grep",
  description: "Search workspace text with ripgrep when available, falling back to JavaScript.",
  inputSchema: searchGrepSchema,
  risk: { tags: ["read_workspace"], readsFiles: true },
  async execute(rawInput, context) {
    const input = searchGrepSchema.parse(rawInput);
    const rgResult = await runRipgrep(input, context.workspaceRoot, context.signal);
    const matches =
      rgResult ?? (await runJavaScriptGrep(input, context.workspaceRoot, context.signal));

    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Found ${matches.length} grep match${matches.length === 1 ? "" : "es"} for '${input.pattern}'.`,
      data: {
        matches,
        truncated: matches.length >= input.maxResults,
      },
    };
  },
};

const searchGlobSchema = z.object({
  pattern: z.string().min(1),
  maxResults: z.number().int().positive().max(5000).default(500),
});

const searchGlobTool: Tool<z.infer<typeof searchGlobSchema>> = {
  name: "search.glob",
  description: "Find workspace files by glob pattern, respecting common ignore files.",
  inputSchema: searchGlobSchema,
  risk: { tags: ["read_workspace"], readsFiles: true },
  async execute(rawInput, context) {
    const input = searchGlobSchema.parse(rawInput);
    const entries = await fg(input.pattern, {
      cwd: context.workspaceRoot,
      dot: false,
      onlyFiles: false,
      unique: true,
      ignore: await readIgnorePatterns(context.workspaceRoot),
    });

    const limited = entries.slice(0, input.maxResults);
    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Found ${limited.length} path${limited.length === 1 ? "" : "s"} for '${input.pattern}'.`,
      data: {
        paths: limited,
        truncated: entries.length > limited.length,
      },
    };
  },
};

const commandEnvironmentSchema = z.record(z.string());

const processRunSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: commandEnvironmentSchema.optional(),
  timeoutMs: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).default(30000),
});

const processRunTool: Tool<z.infer<typeof processRunSchema>> = {
  name: "process.run",
  description:
    "Run one program without a shell. Pass arguments, cwd, and per-call environment explicitly; calls are stateless. Prefer this over shell.run.",
  inputSchema: processRunSchema,
  risk: { tags: ["shell_mutating"], runsCommands: true },
  preflight(rawInput, context) {
    const parsed = processRunSchema.safeParse(rawInput);
    return parsed.success
      ? undefined
      : commandInputValidationResult(context.toolCallId, parsed.error.issues);
  },
  async execute(rawInput, context) {
    const input = processRunSchema.parse(rawInput);
    const cwd = resolveCommandCwd(context.workspaceRoot, input.cwd);
    const cwdError = await commandCwdError(context.toolCallId, cwd);
    if (cwdError) return cwdError;
    const started = Date.now();
    const result = await runProcess(input.program, input.args, {
      cwd,
      env: mergeCommandEnvironment(input.env),
      timeoutMs: input.timeoutMs,
      signal: context.signal,
    });
    return makeCommandToolResult({
      context,
      command: [input.program, ...input.args].join(" "),
      result,
      started,
      prefix: `process-${context.toolCallId}`,
      data: {
        command: [input.program, ...input.args].join(" "),
        program: input.program,
        args: input.args,
        cwd,
      },
    });
  },
};

const processStartSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: commandEnvironmentSchema.optional(),
  label: z.string().min(1).max(120).optional(),
});

const managedProcessIdSchema = z.string().regex(/^proc_[a-f0-9]{32}$/);

const processStatusSchema = z.object({ processId: managedProcessIdSchema });

const processLogsSchema = z.object({
  processId: managedProcessIdSchema,
  cursor: z
    .object({
      stdoutOffset: z.number().int().nonnegative(),
      stderrOffset: z.number().int().nonnegative(),
    })
    .default({ stdoutOffset: 0, stderrOffset: 0 }),
  maxBytes: z.number().int().min(1024).max(64 * 1024).default(16 * 1024),
});

const processStopSchema = z.object({
  processId: managedProcessIdSchema,
  graceMs: z.number().int().nonnegative().max(10_000).default(3000),
  force: z.boolean().default(false),
});

function createManagedProcessTools(supervisor: ProcessSupervisor): Tool[] {
  const startTool: Tool<z.infer<typeof processStartSchema>> = {
    name: "process.start",
    description:
      "Start one long-running program without a shell and return a managed processId after spawn. The process remains available across tool calls; use process.logs/status/stop to manage it.",
    inputSchema: processStartSchema,
    risk: { tags: ["shell_mutating", "long_running"], runsCommands: true },
    preflight(rawInput, context) {
      const parsed = processStartSchema.safeParse(rawInput);
      return parsed.success
        ? undefined
        : commandInputValidationResult(context.toolCallId, parsed.error.issues);
    },
    async execute(rawInput, context) {
      const input = processStartSchema.parse(rawInput);
      const cwd = resolveCommandCwd(context.workspaceRoot, input.cwd);
      const cwdError = await commandCwdError(context.toolCallId, cwd);
      if (cwdError) return cwdError;
      const command = [input.program, ...input.args].join(" ");
      try {
        const info = await supervisor.start(managedProcessScope(context), {
          program: input.program,
          args: input.args,
          cwd,
          env: mergeCommandEnvironment(input.env),
          label: input.label,
          signal: context.signal,
        });
        return {
          toolCallId: context.toolCallId,
          status: "success",
          summary: `Started managed process '${command}' as ${info.processId}.`,
          data: { ...info, command },
          execution: { outcome: "background_started", started: true },
        };
      } catch (error) {
        return managedProcessErrorResult(context.toolCallId, error, command);
      }
    },
  };

  const statusTool: Tool<z.infer<typeof processStatusSchema>> = {
    name: "process.status",
    description: "Return the current lifecycle state of a managed process in this session.",
    inputSchema: processStatusSchema,
    risk: { tags: [] },
    async execute(rawInput, context) {
      const input = processStatusSchema.parse(rawInput);
      try {
        const info = await supervisor.status(managedProcessScope(context), input.processId);
        return {
          toolCallId: context.toolCallId,
          status: "success",
          summary: `Managed process ${input.processId} is ${info.state}.`,
          data: info,
        };
      } catch (error) {
        return managedProcessErrorResult(context.toolCallId, error);
      }
    },
  };

  const logsTool: Tool<z.infer<typeof processLogsSchema>> = {
    name: "process.logs",
    description:
      "Read bounded incremental stdout and stderr from a managed process. Pass nextCursor back as cursor to avoid repeating output.",
    inputSchema: processLogsSchema,
    risk: { tags: [] },
    async execute(rawInput, context) {
      const input = processLogsSchema.parse(rawInput);
      try {
        const logs = await supervisor.logs(
          managedProcessScope(context),
          input.processId,
          input.cursor satisfies ProcessLogCursor,
          input.maxBytes,
        );
        const bytes =
          Buffer.byteLength(logs.stdout.text, "utf8") + Buffer.byteLength(logs.stderr.text, "utf8");
        return {
          toolCallId: context.toolCallId,
          status: "success",
          summary: `Read ${bytes} byte(s) of logs from ${input.processId}.`,
          data: logs,
          warnings:
            logs.logsTruncated.stdout || logs.logsTruncated.stderr
              ? ["Process log retention limit was reached; later output may not have been persisted."]
              : undefined,
          usage: { stdoutBytes: Buffer.byteLength(logs.stdout.text), stderrBytes: Buffer.byteLength(logs.stderr.text) },
        };
      } catch (error) {
        return managedProcessErrorResult(context.toolCallId, error);
      }
    },
  };

  const stopTool: Tool<z.infer<typeof processStopSchema>> = {
    name: "process.stop",
    description:
      "Stop a managed process tree in this session. Stop is idempotent and escalates to force after the grace period.",
    inputSchema: processStopSchema,
    risk: { tags: ["long_running"], runsCommands: true },
    async execute(rawInput, context) {
      const input = processStopSchema.parse(rawInput);
      try {
        const stopped = await supervisor.stop(managedProcessScope(context), input.processId, input);
        return {
          toolCallId: context.toolCallId,
          status: "success",
          summary: stopped.terminationUncertain
            ? `Stop was requested for ${input.processId}, but termination could not be confirmed.`
            : `Managed process ${input.processId} is ${stopped.state}.`,
          data: stopped,
          warnings: stopped.terminationUncertain
            ? ["The complete process tree may not have terminated."]
            : undefined,
        };
      } catch (error) {
        return managedProcessErrorResult(context.toolCallId, error);
      }
    },
  };

  return [startTool, statusTool, logsTool, stopTool];
}

function managedProcessScope(context: ToolExecutionContext): ProcessScope {
  return {
    sessionId: context.sessionId ?? path.resolve(context.sessionDir),
    sessionDir: context.sessionDir,
    workspaceRoot: context.workspaceRoot,
  };
}

function managedProcessErrorResult(toolCallId: string, error: unknown, command?: string): ToolResult {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "process_management_failed";
  const category: NonNullable<ToolResult["error"]>["category"] =
    code === "program_not_found" || code === "process_not_found"
      ? "environment"
      : code === "start_aborted"
        ? "cancelled"
        : "execution";
  return {
    toolCallId,
    status: code === "start_aborted" ? "cancelled" : "error",
    summary: command
      ? `Could not start managed process '${command}': ${toErrorMessage(error)}`
      : toErrorMessage(error),
    error: {
      code,
      category,
      reason: code,
      message: toErrorMessage(error),
      retryable: code === "process_limit_exceeded",
    },
    execution: command
      ? {
          outcome:
            code === "program_not_found"
              ? "program_not_found"
              : code === "start_aborted"
                ? "aborted"
                : "spawn_failed",
          started: false,
        }
      : undefined,
  };
}

const shellRunSchema = z.object({
  command: z.string().min(1),
  shell: z.enum(["powershell", "cmd", "bash", "sh"]).optional(),
  cwd: z.string().min(1).optional(),
  env: commandEnvironmentSchema.optional(),
  timeoutMs: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).default(30000),
});

const shellRunTool: Tool<z.infer<typeof shellRunSchema>> = {
  name: "shell.run",
  description:
    "Run one shell expression or pipeline when shell features are required. Multi-step chains and persistent cd/variable state are rejected; use cwd/env fields.",
  inputSchema: shellRunSchema,
  risk: { tags: ["shell_mutating"], runsCommands: true },
  preflight(rawInput, context) {
    const parsed = shellRunSchema.safeParse(rawInput);
    if (!parsed.success) {
      return commandInputValidationResult(context.toolCallId, parsed.error.issues);
    }
    const shell =
      parsed.data.shell ?? buildRuntimeInfo(context.workspaceRoot, context.mode).command.defaultShell;
    const violations = validateShellCommand(parsed.data.command, shell);
    return violations.length ? commandValidationResult(context.toolCallId, violations) : undefined;
  },
  async execute(rawInput, context) {
    const input = shellRunSchema.parse(rawInput);
    const shell = input.shell ?? buildRuntimeInfo(context.workspaceRoot, context.mode).command.defaultShell;
    const violations = validateShellCommand(input.command, shell);
    if (violations.length) {
      return commandValidationResult(context.toolCallId, violations);
    }
    const shellProgram = shellExecutable(shell);
    if (!shellProgram) {
      return commandErrorResult({
        toolCallId: context.toolCallId,
        status: "error",
        outcome: "unsupported_shell",
        category: "environment",
        reason: "unsupported_shell",
        message: `Shell '${shell}' is not supported on ${process.platform}.`,
        retryable: false,
      });
    }
    const started = Date.now();
    const cwd = resolveCommandCwd(context.workspaceRoot, input.cwd);
    const cwdError = await commandCwdError(context.toolCallId, cwd);
    if (cwdError) return cwdError;
    const result = await runShellExpression(input.command, shellProgram, {
      cwd,
      env: mergeCommandEnvironment(input.env),
      timeoutMs: input.timeoutMs,
      signal: context.signal,
    });
    return makeCommandToolResult({
      context,
      command: input.command,
      result,
      started,
      prefix: `shell-${context.toolCallId}`,
      data: { command: input.command, shell, cwd },
    });
  },
};

const gitStatusTool: Tool = {
  name: "git.status",
  description: "Show read-only git status summary for the workspace.",
  inputSchema: z.object({}),
  risk: { tags: ["shell_readonly"], runsCommands: true },
  async execute(_rawInput, context) {
    const result = await runProcess("git", ["status", "--short", "--branch"], {
      cwd: context.workspaceRoot,
      timeoutMs: 15000,
      signal: context.signal,
    });

    return {
      toolCallId: context.toolCallId,
      status: result.exitCode === 0 ? "success" : "error",
      summary: result.exitCode === 0 ? "Read git status." : "git status failed.",
      data: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  },
};

const gitDiffTool: Tool = {
  name: "git.diff",
  description: "Show read-only git diff summary and save full diff when large.",
  inputSchema: z.object({}),
  risk: { tags: ["shell_readonly"], runsCommands: true },
  async execute(_rawInput, context) {
    const statResult = await runProcess("git", ["diff", "--stat"], {
      cwd: context.workspaceRoot,
      timeoutMs: 15000,
      signal: context.signal,
    });
    const fullResult = await runProcess("git", ["diff"], {
      cwd: context.workspaceRoot,
      timeoutMs: 15000,
      signal: context.signal,
    });
    const refs = await persistLargeOutputs(context, {
      prefix: safeArtifactName(`git-diff-${context.toolCallId}`),
      stdout: fullResult.stdout,
      stderr: fullResult.stderr,
    });

    return {
      toolCallId: context.toolCallId,
      status: statResult.exitCode === 0 ? "success" : "error",
      summary: statResult.exitCode === 0 ? "Read git diff." : "git diff failed.",
      data: {
        exitCode: statResult.exitCode,
        stat: statResult.stdout,
        diff: truncate(fullResult.stdout, 16000),
        stderr: statResult.stderr || fullResult.stderr,
      },
      stdoutRef: refs.stdoutRef,
    };
  },
};

const todoWriteSchema = z.object({
  items: z.array(todoItemSchema).min(1),
});

const todoWriteTool: Tool<z.infer<typeof todoWriteSchema>> = {
  name: "todo.write",
  description: "Update the current task todo list.",
  inputSchema: todoWriteSchema,
  risk: { tags: [] },
  async execute(rawInput, context) {
    const input = todoWriteSchema.parse(rawInput);
    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Updated todo list with ${input.items.length} item(s).`,
      data: {
        items: input.items satisfies TodoItem[],
      },
    };
  },
};

const questionAskSchema = z.object({
  question: z.string().min(1),
});

const questionAskTool: Tool<z.infer<typeof questionAskSchema>> = {
  name: "question.ask",
  description: "Ask the user a necessary clarification or approval question.",
  inputSchema: questionAskSchema,
  risk: { tags: [] },
  async execute(rawInput, context) {
    const input = questionAskSchema.parse(rawInput);
    const answer = context.questionHandler
      ? await context.questionHandler(input.question)
      : "No question handler was available.";

    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: "Asked the user a question.",
      data: {
        question: input.question,
        answer,
      },
    };
  },
};

const webSearchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(10).default(5),
  domains: z.array(z.string().min(1)).optional(),
});

function createWebSearchTool(
  options: ToolRegistryOptions["webSearch"] = {},
): Tool<z.infer<typeof webSearchSchema>> {
  return {
    name: "web.search",
    description: "Search public web pages and return source candidates with URLs.",
    inputSchema: webSearchSchema,
    risk: { tags: ["network_access", "web_fetch"] },
    async execute(rawInput, context) {
      const input = webSearchSchema.parse(rawInput);
      const started = Date.now();
      if (/^https?:\/\//i.test(input.query)) {
        return {
          toolCallId: context.toolCallId,
          status: "success",
          summary: `Found 1 web result for '${input.query}'.`,
          data: {
            query: input.query,
            results: [
              {
                title: input.query,
                url: input.query,
                snippet: "Direct URL query.",
                source: "direct",
              },
            ],
            truncated: false,
          },
          usage: { durationMs: Date.now() - started },
        };
      }
      const apiKey = options.exaApiKey?.trim() || process.env.EXA_API_KEY?.trim();
      if (!apiKey && !process.env.DREAMCODE_WEB_SEARCH_FIXTURE) {
        return errorResult(
          context.toolCallId,
          "Exa API key is not configured. Add it in Settings > General > Web Search, or set EXA_API_KEY.",
          "exa_api_key_missing",
        );
      }
      let results: Awaited<ReturnType<typeof searchWeb>>;
      try {
        results = await searchWeb(input, apiKey ?? "", options.exaBaseUrl, context.signal);
      } catch (error) {
        return errorResult(
          context.toolCallId,
          `Exa web search failed: ${toErrorMessage(error)}`,
          "exa_search_failed",
        );
      }
      const limited = results.slice(0, input.maxResults);
      return {
        toolCallId: context.toolCallId,
        status: "success",
        summary: `Found ${limited.length} web result${limited.length === 1 ? "" : "s"} for '${input.query}'.`,
        data: {
          query: input.query,
          results: limited,
          truncated: results.length > limited.length,
        },
        usage: { durationMs: Date.now() - started },
      };
    },
  };
}

const webFetchSchema = z.object({
  url: z.string().url(),
  maxBytes: z.number().int().positive().max(500000).default(120000),
  extractMode: z.enum(["readability", "text", "raw"]).default("text"),
});

const webFetchTool: Tool<z.infer<typeof webFetchSchema>> = {
  name: "web.fetch",
  description: "Fetch a public URL, extract readable text, and save a source artifact.",
  inputSchema: webFetchSchema,
  risk: { tags: ["network_access", "web_fetch"] },
  async execute(rawInput, context) {
    const input = webFetchSchema.parse(rawInput);
    const started = Date.now();
    const response = await fetch(input.url, { signal: context.signal });
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    const limitedRaw = raw.slice(0, input.maxBytes);
    const extracted =
      input.extractMode === "raw" ? limitedRaw : extractReadableText(limitedRaw, contentType);
    const title = extractTitle(limitedRaw) ?? input.url;
    const artifactsDir = path.join(context.sessionDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const artifactRef = path.join(
      artifactsDir,
      `${safeArtifactName(`web-${new URL(input.url).hostname}-${context.toolCallId}`)}.txt`,
    );
    await writeFile(
      artifactRef,
      [
        `Title: ${title}`,
        `URL: ${input.url}`,
        `Fetched-At: ${new Date().toISOString()}`,
        `Status: ${response.status}`,
        "",
        extracted,
      ].join("\n"),
      "utf8",
    );

    return {
      toolCallId: context.toolCallId,
      status: response.ok ? "success" : "error",
      summary: `Fetched ${input.url} (${response.status}).`,
      data: {
        title,
        url: input.url,
        status: response.status,
        contentType,
        fetchedAt: new Date().toISOString(),
        summary: truncate(extracted, 12000),
        artifactRef,
      },
      artifactRefs: [artifactRef],
      usage: { durationMs: Date.now() - started, stdoutBytes: Buffer.byteLength(raw) },
    };
  },
};

const skillLoadSchema = z.object({
  skillId: z.string().min(1),
});

const skillLoadTool: Tool<z.infer<typeof skillLoadSchema>> = {
  name: "skill.load",
  description:
    "Load the complete instructions for one available Skill by the stable skillId from <available_skills>.",
  inputSchema: skillLoadSchema,
  risk: { tags: ["read_workspace"] },
  async execute(rawInput, context) {
    const input = skillLoadSchema.parse(rawInput);
    if (!context.skills) {
      return errorResult(context.toolCallId, "Skill Registry is unavailable.", "skill_registry_unavailable");
    }
    try {
      const loaded = await context.skills.load(input.skillId);
      return {
        toolCallId: context.toolCallId,
        status: "success",
        summary: `Loaded Skill ${loaded.name}.`,
        data: loaded,
      };
    } catch (error) {
      return errorResult(
        context.toolCallId,
        error instanceof Error ? error.message : "Skill could not be loaded.",
        "skill_load_failed",
      );
    }
  },
};

const skillReadResourceSchema = z.object({
  skillId: z.string().min(1),
  resourcePath: z.string().min(1),
  maxBytes: z.number().int().positive().max(200000).default(40000),
});

const skillReadResourceTool: Tool<z.infer<typeof skillReadResourceSchema>> = {
  name: "skill.read_resource",
  description: "Read a resource file inside a named skill directory.",
  inputSchema: skillReadResourceSchema,
  risk: { tags: ["read_workspace"] },
  async execute(rawInput, context) {
    const input = skillReadResourceSchema.parse(rawInput);
    if (!context.skills) {
      return errorResult(context.toolCallId, "Skill Registry is unavailable.", "skill_registry_unavailable");
    }
    try {
      const resource = await context.skills.readResource(
        input.skillId,
        input.resourcePath,
        input.maxBytes,
      );
      return {
        toolCallId: context.toolCallId,
        status: "success",
        summary: `Read Skill resource ${resource.resourcePath}.`,
        data: resource,
      };
    } catch (error) {
      return errorResult(
        context.toolCallId,
        error instanceof Error ? error.message : "Skill resource could not be read.",
        "skill_resource_failed",
      );
    }
  },
};

function createMcpListTool(servers: Record<string, McpServerConfig>): Tool {
  return {
    name: "mcp.list",
    description: "List configured MCP stdio servers and their tools.",
    inputSchema: z.object({ server: z.string().optional() }),
    risk: { tags: ["mcp_tool", "external_side_effect"] },
    async execute(rawInput, context) {
      const input = z.object({ server: z.string().optional() }).parse(rawInput);
      const selected = selectMcpServers(servers, input.server);
      const output: Array<{ server: string; tools: unknown[] }> = [];
      for (const [name, server] of selected) {
        const tools = await listMcpTools(name, server, context.signal);
        output.push({ server: name, tools });
      }
      return {
        toolCallId: context.toolCallId,
        status: "success",
        summary: `Listed MCP tools for ${output.length} server${output.length === 1 ? "" : "s"}.`,
        data: { servers: output },
      };
    },
  };
}

function createMcpCallTool(servers: Record<string, McpServerConfig>): Tool {
  const schema = z.object({
    server: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
  });
  return {
    name: "mcp.call",
    description: "Call a tool on a configured MCP stdio server.",
    inputSchema: schema,
    risk: { tags: ["mcp_tool", "external_side_effect"] },
    async execute(rawInput, context) {
      const input = schema.parse(rawInput);
      const server = servers[input.server];
      if (!server) {
        return errorResult(
          context.toolCallId,
          `MCP server not configured: ${input.server}`,
          "mcp_server_not_found",
        );
      }
      const result = await callMcpTool(
        input.server,
        server,
        input.tool,
        input.arguments,
        context.signal,
      );
      return {
        toolCallId: context.toolCallId,
        status: "success",
        summary: `Called MCP tool ${input.server}.${input.tool}.`,
        data: result,
      };
    },
  };
}

async function safeExistingInside(
  workspaceRoot: string,
  inputPath: string,
): Promise<
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; summary: string; code: string }
> {
  try {
    const resolved = await resolveExistingWorkspacePath(workspaceRoot, inputPath);
    if (!resolved.isInside) {
      return {
        ok: false,
        summary: "Refused to access a path outside the workspace.",
        code: "outside_workspace",
      };
    }
    return {
      ok: true,
      absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Could not access '${inputPath}': ${toErrorMessage(error)}`,
      code: "path_access_failed",
    };
  }
}

async function listShallow(
  absolutePath: string,
  workspaceRoot: string,
  maxEntries: number,
): Promise<Array<{ path: string; type: "file" | "dir" | "other" }>> {
  const dirents = await readdir(absolutePath, { withFileTypes: true });
  const entries: Array<{ path: string; type: "file" | "dir" | "other" }> = [];
  for (const dirent of dirents.slice(0, maxEntries)) {
    const absoluteEntry = path.join(absolutePath, dirent.name);
    entries.push({
      path: path.relative(workspaceRoot, absoluteEntry) || ".",
      type: dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other",
    });
  }
  return entries;
}

async function listRecursive(
  absolutePath: string,
  workspaceRoot: string,
  maxEntries: number,
): Promise<Array<{ path: string; type: "file" | "dir" | "other" }>> {
  const rootRelative = path.relative(workspaceRoot, absolutePath) || ".";
  const pattern = rootRelative === "." ? "**/*" : `${toPosixPath(rootRelative)}/**/*`;
  const entries = await fg(pattern, {
    cwd: workspaceRoot,
    dot: false,
    onlyFiles: false,
    unique: true,
    ignore: await readIgnorePatterns(workspaceRoot),
  });
  const limited = entries.slice(0, maxEntries);
  return Promise.all(
    limited.map(async (entry) => {
      const fileStat = await stat(path.join(workspaceRoot, entry));
      return {
        path: entry,
        type: fileStat.isDirectory()
          ? ("dir" as const)
          : fileStat.isFile()
            ? ("file" as const)
            : "other",
      };
    }),
  );
}

async function readIgnorePatterns(workspaceRoot: string): Promise<string[]> {
  const patterns = ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/coverage/**"];
  for (const file of [".gitignore", ".dreamcodeignore"]) {
    const filePath = path.join(workspaceRoot, file);
    if (!existsSync(filePath)) {
      continue;
    }
    const content = await readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("!")) {
        patterns.push(toPosixPath(trimmed));
      }
    }
  }
  return patterns;
}

async function searchWeb(
  input: z.infer<typeof webSearchSchema>,
  apiKey: string,
  baseUrl = "https://api.exa.ai",
  signal?: AbortSignal,
): Promise<Array<{ title: string; url: string; snippet: string; source: string }>> {
  const fixturePath = process.env.DREAMCODE_WEB_SEARCH_FIXTURE;
  if (fixturePath) {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      results?: Array<{ title: string; url: string; snippet?: string }>;
    };
    return (fixture.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet ?? "",
      source: "fixture",
    }));
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/search`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query: input.query,
      numResults: input.maxResults,
      type: "fast",
      ...(input.domains?.length ? { includeDomains: input.domains } : {}),
      contents: { highlights: { maxCharacters: 1000 } },
    }),
  });
  const payload = (await response.json()) as {
    error?: string;
    results?: Array<{
      title?: string;
      url?: string;
      text?: string;
      summary?: string;
      highlights?: string[];
    }>;
  };
  if (!response.ok) {
    throw new Error(
      `Exa search failed (${response.status}): ${payload.error ?? response.statusText}`,
    );
  }
  return (payload.results ?? [])
    .filter((result): result is typeof result & { url: string } => Boolean(result.url))
    .map((result) => ({
      title: result.title?.trim() || result.url,
      url: result.url,
      snippet:
        result.summary?.trim() || result.highlights?.join(" ").trim() || result.text?.trim() || "",
      source: "exa",
    }));
}

function extractReadableText(content: string, contentType: string): string {
  if (!contentType.includes("html") && !/<html|<body|<p[\s>]/i.test(content)) {
    return content;
  }
  return stripHtml(
    content
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n"),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? stripHtml(match[1] ?? "").trim() : undefined;
}

function stripHtml(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function selectMcpServers(
  servers: Record<string, McpServerConfig>,
  serverName: string | undefined,
): Array<[string, McpServerConfig]> {
  if (!serverName) {
    return Object.entries(servers);
  }
  const server = servers[serverName];
  if (!server) {
    throw new Error(`MCP server not configured: ${serverName}`);
  }
  return [[serverName, server]];
}

async function listMcpTools(
  serverName: string,
  server: McpServerConfig,
  signal?: AbortSignal,
): Promise<unknown[]> {
  return withMcpClient(serverName, server, signal, async (request, notify) => {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "DreamCode", version: "0.1.0" },
    });
    notify("notifications/initialized", {});
    const result = (await request("tools/list", {})) as { tools?: unknown[] };
    return result.tools ?? [];
  });
}

async function callMcpTool(
  serverName: string,
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return withMcpClient(serverName, server, signal, async (request, notify) => {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "DreamCode", version: "0.1.0" },
    });
    notify("notifications/initialized", {});
    return request("tools/call", { name: toolName, arguments: args });
  });
}

async function withMcpClient<T>(
  serverName: string,
  server: McpServerConfig,
  signal: AbortSignal | undefined,
  run: (
    request: (method: string, params: unknown) => Promise<unknown>,
    notify: (method: string, params: unknown) => void,
  ) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(server.command, server.args ?? [], {
      cwd: server.cwd,
      env: { ...process.env, ...(server.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let buffer = "";
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
    >();

    const cleanup = () => {
      for (const pendingRequest of pending.values()) {
        clearTimeout(pendingRequest.timeout);
      }
      pending.clear();
      child.kill();
    };

    const request = (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++;
      const payload = { jsonrpc: "2.0", id, method, params };
      return new Promise((requestResolve, requestReject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          requestReject(new Error(`MCP request timed out: ${serverName}.${method}`));
        }, 10000);
        pending.set(id, { resolve: requestResolve, reject: requestReject, timeout });
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      });
    };

    const notify = (method: string, params: unknown): void => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    };

    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: { message?: string };
          };
          if (typeof message.id !== "number") {
            continue;
          }
          const pendingRequest = pending.get(message.id);
          if (!pendingRequest) {
            continue;
          }
          pending.delete(message.id);
          clearTimeout(pendingRequest.timeout);
          if (message.error) {
            pendingRequest.reject(new Error(message.error.message ?? "MCP error"));
          } else {
            pendingRequest.resolve(message.result);
          }
        } catch {
          // Ignore non-JSON stdout lines from poorly behaved local servers.
        }
      }
    });

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (pending.size) {
        const error = new Error(`MCP server ${serverName} exited with code ${code ?? "unknown"}.`);
        for (const pendingRequest of pending.values()) {
          clearTimeout(pendingRequest.timeout);
          pendingRequest.reject(error);
        }
        pending.clear();
      }
    });

    run(request, notify)
      .then((value) => {
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

async function runRipgrep(
  input: z.infer<typeof searchGrepSchema>,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<Array<{ path: string; line: number; column: number; text: string }> | undefined> {
  const args = ["--line-number", "--column", "--color", "never"];
  if (existsSync(path.join(workspaceRoot, ".dreamcodeignore"))) {
    args.push("--ignore-file", ".dreamcodeignore");
  }
  if (input.glob) {
    args.push("--glob", input.glob);
  }
  args.push(input.pattern, ".");

  try {
    const result = await runProcess("rg", args, {
      cwd: workspaceRoot,
      timeoutMs: 15000,
      signal,
    });
    if (result.exitCode > 1) {
      return undefined;
    }
    return parseRipgrepOutput(result.stdout).slice(0, input.maxResults);
  } catch {
    return undefined;
  }
}

async function runJavaScriptGrep(
  input: z.infer<typeof searchGrepSchema>,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<Array<{ path: string; line: number; column: number; text: string }>> {
  const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
  const files = await fg(input.glob ?? "**/*", {
    cwd: workspaceRoot,
    dot: false,
    onlyFiles: true,
    unique: true,
    ignore: await readIgnorePatterns(workspaceRoot),
  });
  const regex = new RegExp(input.pattern);

  for (const file of files) {
    if (signal?.aborted || matches.length >= input.maxResults) {
      break;
    }
    const absolutePath = path.join(workspaceRoot, file);
    const buffer = await readFile(absolutePath);
    if (buffer.includes(0)) {
      continue;
    }
    const lines = buffer.toString("utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (matches.length >= input.maxResults) {
        return;
      }
      const match = regex.exec(line);
      if (match?.index !== undefined) {
        matches.push({ path: file, line: index + 1, column: match.index + 1, text: line });
      }
    });
  }

  return matches;
}

function parseRipgrepOutput(
  output: string,
): Array<{ path: string; line: number; column: number; text: string }> {
  const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
    if (match) {
      matches.push({
        path: match[1] ?? "",
        line: Number(match[2]),
        column: Number(match[3]),
        text: match[4] ?? "",
      });
    }
  }
  return matches;
}

export interface ShellCommandViolation {
  code: "multiple_shell_steps" | "stateful_shell_construct" | "unterminated_quote";
  message: string;
  position?: number;
}

export function validateShellCommand(
  command: string,
  shell: ShellKind,
): ShellCommandViolation[] {
  const violations: ShellCommandViolation[] = [];
  const pipelineSegments: string[] = [];
  let segmentStart = 0;
  let quote: "single" | "double" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    const escapeCharacter = shell === "powershell" ? "`" : shell === "cmd" ? "^" : "\\";
    if (character === escapeCharacter && quote !== "single") {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (quote) continue;

    const pair = command.slice(index, index + 2);
    if (character === ";" || character === "\n" || character === "\r" || pair === "&&" || pair === "||") {
      violations.push({
        code: "multiple_shell_steps",
        message: "shell.run accepts one expression or pipeline; run independent steps separately.",
        position: index,
      });
      if (pair === "&&" || pair === "||") index += 1;
      continue;
    }
    if (character === "|") {
      pipelineSegments.push(command.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }
  pipelineSegments.push(command.slice(segmentStart));

  if (quote) {
    violations.push({
      code: "unterminated_quote",
      message: "The shell expression contains an unterminated quote.",
      position: command.length - 1,
    });
  }

  for (const segment of pipelineSegments) {
    const trimmed = segment.trim();
    const stateful =
      /^(?:cd|chdir|set-location|pushd|popd)(?:\s|$)/i.test(trimmed) ||
      /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed) ||
      /^\$[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed) ||
      /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=/i.test(trimmed) ||
      /^set\s+[A-Za-z_][A-Za-z0-9_]*\s*=/i.test(trimmed) ||
      /^(?:export|set-variable)(?:\s|$)/i.test(trimmed);
    if (stateful) {
      violations.push({
        code: "stateful_shell_construct",
        message: "Use the cwd or env field instead of shell state that cannot persist across calls.",
        position: command.indexOf(segment),
      });
    }
  }

  return violations.filter(
    (violation, index, all) =>
      all.findIndex(
        (candidate) => candidate.code === violation.code && candidate.position === violation.position,
      ) === index,
  );
}

function shellExecutable(shell: ShellKind): string | undefined {
  if (shell === "cmd") {
    if (process.platform !== "win32") return undefined;
    return process.env.ComSpec || "cmd.exe";
  }
  if (shell === "powershell") {
    if (process.platform !== "win32") return undefined;
    return "powershell.exe";
  }
  if (shell === "bash") return "bash";
  if (shell === "sh") return "sh";
  return undefined;
}

function resolveCommandCwd(workspaceRoot: string, cwd: string | undefined): string {
  return path.resolve(workspaceRoot, cwd ?? ".");
}

async function commandCwdError(toolCallId: string, cwd: string): Promise<ToolResult | undefined> {
  try {
    const entry = await stat(cwd);
    if (entry.isDirectory()) return undefined;
  } catch {
    // Report the same deterministic result for a missing or inaccessible cwd.
  }
  return commandErrorResult({
    toolCallId,
    status: "error",
    outcome: "spawn_failed",
    category: "environment",
    reason: "cwd_not_found",
    message: `Command cwd is not an accessible directory: ${cwd}`,
    retryable: false,
  });
}

function mergeCommandEnvironment(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return overrides ? { ...process.env, ...overrides } : process.env;
}

function commandValidationResult(
  toolCallId: string,
  violations: ShellCommandViolation[],
): ToolResult {
  return commandErrorResult({
    toolCallId,
    status: "error",
    outcome: "validation_failed",
    category: "validation",
    reason: violations[0]?.code ?? "validation_failed",
    message: violations[0]?.message ?? "Shell command validation failed.",
    retryable: false,
    details: { violations },
  });
}

function commandInputValidationResult(toolCallId: string, issues: unknown): ToolResult {
  return commandErrorResult({
    toolCallId,
    status: "error",
    outcome: "validation_failed",
    category: "validation",
    reason: "invalid_input",
    message: "Command input does not match the tool schema.",
    retryable: false,
    details: { issues },
  });
}

function commandErrorResult(input: {
  toolCallId: string;
  status: ToolResult["status"];
  outcome: ExecutionOutcome;
  category: NonNullable<ToolResult["error"]>["category"];
  reason: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}): ToolResult {
  return {
    toolCallId: input.toolCallId,
    status: input.status,
    summary: input.message,
    execution: { outcome: input.outcome, started: false },
    error: {
      code: input.reason,
      category: input.category,
      reason: input.reason,
      message: input.message,
      retryable: input.retryable,
      details: input.details,
    },
  };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  started: boolean;
  aborted: boolean;
  signal?: string;
  spawnErrorCode?: string;
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    collectProcess(child, options.timeoutMs, options.signal, resolve);
  });
}

async function runShellExpression(
  command: string,
  shell: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    collectProcess(child, options.timeoutMs, options.signal, resolve);
  });
}

function collectProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  resolve: (result: ProcessResult) => void,
): void {
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let started = false;
  let aborted = Boolean(signal?.aborted);
  child.once("spawn", () => {
    started = true;
  });
  const onAbort = () => {
    aborted = true;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child);
  }, timeoutMs);

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      const processError = error as NodeJS.ErrnoException;
      resolve({
        stdout,
        stderr: stderr + toErrorMessage(error),
        exitCode: 127,
        timedOut,
        started,
        aborted: aborted || processError.code === "ABORT_ERR",
        spawnErrorCode: processError.code,
      });
    }
  });
  child.on("close", (code, closeSignal) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
        started,
        aborted,
        signal: closeSignal ?? undefined,
      });
    }
  });
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

async function makeCommandToolResult(input: {
  context: ToolExecutionContext;
  command: string;
  result: ProcessResult;
  started: number;
  prefix: string;
  data: Record<string, unknown>;
}): Promise<ToolResult> {
  const { result } = input;
  const outcome: ExecutionOutcome = result.timedOut
    ? "timed_out"
    : result.aborted
      ? "aborted"
      : result.spawnErrorCode === "ENOENT"
        ? "program_not_found"
        : result.spawnErrorCode
          ? "spawn_failed"
          : result.exitCode === 0
            ? "exited_zero"
            : "exited_nonzero";
  const status: ToolResult["status"] =
    outcome === "timed_out" || outcome === "aborted"
      ? "cancelled"
      : outcome === "exited_zero"
        ? "success"
        : "error";

  const warnings: string[] = [];
  const stdout = await makeOutputStream(input.context, input.prefix, "stdout", result.stdout, warnings);
  const stderr = await makeOutputStream(input.context, input.prefix, "stderr", result.stderr, warnings);
  const stdoutRef = artifactAbsolutePath(input.context, stdout.artifactRef);
  const stderrRef = artifactAbsolutePath(input.context, stderr.artifactRef);
  const error =
    status === "success"
      ? undefined
      : commandExecutionError(outcome, result.spawnErrorCode);
  const summary =
    outcome === "exited_zero"
      ? `Command '${input.command}' completed successfully.`
      : outcome === "timed_out"
        ? `Command '${input.command}' timed out after execution began.`
        : outcome === "aborted"
          ? `Command '${input.command}' was aborted.`
          : outcome === "program_not_found"
            ? `Command program was not found: '${input.command}'.`
            : outcome === "spawn_failed"
              ? `Command '${input.command}' could not be started.`
              : `Command '${input.command}' exited with ${result.exitCode}.`;

  return {
    toolCallId: input.context.toolCallId,
    status,
    summary,
    data: {
      ...input.data,
      exitCode: result.exitCode,
      stdout: stdout.preview,
      stderr: stderr.preview,
      timedOut: result.timedOut,
    },
    execution: {
      outcome,
      started: result.started,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      sideEffectsUncertain: (result.timedOut || result.aborted) && result.started,
    },
    streams: { stdout, stderr },
    stdoutRef,
    stderrRef,
    artifactRefs: [stdout.artifactRef, stderr.artifactRef].filter(
      (ref): ref is string => Boolean(ref),
    ),
    warnings: warnings.length ? warnings : undefined,
    error,
    usage: {
      durationMs: Date.now() - input.started,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
    },
  };
}

function commandExecutionError(
  outcome: ExecutionOutcome,
  spawnErrorCode: string | undefined,
): NonNullable<ToolResult["error"]> {
  const reason =
    outcome === "exited_nonzero"
      ? "nonzero_exit"
      : outcome === "program_not_found"
        ? "program_not_found"
        : outcome;
  const category =
    outcome === "timed_out"
      ? "timeout"
      : outcome === "aborted"
        ? "cancelled"
        : outcome === "program_not_found"
          ? "environment"
          : "execution";
  const retryable = outcome === "spawn_failed" && ["EAGAIN", "EMFILE", "ENFILE"].includes(spawnErrorCode ?? "");
  return {
    code: reason,
    category,
    reason,
    message:
      outcome === "exited_nonzero"
        ? "The process exited with a nonzero status; inspect the bounded output streams."
        : outcome === "timed_out"
          ? "The process exceeded its timeout."
          : outcome === "aborted"
            ? "The process was aborted."
            : outcome === "program_not_found"
              ? "The requested program was not found."
              : "The process could not be started.",
    retryable,
    details: spawnErrorCode ? { spawnErrorCode } : undefined,
  };
}

async function makeOutputStream(
  context: ToolExecutionContext,
  prefix: string,
  stream: "stdout" | "stderr",
  content: string,
  warnings: string[],
) {
  const bytes = Buffer.byteLength(content, "utf8");
  const truncated = bytes > STREAM_PREVIEW_BYTES;
  const preview = previewUtf8(content, STREAM_PREVIEW_BYTES);
  let artifactRef: string | undefined;
  if (truncated) {
    try {
      const artifactsDir = path.join(context.sessionDir, "artifacts");
      await mkdir(artifactsDir, { recursive: true });
      const fileName = `${safeArtifactName(prefix)}.${stream}.txt`;
      await writeFile(path.join(artifactsDir, fileName), content, "utf8");
      artifactRef = `artifact://${encodeURIComponent(fileName)}`;
    } catch (error) {
      warnings.push(`Failed to persist complete ${stream}: ${toErrorMessage(error)}`);
    }
  }
  return { preview, bytes, truncated, artifactRef };
}

function previewUtf8(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) return content;
  const marker = Buffer.from("\n...[output truncated]...\n", "utf8");
  const remaining = Math.max(0, maxBytes - marker.length);
  const headBytes = Math.floor(remaining / 2);
  const tailBytes = remaining - headBytes;
  return Buffer.concat([
    buffer.subarray(0, headBytes),
    marker,
    buffer.subarray(buffer.length - tailBytes),
  ]).toString("utf8");
}

function artifactAbsolutePath(
  context: ToolExecutionContext,
  artifactRef: string | undefined,
): string | undefined {
  if (!artifactRef) return undefined;
  return path.join(context.sessionDir, "artifacts", decodeURIComponent(artifactRef.slice("artifact://".length)));
}

async function persistLargeOutputs(
  context: ToolExecutionContext,
  input: { prefix: string; stdout: string; stderr: string },
): Promise<{ stdoutRef?: string; stderrRef?: string }> {
  const outputsDir = path.join(context.sessionDir, "outputs");
  await mkdir(outputsDir, { recursive: true });
  const refs: { stdoutRef?: string; stderrRef?: string } = {};

  if (Buffer.byteLength(input.stdout) > 12000) {
    refs.stdoutRef = path.join(outputsDir, `${input.prefix}.stdout.txt`);
    await writeFile(refs.stdoutRef, input.stdout, "utf8");
  }
  if (Buffer.byteLength(input.stderr) > 12000) {
    refs.stderrRef = path.join(outputsDir, `${input.prefix}.stderr.txt`);
    await writeFile(refs.stderrRef, input.stderr, "utf8");
  }
  return refs;
}

async function makeChangedFile(input: {
  relativePath: string;
  before: string | undefined;
  after: string;
  sessionDir: string;
}): Promise<ChangedFile> {
  const beforeHash = input.before === undefined ? undefined : sha256(input.before);
  const afterHash = sha256(input.after);
  const artifactBase = safeArtifactName(
    `${input.relativePath}-${beforeHash?.slice(0, 8) ?? "new"}-${afterHash.slice(0, 8)}`,
  );
  const patchesDir = path.join(input.sessionDir, "patches");
  const snapshotsDir = path.join(input.sessionDir, "snapshots");
  await mkdir(patchesDir, { recursive: true });
  await mkdir(snapshotsDir, { recursive: true });

  const diff = createTwoFilesPatch(
    `a/${input.relativePath}`,
    `b/${input.relativePath}`,
    input.before ?? "",
    input.after,
  );
  const patchRef = path.join(patchesDir, `${artifactBase}.patch`);
  await writeFile(patchRef, diff, "utf8");

  let beforeSnapshotRef: string | undefined;
  if (input.before !== undefined) {
    beforeSnapshotRef = path.join(snapshotsDir, `${artifactBase}.before.txt`);
    await writeFile(beforeSnapshotRef, input.before, "utf8");
  }

  return {
    path: input.relativePath,
    operation: input.before === undefined ? "create" : "update",
    beforeHash,
    afterHash,
    diff,
    beforeSnapshotRef,
    patchRef,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function denied(toolCallId: string, summary: string): ToolResult {
  return {
    toolCallId,
    status: "denied",
    summary,
    error: {
      code: "denied",
      category: "permission",
      reason: "denied",
      message: summary,
      retryable: false,
    },
  };
}

function errorResult(toolCallId: string, summary: string, code: string): ToolResult {
  return {
    toolCallId,
    status: "error",
    summary,
    error: {
      code,
      category: "execution",
      reason: code,
      message: summary,
      retryable: false,
    },
  };
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
    : text;
}

function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}

function safeArtifactName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
