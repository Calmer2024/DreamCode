import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ContextBuildInput, ContextBuildResult, ToolCallObservation } from "@dreamcode/shared";
import fg from "fast-glob";

export interface ContextBuilderOptions {
  maxWorkspaceFiles?: number;
  maxObservationChars?: number;
}

export class ContextBuilder {
  private readonly maxWorkspaceFiles: number;
  private readonly maxObservationChars: number;

  constructor(options: ContextBuilderOptions = {}) {
    this.maxWorkspaceFiles = options.maxWorkspaceFiles ?? 80;
    this.maxObservationChars = options.maxObservationChars ?? 16000;
  }

  async build(input: ContextBuildInput): Promise<ContextBuildResult> {
    const workspaceSummary = await buildWorkspaceSummary(
      input.workspaceRoot,
      this.maxWorkspaceFiles,
    );
    const projectRules = await readProjectRules(input.workspaceRoot);
    const todoSummary = input.todoItems.length
      ? input.todoItems.map((item) => `- [${statusMark(item.status)}] ${item.content}`).join("\n")
      : "No todo items yet.";
    const observations = compressObservations(input.observations, this.maxObservationChars);

    const system = [
      "You are DreamCode, a local CLI coding/task agent.",
      "You can inspect, edit, run commands, and verify work by calling tools.",
      "Every tool call is checked by a permission engine before execution.",
      "Respect workspace boundaries. Do not request secret files. Prefer small, evidenced steps.",
      "After requested edits are done and verified enough, stop calling tools and give the final answer.",
      `Current mode: ${input.mode}.`,
    ].join("\n");

    const user = [
      `User objective:\n${input.prompt}`,
      "",
      `Conversation so far:\n${input.conversationSummary || "No earlier turns in this interactive session."}`,
      "",
      `Workspace summary:\n${workspaceSummary}`,
      "",
      `Project rules:\n${projectRules || "No DREAMCODE.md found."}`,
      "",
      `Todo:\n${todoSummary}`,
      "",
      `Recent tool observations:\n${observations || "No tool observations yet."}`,
    ].join("\n");

    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      summary: `Context built with ${input.observations.length} observation(s).`,
    };
  }
}

export function compressText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const head = text.slice(0, Math.floor(maxChars * 0.65));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.25));
  return {
    text: `${head}\n...[compressed ${text.length - maxChars} chars]...\n${tail}`,
    truncated: true,
  };
}

async function buildWorkspaceSummary(workspaceRoot: string, maxFiles: number): Promise<string> {
  const entries = await fg(["**/*"], {
    cwd: workspaceRoot,
    dot: false,
    onlyFiles: false,
    unique: true,
    ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/coverage/**"],
  });
  const limited = entries.slice(0, maxFiles);
  const suffix =
    entries.length > limited.length ? `\n...and ${entries.length - limited.length} more` : "";
  return limited.join("\n") + suffix;
}

async function readProjectRules(workspaceRoot: string): Promise<string> {
  const rulesPath = path.join(workspaceRoot, "DREAMCODE.md");
  if (!existsSync(rulesPath)) {
    return "";
  }
  const content = await readFile(rulesPath, "utf8");
  return compressText(content, 12000).text;
}

function compressObservations(observations: ToolCallObservation[], maxChars: number): string {
  const text = observations
    .slice(-20)
    .map((observation) => {
      const result = observation.result;
      return [
        `Tool: ${observation.toolCall.name}`,
        `Decision: ${observation.decision.decision} (${observation.decision.reason})`,
        `Status: ${result.status}`,
        `Summary: ${result.summary}`,
        result.changedFiles?.length
          ? `Changed files: ${result.changedFiles.map((file) => file.path).join(", ")}`
          : undefined,
        result.data ? `Data: ${JSON.stringify(result.data)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return compressText(text, maxChars).text;
}

function statusMark(status: string): string {
  switch (status) {
    case "completed":
      return "x";
    case "in_progress":
      return "~";
    case "blocked":
      return "!";
    default:
      return " ";
  }
}
