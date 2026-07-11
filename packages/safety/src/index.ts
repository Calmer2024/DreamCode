import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  NormalizedToolCall,
  PermissionDecision,
  PermissionDecisionKind,
  RiskTag,
  RunMode,
} from "@dreamcode/shared";

export interface ResolvedWorkspacePath {
  inputPath: string;
  absolutePath: string;
  relativePath: string;
  isInside: boolean;
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
): ResolvedWorkspacePath {
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, inputPath);
  const relativePath = path.relative(root, absolutePath);
  const isInside =
    relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

  return {
    inputPath,
    absolutePath,
    relativePath: toPosixPath(relativePath === "" ? "." : relativePath),
    isInside,
  };
}

export async function resolveExistingWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
): Promise<ResolvedWorkspacePath> {
  const root = await realpath(path.resolve(workspaceRoot));
  const candidate = path.resolve(root, inputPath);
  await access(candidate);
  const absolutePath = await realpath(candidate);
  const relativePath = path.relative(root, absolutePath);
  const isInside =
    relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

  return {
    inputPath,
    absolutePath,
    relativePath: toPosixPath(relativePath === "" ? "." : relativePath),
    isInside,
  };
}

function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}

const secretBasenames = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
]);

const secretNamePattern =
  /(^|[._-])(secret|secrets|token|tokens|credential|credentials|password|passwd|private[_-]?key|api[_-]?key)([._-]|$)|\.(pem|key|p12|pfx)$/i;

export function isSecretPath(inputPath: string): boolean {
  const basename = path.basename(inputPath).toLowerCase();
  return secretBasenames.has(basename) || secretNamePattern.test(inputPath);
}

export interface CommandClassification {
  decision: PermissionDecisionKind;
  reason: string;
  risk: RiskTag[];
}

const readonlyCommandPatterns = [
  /^git\s+(status|diff|log|show|branch)(\s|$)/i,
  /^node\s+--version$/i,
  /^npm\s+--version$/i,
  /^pnpm\s+--version$/i,
  /^python\s+--version$/i,
  /^rg(\s|$)/i,
  /^ls(\s|$|$)/i,
  /^dir(\s|$)/i,
  /^pwd$/i,
];

const testCommandPatterns = [
  /^(npm|pnpm|yarn)\s+(run\s+)?(test|vitest|typecheck|lint|build)(\s|$)/i,
  /^npx\s+vitest(\s|$)/i,
  /^vitest(\s|$)/i,
  /^pytest(\s|$)/i,
  /^python\s+-m\s+pytest(\s|$)/i,
  /^go\s+test(\s|$)/i,
  /^cargo\s+test(\s|$)/i,
  /^dotnet\s+test(\s|$)/i,
  /^node\s+--test(\s|$)/i,
];

const hardDenyCommandPatterns = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|\*|~|\.{1,2})(\s|$)/i,
  /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+(\/|\*|~|\.{1,2})(\s|$)/i,
  /\bRemove-Item\b.*\b-Recurse\b.*\b-Force\b/i,
  /\brd\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\bgit\s+push\b.*\b--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f[a-z]*d/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bchown\s+-R\b/i,
  /\b(format|diskpart|shutdown|reboot)\b/i,
];

const askCommandPatterns = [
  /^(npm|pnpm|yarn)\s+(install|add|remove|update|upgrade)(\s|$)/i,
  /^pip\s+install(\s|$)/i,
  /^python\s+-m\s+pip\s+install(\s|$)/i,
  /^curl(\s|$)/i,
  /^wget(\s|$)/i,
  /^git\s+push(\s|$)/i,
  /^git\s+commit(\s|$)/i,
  /^docker(\s|$)/i,
];

export function classifyCommand(command: string): CommandClassification {
  const trimmed = command.trim();

  if (hardDenyCommandPatterns.some((pattern) => pattern.test(trimmed))) {
    return {
      decision: "deny",
      reason: "Command matches a hard-deny destructive pattern.",
      risk: ["bulk_delete", "shell_mutating"],
    };
  }

  if (testCommandPatterns.some((pattern) => pattern.test(trimmed))) {
    return {
      decision: "allow",
      reason: "Command is a common test, lint, typecheck, or build command.",
      risk: ["shell_readonly"],
    };
  }

  if (readonlyCommandPatterns.some((pattern) => pattern.test(trimmed))) {
    return {
      decision: "allow",
      reason: "Command is classified as read-only.",
      risk: ["shell_readonly"],
    };
  }

  if (askCommandPatterns.some((pattern) => pattern.test(trimmed))) {
    const installRisk =
      /^(npm|pnpm|yarn)\s+(install|add|remove|update|upgrade)(\s|$)|^pip\s+install(\s|$)|^python\s+-m\s+pip\s+install(\s|$)/i.test(
        trimmed,
      );
    return {
      decision: "ask",
      reason: "Command may install dependencies, access network, or update external state.",
      risk: installRisk
        ? ["shell_mutating", "network_access", "install_dependency"]
        : ["shell_mutating", "network_access"],
    };
  }

  return {
    decision: "ask",
    reason: "Command is not in the Safe YOLO allowlist.",
    risk: ["shell_mutating"],
  };
}

export interface PermissionEngineInput {
  mode: RunMode;
  workspaceRoot: string;
  toolCall: NormalizedToolCall;
}

export class PermissionEngine {
  decide(input: PermissionEngineInput): PermissionDecision {
    const { mode, workspaceRoot, toolCall } = input;
    const toolName = toolCall.name;
    const toolInput = readObject(toolCall.input);

    if (toolName === "todo.write" || toolName === "question.ask") {
      return allow("Planning and user-question tools are always safe.", []);
    }

    if (
      toolName === "skill.list" ||
      toolName === "skill.read" ||
      toolName === "skill.read_resource"
    ) {
      return allow("Skill metadata and resources are local read-only context.", ["read_workspace"]);
    }

    if (toolName === "web.search" || toolName === "web.fetch") {
      if (mode === "plan") {
        return deny("Plan mode does not allow network access.", ["network_access", "web_fetch"]);
      }
      if (mode === "guided") {
        return ask("Guided mode requires approval before web access.", [
          "network_access",
          "web_fetch",
        ]);
      }
      return allow("Public web read access is allowed in this mode.", [
        "network_access",
        "web_fetch",
      ]);
    }

    if (toolName === "mcp.list" || toolName === "mcp.call") {
      if (mode === "full") {
        return allow("Full mode allows configured MCP tools.", [
          "mcp_tool",
          "external_side_effect",
        ]);
      }
      return ask("MCP tools require approval because their side effects depend on the server.", [
        "mcp_tool",
        "external_side_effect",
      ]);
    }

    if (toolName === "search.grep" || toolName === "search.glob") {
      return allow("Search within the workspace is allowed.", ["read_workspace"]);
    }

    if (toolName === "git.status" || toolName === "git.diff") {
      return allow("Read-only git inspection is allowed.", ["shell_readonly"]);
    }

    if (toolName.startsWith("file.")) {
      return this.decideFileTool({ mode, workspaceRoot, toolName, toolInput });
    }

    if (toolName === "shell.run") {
      const command = stringField(toolInput, "command");
      if (!command) {
        return deny("shell.run requires a command.", ["shell_mutating"]);
      }
      const classified = classifyCommand(command);
      if (mode === "plan" && classified.risk.includes("shell_mutating")) {
        return deny("Plan mode does not allow mutating shell commands.", classified.risk);
      }
      if (mode === "guided" && classified.decision === "allow") {
        return allow(classified.reason, classified.risk);
      }
      if (mode === "full" && classified.decision !== "deny") {
        return allow("Full mode allows this non-hard-denied shell command.", classified.risk);
      }
      return decision(classified.decision, classified.reason, classified.risk);
    }

    if (mode === "full") {
      return allow("Full mode allows unknown non-hard-denied tools.", []);
    }

    return ask(`Unknown tool '${toolName}' requires approval.`, []);
  }

  private decideFileTool(input: {
    mode: RunMode;
    workspaceRoot: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): PermissionDecision {
    const target =
      stringField(input.toolInput, "path") ?? stringField(input.toolInput, "dir") ?? ".";
    const resolved = resolveWorkspacePath(input.workspaceRoot, target);
    const isWrite = input.toolName === "file.write" || input.toolName === "file.patch";

    if (isWrite && !resolved.isInside) {
      return deny("Writing outside the workspace is denied.", ["write_external_path"]);
    }

    if (!isWrite && !resolved.isInside) {
      return input.mode === "full"
        ? allow("Full mode allows this external read.", ["read_external_path"])
        : ask("Reading outside the workspace requires approval.", ["read_external_path"]);
    }

    if (!isWrite && isSecretPath(target)) {
      return deny("Reading secret-like files is denied.", ["secret_access"]);
    }

    if (isWrite && input.mode === "plan") {
      return deny("Plan mode does not allow file writes.", ["write_workspace"]);
    }

    if (isWrite && isSecretPath(target) && input.mode !== "full") {
      return ask("Writing secret-like files requires explicit approval.", [
        "write_workspace",
        "secret_access",
      ]);
    }

    if (isWrite && input.mode === "guided") {
      return ask("Guided mode requires approval before file writes.", ["write_workspace"]);
    }

    return allow(
      isWrite
        ? "Workspace file writes are allowed in Safe YOLO."
        : "Workspace file reads are allowed.",
      [isWrite ? "write_workspace" : "read_workspace"],
    );
  }
}

function readObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

function allow(reason: string, risk: RiskTag[]): PermissionDecision {
  return decision("allow", reason, risk);
}

function ask(reason: string, risk: RiskTag[]): PermissionDecision {
  return decision("ask", reason, risk);
}

function deny(reason: string, risk: RiskTag[]): PermissionDecision {
  return decision("deny", reason, risk);
}

function decision(
  kind: PermissionDecisionKind,
  reason: string,
  risk: RiskTag[],
): PermissionDecision {
  return {
    decision: kind,
    reason,
    risk,
    reviewer: "rules",
    canRemember: kind === "ask",
  };
}
