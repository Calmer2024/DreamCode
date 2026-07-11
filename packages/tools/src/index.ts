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

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ToolRegistryOptions {
  mcpServers?: Record<string, McpServerConfig>;
}

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

export function createDefaultToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(options)) {
    registry.register(tool);
  }
  return registry;
}

export function createBuiltinTools(options: ToolRegistryOptions = {}): Tool[] {
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
    webSearchTool,
    webFetchTool,
    skillListTool,
    skillReadTool,
    skillReadResourceTool,
    createMcpListTool(options.mcpServers ?? {}),
    createMcpCallTool(options.mcpServers ?? {}),
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

const webSearchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(10).default(5),
  domains: z.array(z.string().min(1)).optional(),
});

const webSearchTool: Tool<z.infer<typeof webSearchSchema>> = {
  name: "web.search",
  description: "Search public web pages and return source candidates with URLs.",
  inputSchema: webSearchSchema,
  risk: { tags: ["network_access", "web_fetch"] },
  async execute(rawInput, context) {
    const input = webSearchSchema.parse(rawInput);
    const started = Date.now();
    const results = await searchWeb(input, context.signal);
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

const skillListSchema = z.object({});

const skillListTool: Tool<z.infer<typeof skillListSchema>> = {
  name: "skill.list",
  description: "List available DreamCode skills without loading their full instruction files.",
  inputSchema: skillListSchema,
  risk: { tags: ["read_workspace"] },
  async execute(_rawInput, context) {
    const skills = await listSkills(context);
    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Found ${skills.length} skill${skills.length === 1 ? "" : "s"}.`,
      data: { skills },
    };
  },
};

const skillReadSchema = z.object({
  name: z.string().min(1),
});

const skillReadTool: Tool<z.infer<typeof skillReadSchema>> = {
  name: "skill.read",
  description: "Read the full SKILL.md for a named DreamCode skill.",
  inputSchema: skillReadSchema,
  risk: { tags: ["read_workspace"] },
  async execute(rawInput, context) {
    const input = skillReadSchema.parse(rawInput);
    const skill = (await listSkills(context)).find((item) => item.name === input.name);
    if (!skill) {
      return errorResult(context.toolCallId, `Skill not found: ${input.name}`, "skill_not_found");
    }
    const content = await readFile(path.join(skill.path, "SKILL.md"), "utf8");
    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Loaded skill ${input.name}.`,
      data: {
        name: skill.name,
        path: skill.path,
        content,
      },
    };
  },
};

const skillReadResourceSchema = z.object({
  name: z.string().min(1),
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
    const skill = (await listSkills(context)).find((item) => item.name === input.name);
    if (!skill) {
      return errorResult(context.toolCallId, `Skill not found: ${input.name}`, "skill_not_found");
    }
    const target = path.resolve(skill.path, input.resourcePath);
    if (!isInsidePath(skill.path, target)) {
      return denied(context.toolCallId, "Refused to read outside the skill directory.");
    }
    const content = await readFile(target, "utf8");
    return {
      toolCallId: context.toolCallId,
      status: "success",
      summary: `Read skill resource ${input.name}/${input.resourcePath}.`,
      data: {
        name: input.name,
        resourcePath: input.resourcePath,
        content: truncate(content, input.maxBytes),
        truncated: content.length > input.maxBytes,
      },
    };
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

  if (/^https?:\/\//i.test(input.query)) {
    return [
      { title: input.query, url: input.query, snippet: "Direct URL query.", source: "direct" },
    ];
  }

  const query = input.domains?.length
    ? `${input.query} ${input.domains.map((domain) => `site:${domain}`).join(" ")}`
    : input.query;
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": "DreamCode/0.1 (+https://local.dreamcode)",
    },
  });
  const html = await response.text();
  const results: Array<{ title: string; url: string; snippet: string; source: string }> = [];
  const resultPattern =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(resultPattern)) {
    const rawUrl = decodeHtml(match[1] ?? "");
    const parsedUrl = extractDuckDuckGoUrl(rawUrl);
    results.push({
      title: stripHtml(match[2] ?? "").trim(),
      url: parsedUrl,
      snippet: stripHtml(match[3] ?? "").trim(),
      source: "duckduckgo-html",
    });
    if (results.length >= input.maxResults) {
      break;
    }
  }
  return results;
}

function extractDuckDuckGoUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.href;
  } catch {
    return rawUrl;
  }
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

interface SkillSummary {
  name: string;
  description: string;
  source: "workspace" | "global";
  path: string;
}

async function listSkills(context: ToolExecutionContext): Promise<SkillSummary[]> {
  const roots: Array<{ source: SkillSummary["source"]; path: string }> = [
    { source: "workspace", path: path.join(context.workspaceRoot, ".dreamcode", "skills") },
    { source: "global", path: path.join(getHomeFromSessionDir(context.sessionDir), "skills") },
  ];
  const skills: SkillSummary[] = [];
  for (const root of roots) {
    if (!existsSync(root.path)) {
      continue;
    }
    const entries = await readdir(root.path, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillPath = path.join(root.path, entry.name);
      const skillFile = path.join(skillPath, "SKILL.md");
      if (!existsSync(skillFile)) {
        continue;
      }
      const content = await readFile(skillFile, "utf8");
      skills.push({
        name: entry.name,
        description: readSkillDescription(content),
        source: root.source,
        path: skillPath,
      });
    }
  }
  return skills;
}

function readSkillDescription(content: string): string {
  const descriptionMatch = /^description:\s*(.+)$/im.exec(content);
  if (descriptionMatch?.[1]) {
    return descriptionMatch[1].trim();
  }
  const headingMatch = /^#\s+(.+)$/m.exec(content);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  const firstParagraph = content
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return firstParagraph?.slice(0, 200) ?? "No description.";
}

function getHomeFromSessionDir(sessionDir: string): string {
  return path.dirname(path.dirname(sessionDir));
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
