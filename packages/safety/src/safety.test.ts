import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPermissionCapabilityContract,
  classifyCommand,
  PermissionEngine,
  resolveWorkspacePath,
} from "./index";

describe("workspace path boundary", () => {
  it("marks paths inside and outside the workspace", () => {
    const inside = resolveWorkspacePath("/repo/project", "src/index.ts");
    const outside = resolveWorkspacePath("/repo/project", "../secret.txt");

    expect(inside.isInside).toBe(true);
    expect(outside.isInside).toBe(false);
  });
});

describe("command classifier", () => {
  it("allows common test commands", () => {
    expect(classifyCommand("npm test").decision).toBe("allow");
    expect(classifyCommand("node --test").decision).toBe("allow");
  });

  it("asks for installs and denies destructive deletes", () => {
    expect(classifyCommand("pnpm add left-pad").decision).toBe("ask");
    expect(classifyCommand("rm -rf .").decision).toBe("deny");
  });
});

describe("permission engine", () => {
  const engine = new PermissionEngine();

  it("allows workspace writes in Safe YOLO", () => {
    const decision = engine.decide({
      mode: "yolo",
      workspaceRoot: "/repo/project",
      toolCall: {
        id: "call_1",
        name: "file.patch",
        input: { path: "src/index.ts", search: "a", replace: "b" },
      },
    });
    expect(decision.decision).toBe("allow");
  });

  it("classifies phase 2 web and mcp tools", () => {
    const web = engine.decide({
      mode: "yolo",
      workspaceRoot: "/repo/project",
      toolCall: {
        id: "call_web",
        name: "web.fetch",
        input: { url: "https://example.com" },
      },
    });
    const mcp = engine.decide({
      mode: "yolo",
      workspaceRoot: "/repo/project",
      toolCall: {
        id: "call_mcp",
        name: "mcp.call",
        input: { server: "fake", tool: "echo" },
      },
    });

    expect(web.decision).toBe("allow");
    expect(mcp.decision).toBe("ask");
  });

  it("denies workspace external writes and secret reads", () => {
    const externalWrite = engine.decide({
      mode: "yolo",
      workspaceRoot: "/repo/project",
      toolCall: {
        id: "call_2",
        name: "file.write",
        input: { path: "../outside.txt", content: "nope" },
      },
    });
    const secretRead = engine.decide({
      mode: "yolo",
      workspaceRoot: "/repo/project",
      toolCall: {
        id: "call_3",
        name: "file.read",
        input: { path: ".env" },
      },
    });

    expect(externalWrite.decision).toBe("deny");
    expect(secretRead.decision).toBe("deny");
  });

  it("classifies process.run and routes external cwd through the current mode", () => {
    const workspaceRoot = process.cwd();
    const externalCwd = path.resolve(workspaceRoot, "..");
    const guided = engine.decide({
      mode: "guided",
      workspaceRoot,
      toolCall: {
        id: "process_guided",
        name: "process.run",
        input: { program: "npm", args: ["test"], cwd: externalCwd },
      },
    });
    const full = engine.decide({
      mode: "full",
      workspaceRoot,
      toolCall: {
        id: "process_full",
        name: "process.run",
        input: { program: "npm", args: ["test"], cwd: externalCwd },
      },
    });
    expect(guided.decision).toBe("ask");
    expect(full.decision).toBe("allow");
    expect(full.risk).toContain("read_external_path");
  });
});

describe("permission capability contract", () => {
  it("exposes all four modes and highlights the current mode", () => {
    const contract = buildPermissionCapabilityContract("guided", "win32");
    expect(Object.keys(contract.modes).sort()).toEqual(["full", "guided", "plan", "yolo"]);
    expect(contract.generatedFor).toEqual({ platform: "win32", currentMode: "guided" });
    expect(contract.currentModeSummary).toBe(contract.modes.guided);
    expect(contract.modes.plan.deny.map((item) => item.id)).toContain("workspace_write");
    expect(contract.modes.yolo.allow.map((item) => item.id)).toContain("workspace_write");
    expect(contract.modes.full.deny.map((item) => item.id)).toContain("destructive");
  });
});
