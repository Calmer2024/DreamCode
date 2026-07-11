import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
    expect(result.changedFiles?.[0]?.beforeSnapshotRef).toBeDefined();
    expect(result.changedFiles?.[0]?.patchRef).toBeDefined();
    await expect(readFile(path.join(workspaceRoot, "example.txt"), "utf8")).resolves.toContain(
      "new world",
    );
    await expect(readFile(result.changedFiles![0]!.beforeSnapshotRef!, "utf8")).resolves.toContain(
      "old world",
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

  it("fetches a web page and stores a source artifact", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-web-"));
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<html><title>Fixture Page</title><body><p>Hello web source.</p></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }
    const tool = createDefaultToolRegistry().get("web.fetch");
    expect(tool).toBeDefined();

    try {
      const result = await tool!.execute(
        { url: `http://127.0.0.1:${address.port}/page`, extractMode: "text" },
        {
          workspaceRoot,
          sessionDir: workspaceRoot,
          mode: "full",
          toolCallId: "call_web",
        },
      );
      expect(result.status).toBe("success");
      expect((result.data as { title?: string; summary?: string }).title).toBe("Fixture Page");
      expect((result.data as { summary?: string }).summary).toContain("Hello web source");
      await expect(readFile(result.artifactRefs![0]!, "utf8")).resolves.toContain(
        "Hello web source",
      );
    } finally {
      server.close();
    }
  });

  it("loads skill metadata and reads a skill on demand", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-skills-workspace-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-skills-home-"));
    const skillDir = path.join(home, "skills", "demo");
    await writeFile(path.join(workspaceRoot, "placeholder.txt"), "ok", "utf8");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# Demo Skill\n\nUse this for tests.\n");
    const registry = createDefaultToolRegistry();
    const context = {
      workspaceRoot,
      sessionDir: path.join(home, "sessions", "sess_test"),
      mode: "full" as const,
      toolCallId: "call_skill",
    };

    const list = await registry.get("skill.list")!.execute({}, context);
    expect((list.data as { skills: Array<{ name: string }> }).skills[0]?.name).toBe("demo");
    const read = await registry.get("skill.read")!.execute({ name: "demo" }, context);
    expect((read.data as { content: string }).content).toContain("Demo Skill");
  });

  it("calls a configured fake MCP stdio tool", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-mcp-"));
    const serverPath = path.join(workspaceRoot, "fake-mcp-server.cjs");
    await writeFile(
      serverPath,
      `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.id) continue;
    if (message.method === "initialize") {
      respond(message.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } });
    }
    if (message.method === "tools/list") {
      respond(message.id, { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }] });
    }
    if (message.method === "tools/call") {
      respond(message.id, { content: [{ type: "text", text: "echo:" + message.params.arguments.text }] });
    }
  }
});
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`,
      "utf8",
    );
    const registry = createDefaultToolRegistry({
      mcpServers: { fake: { command: process.execPath, args: [serverPath] } },
    });
    const context = {
      workspaceRoot,
      sessionDir: workspaceRoot,
      mode: "full" as const,
      toolCallId: "call_mcp",
    };

    const list = await registry.get("mcp.list")!.execute({ server: "fake" }, context);
    expect(JSON.stringify(list.data)).toContain("echo");
    const called = await registry
      .get("mcp.call")!
      .execute({ server: "fake", tool: "echo", arguments: { text: "hello" } }, context);
    expect(JSON.stringify(called.data)).toContain("echo:hello");
  });
});
