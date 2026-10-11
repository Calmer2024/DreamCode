import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@dreamcode/shared";
import type { AgentInstallation, ExternalAgent } from "./agents.js";
import { agentLaunch, publicAgentData } from "./agent-protocol.js";
import { AgentEventNormalizer } from "./agent-events.js";

export async function runExternalContainerAgent(
  config: {
    agent: ExternalAgent;
    model: string;
    prompt: string;
    installation: AgentInstallation;
  },
  request: (type: string, data: unknown) => AsyncIterable<unknown>,
  send: (value: unknown) => void,
) {
  const bridge = createServer(async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 16_000_000) throw Error("Model request exceeds limit");
      }
      for await (const value of request("http", {
        path: req.url,
        body: JSON.parse(body),
        headers: {
          "anthropic-version": req.headers["anthropic-version"],
          "anthropic-beta": req.headers["anthropic-beta"],
        },
      })) {
        const data = value as { status?: number; contentType?: string; chunk?: string };
        if (data.status)
          res.writeHead(data.status, { "content-type": data.contentType ?? "application/json" });
        if (data.chunk) res.write(Buffer.from(data.chunk, "base64"));
      }
      res.end();
    } catch (error) {
      if (res.headersSent) res.destroy(error instanceof Error ? error : Error(String(error)));
      else {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error), type: "bridge_error" } }));
      }
    }
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address() as { port: number };
  const launch = agentLaunch(
    config.agent,
    config.model,
    config.prompt,
    `http://127.0.0.1:${address.port}`,
  );
  for (const [file, value] of Object.entries(launch.files)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
  const entry = config.installation.agents[config.agent];
  const events = new AgentEventNormalizer(config.agent, (event: AgentEvent) =>
    send({ type: "event", data: event }),
  );
  let stderr = "",
    bytes = 0;
  try {
    const child = spawn(entry.command[0]!, [...entry.command.slice(1), ...launch.args], {
      cwd: "/workspace",
      env: {
        ...process.env,
        ...launch.env,
        XDG_CONFIG_HOME: "/home/agent/config",
        XDG_DATA_HOME: "/home/agent/data",
        XDG_CACHE_HOME: "/home/agent/cache",
        NODE_PATH: "/opt/harness/node_modules",
        PATH: `/opt/harness/node_modules/.bin:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let protocolError: Error | undefined;
    input.on("line", (line) => {
      bytes += Buffer.byteLength(line);
      if (bytes > 64_000_000) {
        protocolError = Error("Framework event stream exceeds limit");
        child.kill("SIGTERM");
        return;
      }
      if (!line.trim()) return;
      try {
        const record = JSON.parse(line);
        const observedAt = new Date().toISOString();
        const data = publicAgentData(record);
        if (data !== undefined) send({ type: "external", data: { observedAt, record: data } });
        events.consume(record, observedAt);
      } catch (error) {
        protocolError = Error(`Invalid ${config.agent} JSON event: ${String(error)}`);
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-32000);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (protocolError) throw protocolError;
    if (code !== 0) throw Error(`Framework exited (${code}): ${stderr}`);
    events.verify();
  } finally {
    bridge.closeAllConnections();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
  }
}
