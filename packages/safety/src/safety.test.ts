import { describe, expect, it } from "vitest";
import { classifyCommand, PermissionEngine, resolveWorkspacePath } from "./index";

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
});
