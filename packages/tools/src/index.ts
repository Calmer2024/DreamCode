import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isSecretPath,
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "@dreamcode/safety";
import type {
  ChangedFile,
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

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

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

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools()) {
    registry.register(tool);
  }
  return registry;
}

export function createBuiltinTools(): Tool[] {
  return [
    fileReadTool,
    fileWriteTool,
    filePatchTool,
    fileListTool,
    searchGrepTool,
    searchGlobTool,
    shellRunTool,
    gitStatusTool,
    gitDiffTool,
    todoWriteTool,
    questionAskTool,
  ];
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

    const changedFile = makeChangedFile({
      relativePath: resolved.relativePath,
      before,
      after: input.content,
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
    const changedFile = makeChangedFile({ relativePath: resolved.relativePath, before, after });

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

const shellRunSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(120000).default(30000),
});

const shellRunTool: Tool<z.infer<typeof shellRunSchema>> = {
  name: "shell.run",
  description:
    "Run a non-interactive shell command in the workspace with timeout and captured output.",
  inputSchema: shellRunSchema,
  risk: { tags: ["shell_mutating"], runsCommands: true },
  async execute(rawInput, context) {
    const input = shellRunSchema.parse(rawInput);
    const started = Date.now();
    const result = await runShell(input.command, {
      cwd: context.workspaceRoot,
      timeoutMs: input.timeoutMs,
      signal: context.signal,
    });
    const refs = await persistLargeOutputs(context, {
      prefix: safeArtifactName(`shell-${context.toolCallId}`),
      stdout: result.stdout,
      stderr: result.stderr,
    });

    const status = result.timedOut ? "cancelled" : result.exitCode === 0 ? "success" : "error";
    return {
      toolCallId: context.toolCallId,
      status,
      summary: `Command '${input.command}' exited with ${result.exitCode}${result.timedOut ? " after timeout" : ""}.`,
      data: {
        command: input.command,
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, 12000),
        stderr: truncate(result.stderr, 12000),
        timedOut: result.timedOut,
      },
      stdoutRef: refs.stdoutRef,
      stderrRef: refs.stderrRef,
      usage: {
        durationMs: Date.now() - started,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
      },
    };
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

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function runShell(
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    collectProcess(child, options.timeoutMs, resolve);
  });
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    collectProcess(child, options.timeoutMs, resolve);
  });
}

function collectProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  resolve: (result: ProcessResult) => void,
): void {
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
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
      resolve({ stdout, stderr: stderr + toErrorMessage(error), exitCode: 127, timedOut });
    }
  });
  child.on("close", (code) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    }
  });
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

function makeChangedFile(input: {
  relativePath: string;
  before: string | undefined;
  after: string;
}): ChangedFile {
  return {
    path: input.relativePath,
    operation: input.before === undefined ? "create" : "update",
    beforeHash: input.before === undefined ? undefined : sha256(input.before),
    afterHash: sha256(input.after),
    diff: createTwoFilesPatch(
      `a/${input.relativePath}`,
      `b/${input.relativePath}`,
      input.before ?? "",
      input.after,
    ),
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
      message: summary,
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
      message: summary,
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
