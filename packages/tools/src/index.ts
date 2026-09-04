import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isSecretPath,
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "@dreamcode/safety";
import type {
  ChangedFile,
  ExecutionOutcome,
  ShellKind,
  TodoItem,
  Tool,
  ToolExecutionContext,
  ToolModelSpec,
  ToolResult,
  RunMode,
} from "@dreamcode/shared";
import { todoItemSchema, toErrorMessage } from "@dreamcode/shared";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type ProcessLogCursor,
  type ProcessScope,
  ProcessSupervisor,
} from "./process-supervisor.js";

export {
  type ManagedProcessInfo,
  type ManagedProcessState,
  type ProcessLogCursor,
  type ProcessLogsResult,
  type ProcessScope,
  type ProcessStopResult,
  ProcessSupervisor,
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

  toModelSpecs(mode?: RunMode): ToolModelSpec[] {
    return this.list().filter((tool) => isToolExposedInMode(tool.name, mode)).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toToolInputSchema(tool.inputSchema),
    }));
  }
}

function isToolExposedInMode(toolName: string, mode?: RunMode): boolean {
  if (!mode) return true;
  if (mode === "plan") {
    return !toolName.startsWith("file.write") &&
      !toolName.startsWith("file.patch") &&
      !toolName.startsWith("web.") &&
      !toolName.startsWith("mcp.") &&
      toolName !== "job_kill";
  }
  return true;
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
    fileReadTool,
    artifactReadTool,
    fileWriteTool,
    filePatchTool,
    searchGrepTool,
    searchGlobTool,
    createPlatformShellTool(processSupervisor),
    ...createJobTools(processSupervisor),
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

// Runtime details stay internal to execution and permission decisions. The model
// selects the platform-specific tool directly.

const READ_LIMIT = 2_000;
const READ_MAX_LINE_LENGTH = 2_000;
const READ_MAX_BYTES = 50 * 1024;
const READ_STREAM_MIN_SIZE = 10 * 1024 * 1024;

const fileReadSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(READ_LIMIT).default(READ_LIMIT),
});

type FileReadInput = z.infer<typeof fileReadSchema>;

const fileReadTool: Tool<FileReadInput> = {
  name: "file.read",
  description:
    "Read a UTF-8 text file as a line-numbered window. Use offset and limit to continue reading large files.",
  inputSchema: fileReadSchema,
  risk: { tags: ["read_workspace"], readsFiles: true },
  schedule: (rawInput) => ({
    mode: "parallel",
    resources: [
      {
        key: `workspace:${String((rawInput as { file_path?: unknown })?.file_path ?? ".")}`,
        access: "read",
      },
    ],
  }),
  async execute(rawInput, context) {
    const input = fileReadSchema.parse(rawInput);
    return readWorkspaceFile(input, context);
  },
};

async function readWorkspaceFile(
  input: FileReadInput,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if (isSecretPath(input.file_path)) {
    return denied(context.toolCallId, "Refused to read a secret-like file.");
  }

  const resolved = await safeExistingInside(context.workspaceRoot, input.file_path);
  if (!resolved.ok) {
    const unresolved = resolveWorkspacePath(context.workspaceRoot, input.file_path);
    if (unresolved.isInside && !existsSync(unresolved.absolutePath)) {
      setFileObservation(context, unresolved.absolutePath, { kind: "absent" });
    }
    return errorResult(context.toolCallId, resolved.summary, resolved.code);
  }

  const info = await stat(resolved.absolutePath);
  if (!info.isFile()) {
    return errorResult(context.toolCallId, `Cannot read '${input.file_path}': not a regular file.`, "not_regular_file");
  }

  let window: ReadWindowResult;
  try {
    const chunks =
      info.size >= READ_STREAM_MIN_SIZE
        ? createReadStream(resolved.absolutePath, { encoding: "utf8" })
        : [await readFile(resolved.absolutePath, "utf8")];
    window = await buildReadWindow(chunks, input.offset, input.limit, resolved.relativePath);
  } catch (error) {
    if (error instanceof BinaryFileError) {
      return errorResult(context.toolCallId, "Refused to read a binary file.", "binary_file");
    }
    return errorResult(context.toolCallId, toErrorMessage(error), "file_read_failed");
  }

  setFileObservation(context, resolved.absolutePath, { kind: "present", version: window.version });
  const endLine = window.lines.at(-1)?.number ?? Math.max(0, input.offset - 1);
  const continuation = endLine < window.totalLines ? ` Use offset=${endLine + 1} to continue.` : "";

  return {
    toolCallId: context.toolCallId,
    status: "success",
    summary: `Read ${window.lines.length} line(s) from ${resolved.relativePath}; ${window.totalLines} total.${continuation}`,
    data: {
      path: resolved.relativePath,
      offset: input.offset,
      lines: window.lines,
      totalLines: window.totalLines,
    },
  };
}

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
  schedule: { mode: "parallel" },
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

    const exists = existsSync(resolved.absolutePath);
    const observation = getFileObservation(context, resolved.absolutePath);
    let before: string | undefined;
    if (exists) {
      before = await readFile(resolved.absolutePath, "utf8");
      if (observation?.kind !== "present") {
        return errorResult(
          context.toolCallId,
          `Refused to overwrite ${resolved.relativePath} before reading its current version.`,
          "file_not_observed",
        );
      }
      if (sha256(before) !== observation.version) {
        return staleFileResult(context.toolCallId, resolved.relativePath);
      }
    } else if (observation?.kind === "present") {
      return staleFileResult(context.toolCallId, resolved.relativePath);
    }
    await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    try {
      await writeFile(
        resolved.absolutePath,
        input.content,
        exists ? { encoding: "utf8" } : { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if (!exists && (error as NodeJS.ErrnoException).code === "EEXIST") {
        return staleFileResult(context.toolCallId, resolved.relativePath);
      }
      throw error;
    }
    setFileObservation(context, resolved.absolutePath, {
      kind: "present",
      version: sha256(input.content),
    });

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
    const observation = getFileObservation(context, resolved.absolutePath);
    if (observation?.kind !== "present") {
      return errorResult(
        context.toolCallId,
        `Patch requires reading ${resolved.relativePath} first.`,
        "file_not_observed",
      );
    }
    if (sha256(before) !== observation.version) {
      return staleFileResult(context.toolCallId, resolved.relativePath);
    }
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
    setFileObservation(context, resolved.absolutePath, {
      kind: "present",
      version: sha256(after),
    });
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

const searchGrepSchema = z.object({
  pattern: z.string().refine((value) => value.length > 0, "pattern must be non-empty"),
  path: z.string().trim().min(1).optional(),
  include: z.string().optional().superRefine((value, issue) => {
    if (value === undefined) return;
    const error = validateSinglePositiveGlob(value);
    if (error) issue.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }),
});

const searchGrepTool: Tool<z.infer<typeof searchGrepSchema>> = {
  name: "search.grep",
  description:
    "Find matching lines with packaged ripgrep. Returns path, lineNumber, and line; use file.read for context.",
  inputSchema: searchGrepSchema,
  risk: { tags: ["read_workspace"], readsFiles: true },
  schedule: { mode: "parallel", maxConcurrency: 4 },
  async execute(rawInput, context) {
    const input = searchGrepSchema.parse(rawInput);
    const searchRoot = await resolveSearchPath(context, input.path, false);
    if (!searchRoot.ok) return searchRoot.result;
    const run = await runPackagedRipgrep(
      ["--json", `--regexp=${input.pattern}`, ...(input.include ? [`--glob=${input.include}`] : []), "--", searchRoot.relativePath],
      context.workspaceRoot,
      context.signal,
      "grep",
    );
    if (!run.ok) return searchErrorResult(context.toolCallId, run);
    const matches = run.noMatches
      ? []
      : parseRipgrepJson(run.stdout).map((match) => ({ ...match, path: cleanRipgrepPath(match.path) }));
    const retained = matches.slice(0, GREP_MAX_MATCHES).map((match) => ({
      ...match,
      line: truncateUtf8(match.line, GREP_MAX_LINE_BYTES, " (line truncated)"),
    }));
    const artifactRef =
      matches.length > retained.length
        ? await saveSearchArtifact(
            context,
            "grep-results.txt",
            formatGrepMatches(matches),
          )
        : undefined;

    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary:
        matches.length > retained.length
          ? `Found ${matches.length} matches; showing ${retained.length}. Full result: ${artifactRef ?? "not saved; narrow pattern, path, or include"}. Use file.read for context.`
          : `Found ${matches.length} match${matches.length === 1 ? "" : "es"}. Use file.read for context.`,
      data: { matches: retained },
      ...(artifactRef ? { artifactRefs: [artifactRef] } : {}),
    };
  },
};

const searchGlobSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().trim().min(1).optional(),
});

const searchGlobTool: Tool<z.infer<typeof searchGlobSchema>> = {
  name: "search.glob",
  description:
    "Find files by glob with packaged ripgrep. Includes hidden and ignored files, excludes VCS metadata, and never returns directories.",
  inputSchema: searchGlobSchema,
  risk: { tags: ["read_workspace"], readsFiles: true },
  schedule: { mode: "parallel", maxConcurrency: 4 },
  async execute(rawInput, context) {
    const input = searchGlobSchema.parse(rawInput);
    const searchRoot = await resolveSearchPath(context, input.path, true);
    if (!searchRoot.ok) return searchRoot.result;
    const run = await runPackagedRipgrep(
      [
        "--files",
        `--glob=${input.pattern}`,
        "--sort=modified",
        "--no-ignore",
        "--hidden",
        ...GLOB_VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
        "--",
        searchRoot.relativePath,
      ],
      context.workspaceRoot,
      context.signal,
      "glob",
    );
    if (!run.ok) return searchErrorResult(context.toolCallId, run);
    const paths = run.noMatches
      ? []
      : run.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map(cleanRipgrepPath);
    const sample =
      paths.length > GLOB_MAX_RESULTS
        ? sampleAcrossTopLevel(paths, GLOB_MAX_RESULTS, searchRoot.relativePath)
        : { items: paths, shown: countTopLevels(paths, searchRoot.relativePath), total: countTopLevels(paths, searchRoot.relativePath) };
    const artifactRef =
      paths.length > sample.items.length
        ? await saveSearchArtifact(context, "glob-results.txt", paths.join("\n"))
        : undefined;
    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary:
        paths.length > sample.items.length
          ? `Found ${paths.length} files; showing ${sample.items.length} sampled across ${sample.shown} of ${sample.total} top-level entries. Full result: ${artifactRef ?? "not saved; narrow pattern or path"}.`
          : `Found ${paths.length} file${paths.length === 1 ? "" : "s"} in modification-time order.`,
      data: { root: searchRoot.relativePath, paths: sample.items },
      ...(artifactRef ? { artifactRefs: [artifactRef] } : {}),
    };
  },
};

const GREP_MAX_MATCHES = 250;
const GREP_MAX_LINE_BYTES = 2_000;
const GLOB_MAX_RESULTS = 100;
const SEARCH_RAW_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;

type FileObservation = { kind: "absent" } | { kind: "present"; version: string };
const fileObservations = new Map<string, Map<string, FileObservation>>();

function observationOwner(context: ToolExecutionContext): string {
  return context.sessionId ?? path.resolve(context.sessionDir);
}

function observationKey(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getFileObservation(
  context: ToolExecutionContext,
  absolutePath: string,
): FileObservation | undefined {
  return fileObservations.get(observationOwner(context))?.get(observationKey(absolutePath));
}

function setFileObservation(
  context: ToolExecutionContext,
  absolutePath: string,
  observation: FileObservation,
): void {
  const owner = observationOwner(context);
  let observed = fileObservations.get(owner);
  if (!observed) {
    observed = new Map();
    fileObservations.set(owner, observed);
  }
  observed.set(observationKey(absolutePath), observation);
}

function staleFileResult(toolCallId: string, relativePath: string): ToolResult {
  return errorResult(
    toolCallId,
    `${relativePath} changed since it was read. Read it again before retrying the write.`,
    "stale_file_version",
  );
}

class BinaryFileError extends Error {}

interface ReadWindowResult {
  lines: Array<{ number: number; text: string }>;
  totalLines: number;
  version: string;
}

async function buildReadWindow(
  chunks: AsyncIterable<string | Buffer> | Iterable<string | Buffer>,
  offset: number,
  limit: number,
  displayPath: string,
): Promise<ReadWindowResult> {
  const lines: Array<{ number: number; text: string }> = [];
  const hash = createHash("sha256");
  let totalLines = 0;
  let outputBytes = 0;
  let outputCapped = false;
  let lineBuffer = "";

  const consume = () => {
    totalLines += 1;
    if (outputCapped || totalLines < offset || lines.length >= limit) return;
    const raw = lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
    const text =
      raw.length > READ_MAX_LINE_LENGTH
        ? `${raw.slice(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
        : raw;
    const bytes = Buffer.byteLength(text, "utf8") + (lines.length ? 1 : 0);
    if (outputBytes + bytes > READ_MAX_BYTES) {
      outputCapped = true;
      return;
    }
    outputBytes += bytes;
    lines.push({ number: totalLines, text });
  };

  for await (const rawChunk of chunks) {
    const chunk = typeof rawChunk === "string" ? rawChunk : rawChunk.toString("utf8");
    if (chunk.includes("\0")) throw new BinaryFileError();
    hash.update(chunk, "utf8");
    let start = 0;
    let newline = chunk.indexOf("\n", start);
    while (newline !== -1) {
      if (lineBuffer.length <= READ_MAX_LINE_LENGTH) {
        lineBuffer += chunk.slice(start, newline);
        if (lineBuffer.length > READ_MAX_LINE_LENGTH + 1) {
          lineBuffer = lineBuffer.slice(0, READ_MAX_LINE_LENGTH + 1);
        }
      }
      consume();
      lineBuffer = "";
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    if (lineBuffer.length <= READ_MAX_LINE_LENGTH) {
      lineBuffer += chunk.slice(start);
      if (lineBuffer.length > READ_MAX_LINE_LENGTH + 1) {
        lineBuffer = lineBuffer.slice(0, READ_MAX_LINE_LENGTH + 1);
      }
    }
  }
  if (lineBuffer.length > 0) consume();
  if (offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new Error(`offset ${offset} is out of range for '${displayPath}' (${totalLines} lines)`);
  }
  return { lines, totalLines, version: hash.digest("hex") };
}

function validateSinglePositiveGlob(value: string): string | undefined {
  if (!value.trim()) return "include must be a non-empty glob when given";
  if (value.startsWith("!")) return "include must be a positive glob filter";
  let braceDepth = 0;
  for (const character of value) {
    if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (character === "," && braceDepth === 0) return "include must be one glob";
  }
  return undefined;
}

async function resolveSearchPath(
  context: ToolExecutionContext,
  inputPath: string | undefined,
  requireDirectory: boolean,
): Promise<
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; result: ToolResult }
> {
  const requested = inputPath ?? ".";
  const resolved = await safeExistingInside(context.workspaceRoot, requested);
  if (!resolved.ok) {
    return { ok: false, result: errorResult(context.toolCallId, resolved.summary, resolved.code) };
  }
  const info = await stat(resolved.absolutePath);
  if (requireDirectory && !info.isDirectory()) {
    return {
      ok: false,
      result: errorResult(context.toolCallId, `Search path is not a directory: ${requested}`, "not_directory"),
    };
  }
  return { ok: true, absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
}

type SearchRun =
  | { ok: true; stdout: string; noMatches: boolean }
  | { ok: false; code: string; message: string; cancelled?: boolean };

let ripgrepPathPromise: Promise<string> | undefined;

async function packagedRipgrepPath(): Promise<string> {
  ripgrepPathPromise ??= import("@vscode/ripgrep").then((module) => module.rgPath);
  return ripgrepPathPromise;
}

async function runPackagedRipgrep(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  toolName: "grep" | "glob",
): Promise<SearchRun> {
  if (signal?.aborted) {
    return { ok: false, code: "search_aborted", message: `${toolName} was aborted.`, cancelled: true };
  }
  let executable: string;
  try {
    executable = await packagedRipgrepPath();
  } catch (error) {
    return { ok: false, code: "search_failed", message: `Packaged ripgrep could not be loaded: ${toErrorMessage(error)}` };
  }
  const result = await runProcess(executable, ["--no-config", ...args], {
    cwd,
    timeoutMs: 15_000,
    signal,
    maxStdoutBytes: SEARCH_RAW_OUTPUT_MAX_BYTES,
  });
  if (result.aborted || result.timedOut) {
    return {
      ok: false,
      code: "search_aborted",
      message: `${toolName} was aborted before completion.`,
      cancelled: true,
    };
  }
  if (!result.started) {
    return { ok: false, code: "search_failed", message: `${toolName} could not start packaged ripgrep.` };
  }
  if (result.outputOverflow) {
    return {
      ok: false,
      code: "search_output_overflow",
      message: `${toolName} output exceeded the raw byte limit; narrow pattern, path, or include.`,
    };
  }
  if (result.exitCode === 1) return { ok: true, stdout: "", noMatches: true };
  if (result.exitCode !== 0) {
    const invalid = result.exitCode === 2 && /regex parse error|error parsing regex/i.test(result.stderr);
    return {
      ok: false,
      code: invalid ? "search_invalid_pattern" : "search_failed",
      message: invalid
        ? `${toolName} pattern was rejected by ripgrep: ${truncate(result.stderr.trim(), 2_000)}`
        : `${toolName} failed with exit ${result.exitCode}: ${truncate(result.stderr.trim(), 2_000)}`,
    };
  }
  return { ok: true, stdout: result.stdout, noMatches: false };
}

function searchErrorResult(toolCallId: string, run: Extract<SearchRun, { ok: false }>): ToolResult {
  const result = errorResult(toolCallId, run.message, run.code);
  if (run.cancelled) result.status = "cancelled";
  return result;
}

interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

function parseRipgrepJson(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const recordLine of stdout.split("\n")) {
    if (!recordLine) continue;
    let record: unknown;
    try {
      record = JSON.parse(recordLine);
    } catch (error) {
      throw new Error(`grep received malformed ripgrep JSON: ${toErrorMessage(error)}`);
    }
    if (!record || typeof record !== "object" || (record as { type?: unknown }).type !== "match") continue;
    const data = (record as { data?: unknown }).data;
    if (!data || typeof data !== "object") throw new Error("grep match record has no data");
    const item = data as {
      path?: { text?: unknown };
      line_number?: unknown;
      lines?: { text?: unknown; bytes?: unknown };
    };
    if (typeof item.path?.text !== "string" || typeof item.line_number !== "number" || !item.lines) {
      throw new Error("grep match record is missing path, line number, or line content");
    }
    const line =
      typeof item.lines.text === "string"
        ? item.lines.text.replace(/\r?\n$/, "")
        : typeof item.lines.bytes === "string"
          ? "(line is not valid UTF-8)"
          : undefined;
    if (line === undefined) throw new Error("grep match record has no line content");
    matches.push({ path: item.path.text, lineNumber: item.line_number, line });
  }
  return matches;
}

function cleanRipgrepPath(entry: string): string {
  return entry.replace(/^[.][\\/]/, "");
}

function truncateUtf8(value: string, maxBytes: number, suffix: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let kept = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  kept = kept.replace(/\uFFFD+$/, "");
  return `${kept}${suffix}`;
}

function formatGrepMatches(matches: GrepMatch[]): string {
  const groups = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.path);
    if (group) group.push(match);
    else groups.set(match.path, [match]);
  }
  return [...groups.entries()]
    .map(([filePath, group]) => `${filePath}\n${group.map((item) => `Line ${item.lineNumber}: ${item.line}`).join("\n")}`)
    .join("\n\n");
}

function relativeToSampleRoot(filePath: string, root: string): string {
  if (root === ".") return filePath;
  const relative = path.relative(root, filePath);
  return relative.startsWith("..") ? filePath : relative;
}

function topLevel(filePath: string, root: string): string {
  return relativeToSampleRoot(filePath, root).split(/[\\/]/)[0] ?? "";
}

function countTopLevels(paths: readonly string[], root: string): number {
  return new Set(paths.map((filePath) => topLevel(filePath, root))).size;
}

function sampleAcrossTopLevel(
  paths: readonly string[],
  limit: number,
  root: string,
): { items: string[]; shown: number; total: number } {
  const groups = new Map<string, string[]>();
  for (const filePath of paths) {
    const key = topLevel(filePath, root);
    const group = groups.get(key);
    if (group) group.push(filePath);
    else groups.set(key, [filePath]);
  }
  const selected = new Map<string, string[]>();
  let active = [...groups.entries()].map(([key, items]) => ({ key, items, index: 0 }));
  let count = 0;
  while (active.length && count < limit) {
    const next: typeof active = [];
    for (const group of active) {
      if (count >= limit) break;
      const item = group.items[group.index];
      if (item === undefined) continue;
      const bucket = selected.get(group.key);
      if (bucket) bucket.push(item);
      else selected.set(group.key, [item]);
      count += 1;
      if (group.index + 1 < group.items.length) next.push({ ...group, index: group.index + 1 });
    }
    active = next;
  }
  return { items: [...selected.values()].flat(), shown: selected.size, total: groups.size };
}

async function saveSearchArtifact(
  context: ToolExecutionContext,
  suggestedName: string,
  content: string,
): Promise<string | undefined> {
  try {
    const directory = path.join(context.sessionDir, "artifacts");
    await mkdir(directory, { recursive: true });
    const name = `${safeArtifactName(context.toolCallId)}-${suggestedName}`;
    await writeFile(path.join(directory, name), content, "utf8");
    return `artifact://${encodeURIComponent(name)}`;
  } catch {
    return undefined;
  }
}

const commandEnvironmentSchema = z.record(z.string());

function managedProcessScope(context: ToolExecutionContext): ProcessScope {
  return {
    sessionId: context.sessionId ?? path.resolve(context.sessionDir),
    sessionDir: context.sessionDir,
    workspaceRoot: context.workspaceRoot,
  };
}

function managedProcessErrorResult(
  toolCallId: string,
  error: unknown,
  command?: string,
): ToolResult {
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

const platformShellSchema = z.object({
  command: z.string().min(1),
  description: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: commandEnvironmentSchema.optional(),
  timeoutMs: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).default(30000),
  run_in_background: z.boolean().default(false),
});

function createPlatformShellTool(supervisor: ProcessSupervisor): Tool {
  const windows = process.platform === "win32";
  const name = windows ? "pwsh" : "bash";
  const shell: ShellKind = windows ? "powershell" : "bash";
  const program = windows ? "pwsh" : "bash";
  const description = windows
    ? "Execute a PowerShell command (pwsh -Command). Each call runs in a fresh PowerShell process. Set run_in_background=true for long-running commands. Use job_output to inspect background work and job_kill to stop it."
    : "Execute a Bash command (bash -c). Each call runs in a fresh shell. Set run_in_background=true for long-running commands. Use job_output to inspect background work and job_kill to stop it.";
  return {
    name,
    description,
    inputSchema: platformShellSchema,
    risk: { tags: ["shell_mutating"], runsCommands: true },
    schedule: { mode: "exclusive" },
    preflight(rawInput, context) {
      const parsed = platformShellSchema.safeParse(rawInput);
      if (!parsed.success) return commandInputValidationResult(context.toolCallId, parsed.error.issues);
      const violations = validateShellCommand(parsed.data.command, shell);
      return violations.length ? commandValidationResult(context.toolCallId, violations) : undefined;
    },
    async execute(rawInput, context) {
      const input = platformShellSchema.parse(rawInput);
      const violations = validateShellCommand(input.command, shell);
      if (violations.length) return commandValidationResult(context.toolCallId, violations);
      const cwd = resolveCommandCwd(context.workspaceRoot, input.cwd);
      const cwdError = await commandCwdError(context.toolCallId, cwd);
      if (cwdError) return cwdError;
      const args = windows ? ["-NoProfile", "-Command", input.command] : ["-c", input.command];
      if (input.run_in_background) {
        try {
          const info = await supervisor.start(managedProcessScope(context), {
            program,
            args,
            cwd,
            env: mergeCommandEnvironment(input.env),
            label: input.description,
            signal: context.signal,
          });
          return {
            toolCallId: context.toolCallId,
            status: "success",
            summary: `Started background job ${info.processId}.`,
            data: { kind: "background", jobId: info.processId },
            execution: { outcome: "background_started", started: true },
          };
        } catch (error) {
          return managedProcessErrorResult(context.toolCallId, error, input.command);
        }
      }
      const started = Date.now();
      const result = await runShellExpression(input.command, program, args, {
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
        prefix: `${name}-${context.toolCallId}`,
        data: { kind: "foreground", command: input.command, cwd },
      });
    },
  };
}

const jobIdSchema = z.string().regex(/^proc_[a-f0-9]{32}$/);
const jobScope = (context: ToolExecutionContext): ProcessScope => managedProcessScope(context);

function createJobTools(supervisor: ProcessSupervisor): Tool[] {
  const outputSchema = z.object({
    job_id: jobIdSchema,
    wait: z.boolean().default(false),
    timeout_ms: z.number().int().nonnegative().max(MAX_COMMAND_TIMEOUT_MS).default(1000),
    cursor: z.object({ stdoutOffset: z.number().int().nonnegative(), stderrOffset: z.number().int().nonnegative() }).default({ stdoutOffset: 0, stderrOffset: 0 }),
    max_bytes: z.number().int().min(1024).max(64 * 1024).default(16 * 1024),
  });
  const output: Tool = {
    name: "job_output",
    description: "Read output and lifecycle status for a background job. Set wait=true to wait briefly for completion.",
    inputSchema: outputSchema,
    risk: { tags: [] },
    async execute(rawInput, context) {
      const input = outputSchema.parse(rawInput);
      if (input.wait) {
        const deadline = Date.now() + input.timeout_ms;
        while (Date.now() < deadline) {
          const status = await supervisor.status(jobScope(context), input.job_id);
          if (!status.alive) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      try {
        const [status, logs] = await Promise.all([
          supervisor.status(jobScope(context), input.job_id),
          supervisor.logs(jobScope(context), input.job_id, input.cursor, input.max_bytes),
        ]);
        return { toolCallId: context.toolCallId, status: "success", summary: `Read output for job ${input.job_id}.`, data: { text: [logs.stdout.text, logs.stderr.text].filter(Boolean).join("\n"), job: { id: status.processId, status: status.state, label: status.label, startedAt: status.startedAt, finishedAt: status.endedAt }, nextCursor: logs.nextCursor, hasMore: logs.hasMore } };
      } catch (error) { return managedProcessErrorResult(context.toolCallId, error); }
    },
  };
  const list: Tool = {
    name: "job_list",
    description: "List background jobs in the current session.",
    inputSchema: z.object({}),
    risk: { tags: [] },
    async execute(_rawInput, context) { return { toolCallId: context.toolCallId, status: "success", summary: "Listed background jobs.", data: { jobs: (await supervisor.list(jobScope(context))).map((job) => ({ id: job.processId, status: job.state, label: job.label, startedAt: job.startedAt, finishedAt: job.endedAt })) } }; },
  };
  const killSchema = z.object({ job_id: jobIdSchema, reason: z.string().max(500).optional() });
  const kill: Tool = {
    name: "job_kill",
    description: "Stop a background job and its process tree.",
    inputSchema: killSchema,
    risk: { tags: ["long_running"], runsCommands: true },
    async execute(rawInput, context) { const input = killSchema.parse(rawInput); try { const result = await supervisor.stop(jobScope(context), input.job_id); return { toolCallId: context.toolCallId, status: "success", summary: `Stopped job ${input.job_id}.`, data: { ...result, reason: input.reason } }; } catch (error) { return managedProcessErrorResult(context.toolCallId, error); } },
  };
  return [output, list, kill];
}

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
      return errorResult(
        context.toolCallId,
        "Skill Registry is unavailable.",
        "skill_registry_unavailable",
      );
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
      return errorResult(
        context.toolCallId,
        "Skill Registry is unavailable.",
        "skill_registry_unavailable",
      );
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

export interface ShellCommandViolation {
  code: "multiple_shell_steps" | "stateful_shell_construct" | "unterminated_quote";
  message: string;
  position?: number;
}

export function validateShellCommand(command: string, shell: ShellKind): ShellCommandViolation[] {
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
    if (
      character === ";" ||
      character === "\n" ||
      character === "\r" ||
      pair === "&&" ||
      pair === "||"
    ) {
      violations.push({
        code: "multiple_shell_steps",
        message: "The shell tool accepts one expression or pipeline; run independent steps separately.",
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
        message:
          "Use the cwd or env field instead of shell state that cannot persist across calls.",
        position: command.indexOf(segment),
      });
    }
  }

  return violations.filter(
    (violation, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === violation.code && candidate.position === violation.position,
      ) === index,
  );
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
  outputOverflow?: boolean;
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    maxStdoutBytes?: number;
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
    collectProcess(child, options.timeoutMs, options.signal, resolve, options.maxStdoutBytes);
  });
}

async function runShellExpression(
  command: string,
  shell: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(shell, args, {
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

function collectProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  resolve: (result: ProcessResult) => void,
  maxStdoutBytes?: number,
): void {
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let started = false;
  let aborted = Boolean(signal?.aborted);
  let stdoutBytes = 0;
  let outputOverflow = false;
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
    const buffer = Buffer.from(chunk);
    stdoutBytes += buffer.length;
    if (maxStdoutBytes !== undefined && stdoutBytes > maxStdoutBytes) {
      outputOverflow = true;
      terminateProcessTree(child);
      return;
    }
    stdout += buffer.toString();
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
        outputOverflow,
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
        outputOverflow,
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
  const stdout = await makeOutputStream(
    input.context,
    input.prefix,
    "stdout",
    result.stdout,
    warnings,
  );
  const stderr = await makeOutputStream(
    input.context,
    input.prefix,
    "stderr",
    result.stderr,
    warnings,
  );
  const stdoutRef = artifactAbsolutePath(input.context, stdout.artifactRef);
  const stderrRef = artifactAbsolutePath(input.context, stderr.artifactRef);
  const error =
    status === "success" ? undefined : commandExecutionError(outcome, result.spawnErrorCode);
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
    artifactRefs: [stdout.artifactRef, stderr.artifactRef].filter((ref): ref is string =>
      Boolean(ref),
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
  const retryable =
    outcome === "spawn_failed" && ["EAGAIN", "EMFILE", "ENFILE"].includes(spawnErrorCode ?? "");
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
  return path.join(
    context.sessionDir,
    "artifacts",
    decodeURIComponent(artifactRef.slice("artifact://".length)),
  );
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

function safeArtifactName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
