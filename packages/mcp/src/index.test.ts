import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createDefaultToolRegistry } from "@dreamcode/tools";
import { describe, expect, it } from "vitest";
import { McpRuntime, parseMcpServerConfigs, publicToolName } from "./index";

describe("MCP runtime", () => {
  it("parses strict server configs and keeps invalid servers visible", () => {
    const snapshot = parseMcpServerConfigs(
      {
        local: {
          enabled: false,
          transport: "stdio",
          command: "node",
          env: { TOKEN: "$" + "{TOKEN}" },
        },
        insecure: { enabled: true, transport: "streamable-http", url: "http://example.com/mcp" },
      },
      { TOKEN: "resolved" },
    );

    expect(snapshot.items[0]).toMatchObject({ serverId: "local", valid: true, enabled: false });
    expect(snapshot.items[0]?.config).toMatchObject({ env: { TOKEN: "resolved" }, args: [] });
    expect(snapshot.items[1]).toMatchObject({ serverId: "insecure", valid: false, enabled: true });
  });

  it("registers an enabled stdio server as native tools and unregisters it on disable", async () => {
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
    if (message.id === undefined) continue;
    if (message.method === "initialize") respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "1.0.0" }
    });
    if (message.method === "tools/list") respond(message.id, {
      tools: [{ name: "echo", description: "Echo input", inputSchema: {
        type: "object", properties: { text: { type: "string" } }, required: ["text"]
      } }]
    });
    if (message.method === "tools/call") respond(message.id, {
      content: [
        { type: "text", text: "echo:" + message.params.arguments.text },
        { type: "image", mimeType: "image/png", data: Buffer.from("fake-png").toString("base64") }
      ]
    });
    if (message.method === "ping") respond(message.id, {});
  }
});
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`,
      "utf8",
    );

    const registry = createDefaultToolRegistry();
    const runtime = new McpRuntime({ registry });
    try {
      await runtime.reconcile(
        parseMcpServerConfigs({
          fake: {
            enabled: true,
            transport: "stdio",
            command: process.execPath,
            args: [serverPath],
          },
        }),
      );
      try {
        await waitUntil(() => runtime.current().servers[0]?.state === "connected", 12_000);
      } catch {
        throw new Error(`MCP did not connect: ${JSON.stringify(runtime.current())}`);
      }

      expect(registry.get("mcp.list")).toBeUndefined();
      expect(registry.get("mcp.call")).toBeUndefined();
      const tool = registry.get("mcp__fake__echo");
      expect(tool?.source).toEqual({ kind: "mcp", serverId: "fake", rawToolName: "echo" });
      expect(registry.toModelSpecs("plan").map((item) => item.name)).not.toContain(
        "mcp__fake__echo",
      );
      expect(registry.toModelSpecs("yolo").map((item) => item.name)).toContain("mcp__fake__echo");

      const result = await tool!.execute(
        { text: "hello" },
        {
          workspaceRoot,
          sessionDir: workspaceRoot,
          sessionId: "mcp_test",
          mode: "full",
          toolCallId: "call_mcp",
        },
      );
      expect(result.status).toBe("success");
      expect(JSON.stringify(result.data)).toContain("echo:hello");
      expect(result.artifactRefs).toHaveLength(1);

      const beforeDisable = registry.snapshot();
      await runtime.setEnabled("fake", false);
      expect(registry.get("mcp__fake__echo")).toBeUndefined();
      expect(beforeDisable.get("mcp__fake__echo")).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  }, 20_000);

  it("creates deterministic valid names for long or unsafe server tool names", () => {
    const first = publicToolName(
      "server",
      "tool.with spaces/and/a/very/long/name/that/exceeds/the/provider/limit",
    );
    expect(first).toBe(
      publicToolName(
        "server",
        "tool.with spaces/and/a/very/long/name/that/exceeds/the/provider/limit",
      ),
    );
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(64);
  });

  it("connects to and calls a Streamable HTTP server", async () => {
    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const message = JSON.parse(body) as {
          id?: string | number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = {};
        if (message.method === "initialize") {
          result = {
            protocolVersion: String(message.params?.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: "http-fake", version: "1.0.0" },
          };
        } else if (message.method === "tools/list") {
          result = { tools: [{ name: "http_echo", inputSchema: { type: "object" } }] };
        } else if (message.method === "tools/call") {
          result = { content: [{ type: "text", text: "from-http" }] };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind.");

    const registry = createDefaultToolRegistry();
    const runtime = new McpRuntime({ registry });
    try {
      await runtime.reconcile(
        parseMcpServerConfigs({
          remote: {
            enabled: true,
            transport: "streamable-http",
            url: `http://127.0.0.1:${address.port}/mcp`,
          },
        }),
      );
      await waitUntil(() => runtime.current().servers[0]?.state === "connected", 12_000);
      const tool = registry.get("mcp__remote__http_echo");
      const result = await tool!.execute(
        {},
        {
          workspaceRoot: process.cwd(),
          sessionDir: process.cwd(),
          sessionId: "http_test",
          mode: "full",
          toolCallId: "http_call",
        },
      );
      expect(result.status).toBe("success");
      expect(JSON.stringify(result.data)).toContain("from-http");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 20_000);
});

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP runtime state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
