import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  NormalizedToolCall,
  PermissionDecision,
  RiskTag,
  RunMode,
  SandboxPolicy,
  Tool,
} from "@dreamcode/shared";

export interface ResolvedWorkspacePath {
  inputPath: string;
  absolutePath: string;
  relativePath: string;
  isInside: boolean;
}

export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): ResolvedWorkspacePath {
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, inputPath);
  const relativePath = path.relative(root, absolutePath);
  return {
    inputPath,
    absolutePath,
    relativePath: toPosixPath(relativePath === "" ? "." : relativePath),
    isInside: relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)),
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
  return {
    inputPath,
    absolutePath,
    relativePath: toPosixPath(relativePath === "" ? "." : relativePath),
    isInside: relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)),
  };
}

/** Resolve a write target through its real parent so directory symlinks cannot escape the workspace. */
export async function resolveWritableWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
): Promise<ResolvedWorkspacePath> {
  const root = await realpath(path.resolve(workspaceRoot));
  const lexicalTarget = path.resolve(root, inputPath);
  let existingAncestor = lexicalTarget;
  const missingSegments: string[] = [];
  while (true) {
    try {
      existingAncestor = await realpath(existingAncestor);
      break;
    } catch {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw new Error(`No existing ancestor for '${inputPath}'.`);
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  const absolutePath = path.join(existingAncestor, ...missingSegments);
  const relativePath = path.relative(root, absolutePath);
  return {
    inputPath,
    absolutePath,
    relativePath: toPosixPath(relativePath === "" ? "." : relativePath),
    isInside: relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)),
  };
}

export function buildSandboxPolicy(input: {
  mode: RunMode;
  workspaceRoot: string;
  sessionDir: string;
}): SandboxPolicy {
  return {
    mode: input.mode,
    readableRoots: "all",
    writableRoots:
      input.mode === "danger-full-access"
        ? []
        : input.mode === "workspace-write"
          ? [path.resolve(input.workspaceRoot), sandboxTempRoot(input.sessionDir)]
          : [],
    networkAccess: true,
    enforcement: input.mode === "danger-full-access" ? "disabled" : "managed",
  };
}

export function sandboxTempRoot(sessionDir: string): string {
  return path.join(path.resolve(sessionDir), "sandbox-tmp");
}

function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}

const secretBasenames = new Set([
  ".env", ".env.local", ".env.development", ".env.production", ".npmrc", ".pypirc",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json",
  ".ssh", ".aws", ".azure", ".gnupg", ".kube",
]);
const secretNamePattern =
  /(^|[._-])(secret|secrets|token|tokens|credential|credentials|password|passwd|private[_-]?key|api[_-]?key)([._-]|$)|\.(pem|key|p12|pfx)$/i;

/** Search hygiene only; never an authorization boundary. */
export function isSecretPath(inputPath: string): boolean {
  const components = inputPath.split(/[\\/]+/).map((part) => part.toLowerCase()).filter(Boolean);
  return components.some((part) => secretBasenames.has(part)) || secretNamePattern.test(inputPath);
}

export interface PermissionEngineInput {
  mode: RunMode;
  workspaceRoot: string;
  toolCall: NormalizedToolCall;
  tool?: Tool;
}

/** Authorizes capabilities; it never infers effects from shell source text. */
export class PermissionEngine {
  decide(input: PermissionEngineInput): PermissionDecision {
    const { mode, toolCall, tool } = input;
    const toolName = toolCall.name;
    if (toolName === "todo.write" || toolName === "question.ask" || toolName === "skill") {
      return allow("Runtime-local capability is allowed.", tool?.risk.tags ?? []);
    }
    if (tool?.source?.kind === "mcp" || tool?.risk.tags.includes("mcp_tool")) {
      return mode === "danger-full-access"
        ? allow("Danger-full-access allows configured MCP tools.", ["mcp_tool", "external_side_effect"])
        : ask("MCP tools can cause external side effects and require approval.", ["mcp_tool", "external_side_effect"]);
    }
    if (toolName === "web.search" || toolName === "web.fetch") {
      return allow("Public network reads are allowed.", ["network_access", "web_fetch"]);
    }
    const requestedEscalation = typeof toolCall.input === "object"
      && toolCall.input !== null
      && "sandbox_permissions" in toolCall.input
      && toolCall.input.sandbox_permissions === "require-escalated";
    if ((toolName === "pwsh" || toolName === "bash") && requestedEscalation) {
      return mode === "danger-full-access"
        ? allow("The current mode already has unrestricted process access.", ["shell_mutating"])
        : ask("This process requested execution outside the managed file sandbox.", ["shell_mutating", "write_external_path"]);
    }
    if (toolName.startsWith("file.") && toolName !== "file.read") {
      if (mode === "read-only") {
        return deny("The read-only file sandbox does not permit persistent file writes.", ["write_workspace"]);
      }
      return allow("File writes are constrained by the active file sandbox.", ["write_workspace"]);
    }
    if (tool) return allow("The tool is registered and permitted for this invocation.", tool.risk.tags);
    return mode === "danger-full-access"
      ? allow("Danger-full-access allows this tool.", [])
      : ask(`Unknown tool '${toolName}' requires approval.`, []);
  }
}

function allow(reason: string, risk: RiskTag[]): PermissionDecision { return decision("allow", reason, risk); }
function ask(reason: string, risk: RiskTag[]): PermissionDecision { return decision("ask", reason, risk); }
function deny(reason: string, risk: RiskTag[]): PermissionDecision { return decision("deny", reason, risk); }
function decision(kind: "allow" | "ask" | "deny", reason: string, risk: RiskTag[]): PermissionDecision {
  return { decision: kind, reason, risk, reviewer: "rules", canRemember: kind === "ask" };
}
