import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RiskTag, Tool } from "@dreamcode/shared";
import { buildSandboxPolicy, PermissionEngine, resolveWorkspacePath } from "./index";

const workspaceRoot = path.resolve("D:/repo");
const tool = (name: string, risk: RiskTag[] = []): Tool => ({
  name,
  description: name,
  inputSchema: {},
  risk: { tags: risk },
  execute: async () => ({ toolCallId: "call", status: "success" as const, summary: "ok" }),
});
const decide = (mode: "read-only" | "workspace-write" | "danger-full-access", name: string, input: unknown = {}) =>
  new PermissionEngine().decide({
    mode,
    workspaceRoot,
    toolCall: { id: "call", name, input },
    tool: tool(name, name === "pwsh" ? ["shell_mutating"] : []),
  });

describe("sandbox policy", () => {
  it("allows reads at any local path in every mode", () => {
    for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
      expect(decide(mode, "file.read", { file_path: "C:/outside.txt" }).decision).toBe("allow");
    }
  });

  it("compiles the three filesystem policies", () => {
    const readOnly = buildSandboxPolicy({ mode: "read-only", workspaceRoot, sessionDir: "D:/session" });
    const workspace = buildSandboxPolicy({ mode: "workspace-write", workspaceRoot, sessionDir: "D:/session" });
    const full = buildSandboxPolicy({ mode: "danger-full-access", workspaceRoot, sessionDir: "D:/session" });
    expect(readOnly).toMatchObject({ readableRoots: "all", writableRoots: [], networkAccess: true, enforcement: "managed" });
    expect(workspace.writableRoots[0]).toBe(workspaceRoot);
    expect(workspace.enforcement).toBe("managed");
    expect(full.enforcement).toBe("disabled");
  });

  it("does not inspect shell source", () => {
    for (const command of ["rm -rf /", "Format-Table", "a; b | c && d", "pwsh -EncodedCommand AAA="]) {
      expect(decide("workspace-write", "pwsh", { command }).decision).toBe("allow");
    }
  });

  it("asks only when a sandboxed process explicitly requests elevation", () => {
    expect(decide("workspace-write", "pwsh", { command: "anything", sandbox_permissions: "require-escalated" }).decision).toBe("ask");
    expect(decide("danger-full-access", "pwsh", { command: "anything", sandbox_permissions: "require-escalated" }).decision).toBe("allow");
  });

  it("blocks structured writes in read-only and allows them in writable modes", () => {
    expect(decide("read-only", "file.write").decision).toBe("deny");
    expect(decide("workspace-write", "file.write").decision).toBe("allow");
    expect(decide("danger-full-access", "file.write").decision).toBe("allow");
  });

  it("keeps remote MCP approval separate from the file sandbox", () => {
    const mcp: Tool = { ...tool("mcp__server__write", ["mcp_tool"]), source: { kind: "mcp", serverId: "server", rawToolName: "write" } };
    const engine = new PermissionEngine();
    expect(engine.decide({ mode: "workspace-write", workspaceRoot, toolCall: { id: "c", name: mcp.name, input: {} }, tool: mcp }).decision).toBe("ask");
    expect(engine.decide({ mode: "danger-full-access", workspaceRoot, toolCall: { id: "c", name: mcp.name, input: {} }, tool: mcp }).decision).toBe("allow");
  });
});

describe("path resolution", () => {
  it("recognizes paths outside the workspace without denying reads", () => {
    expect(resolveWorkspacePath(workspaceRoot, "../outside.txt").isInside).toBe(false);
  });
});
