import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, validateShellCommand } from "./index";

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

  it("reports runtime facts and runs a structured process without a shell", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-process-"));
    const registry = createDefaultToolRegistry();
    const runtime = await registry.get("runtime.info")!.execute(
      {},
      { workspaceRoot, sessionDir: workspaceRoot, mode: "yolo", toolCallId: "runtime" },
    );
    expect(runtime.status).toBe("success");
    expect((runtime.data as { execution?: { stateless?: boolean } }).execution?.stateless).toBe(true);

    const result = await registry.get("process.run")!.execute(
      {
        program: process.execPath,
        args: ["-e", "process.stdout.write(process.env.DREAMCODE_PROCESS_TEST || '')"],
        env: { DREAMCODE_PROCESS_TEST: "structured" },
      },
      { workspaceRoot, sessionDir: workspaceRoot, mode: "yolo", toolCallId: "process" },
    );
    expect(result.status).toBe("success");
    expect(result.execution).toMatchObject({ outcome: "exited_zero", started: true, exitCode: 0 });
    expect(result.streams?.stdout.preview).toBe("structured");
  });

  it("returns structured process failures and bounded output previews", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-output-"));
    const tool = createDefaultToolRegistry().get("process.run")!;
    const failed = await tool.execute(
      { program: process.execPath, args: ["-e", "process.exit(7)"] },
      { workspaceRoot, sessionDir: workspaceRoot, mode: "yolo", toolCallId: "failed" },
    );
    expect(failed.status).toBe("error");
    expect(failed.error).toMatchObject({
      category: "execution",
      reason: "nonzero_exit",
      retryable: false,
    });

    const large = await tool.execute(
      { program: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(9000))"] },
      { workspaceRoot, sessionDir: workspaceRoot, mode: "yolo", toolCallId: "large" },
    );
    expect(Buffer.byteLength(large.streams!.stdout.preview)).toBeLessThanOrEqual(4096);
    expect(large.streams?.stdout).toMatchObject({ bytes: 9000, truncated: true });
    expect(large.streams?.stdout.artifactRef).toMatch(/^artifact:\/\//);
  });

  it("rejects multi-step and stateful shell expressions but permits pipelines", () => {
    expect(validateShellCommand("git status | findstr main", "cmd")).toEqual([]);
    expect(validateShellCommand("git status && git diff", "cmd")[0]?.code).toBe(
      "multiple_shell_steps",
    );
    expect(validateShellCommand("cd packages", "powershell")[0]?.code).toBe(
      "stateful_shell_construct",
    );
    expect(validateShellCommand('node -e "console.log(\'a;b\')"', "bash")).toEqual([]);
  });

  it("reads a bounded range from a session artifact reference", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-artifact-"));
    const sessionDir = path.join(workspaceRoot, "session");
    await mkdir(path.join(sessionDir, "artifacts"), { recursive: true });
    await writeFile(path.join(sessionDir, "artifacts", "large.txt"), "0123456789", "utf8");
    const tool = createDefaultToolRegistry().get("artifact.read");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { ref: "artifact://large.txt", offset: 3, maxBytes: 4 },
      {
        workspaceRoot,
        sessionDir,
        mode: "yolo",
        toolCallId: "call_artifact",
      },
    );

    expect(result.status).toBe("success");
    expect((result.data as { content?: string }).content).toBe("3456");
    expect((result.data as { nextOffset?: number }).nextOffset).toBe(7);
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

  it("searches the web through Exa and normalizes source candidates", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-exa-"));
    let received: { method?: string; apiKey?: string; body?: unknown } = {};
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = {
        method: request.method,
        apiKey: request.headers["x-api-key"] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: [
            {
              title: "Exa result",
              url: "https://example.com/result",
              highlights: ["Useful highlighted passage."],
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start Exa fixture.");
    const tool = createDefaultToolRegistry({
      webSearch: { exaApiKey: "exa-test-key", exaBaseUrl: `http://127.0.0.1:${address.port}` },
    }).get("web.search");

    try {
      const result = await tool!.execute(
        { query: "coding agents", maxResults: 3, domains: ["example.com"] },
        { workspaceRoot, sessionDir: workspaceRoot, mode: "full", toolCallId: "call_exa" },
      );
      expect(result.status).toBe("success");
      expect(received).toMatchObject({
        method: "POST",
        apiKey: "exa-test-key",
        body: {
          query: "coding agents",
          numResults: 3,
          type: "fast",
          includeDomains: ["example.com"],
        },
      });
      expect(result.data).toMatchObject({
        results: [
          {
            title: "Exa result",
            url: "https://example.com/result",
            snippet: "Useful highlighted passage.",
            source: "exa",
          },
        ],
      });
    } finally {
      server.close();
    }
  });

  it("returns an actionable error when the Exa API key is missing", async () => {
    const tool = createDefaultToolRegistry({ webSearch: { exaApiKey: "" } }).get("web.search");
    const result = await tool!.execute(
      { query: "coding agents" },
      {
        workspaceRoot: process.cwd(),
        sessionDir: process.cwd(),
        mode: "full",
        toolCallId: "call_exa_missing",
      },
    );
    expect(result).toMatchObject({
      status: "error",
      error: { code: "exa_api_key_missing" },
    });
    expect(result.summary).toContain("EXA_API_KEY");
  });

  it("loads Skill instructions and resources through the turn-scoped Registry", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-skills-workspace-"));
    await writeFile(path.join(workspaceRoot, "placeholder.txt"), "ok", "utf8");
    const registry = createDefaultToolRegistry();
    const context = {
      workspaceRoot,
      sessionDir: workspaceRoot,
      mode: "full" as const,
      toolCallId: "call_skill",
      skills: {
        generation: 1,
        catalog: [],
        load: async (skillId: string) => ({
          skillId,
          name: "demo",
          path: path.join(workspaceRoot, "SKILL.md"),
          content: "<skill_content>Demo Skill</skill_content>",
          contentHash: "abc",
          cacheHit: false,
        }),
        readResource: async (skillId: string, resourcePath: string) => ({
          skillId,
          resourcePath,
          content: "Resource text",
          truncated: false,
        }),
      },
    };

    const loaded = await registry.get("skill.load")!.execute({ skillId: "skill_demo" }, context);
    expect((loaded.data as { content: string }).content).toContain("Demo Skill");
    const resource = await registry
      .get("skill.read_resource")!
      .execute({ skillId: "skill_demo", resourcePath: "guide.md" }, context);
    expect((resource.data as { content: string }).content).toBe("Resource text");
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
