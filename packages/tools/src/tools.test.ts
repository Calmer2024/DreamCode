import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "./index";

describe("builtin tools", () => {
  it("emits OpenAI-compatible object schemas for model tools", () => {
    const specs = createDefaultToolRegistry().toModelSpecs();

    for (const spec of specs) {
      expect(spec.inputSchema.type).toBe("object");
      expect(spec.inputSchema).not.toHaveProperty("$ref");
      expect(spec.inputSchema).not.toHaveProperty("$schema");
      expect(spec.inputSchema).not.toHaveProperty("definitions");
      expect(JSON.stringify(spec.inputSchema)).not.toContain('"$ref"');
    }
  });

  it("patches a workspace file and records a changed file", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-tools-"));
    await writeFile(path.join(workspaceRoot, "example.txt"), "hello old world\n", "utf8");
    const tool = createDefaultToolRegistry().get("file.patch");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { path: "example.txt", search: "old", replace: "new" },
      {
        workspaceRoot,
        sessionDir: workspaceRoot,
        mode: "yolo",
        toolCallId: "call_patch",
      },
    );

    expect(result.status).toBe("success");
    expect(result.changedFiles?.[0]?.path).toBe("example.txt");
    await expect(readFile(path.join(workspaceRoot, "example.txt"), "utf8")).resolves.toContain(
      "new world",
    );
  });

  it("terminates timed-out shell commands", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-shell-"));
    const tool = createDefaultToolRegistry().get("shell.run");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { command: 'node -e "setTimeout(() => {}, 2000)"', timeoutMs: 200 },
      {
        workspaceRoot,
        sessionDir: workspaceRoot,
        mode: "yolo",
        toolCallId: "call_shell",
      },
    );

    expect(result.status).toBe("cancelled");
    expect((result.data as { timedOut?: boolean }).timedOut).toBe(true);
  });
});
