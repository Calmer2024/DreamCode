import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { runTurn } from "@dreamcode/core";
import { createDefaultToolRegistry } from "@dreamcode/tools";
import type { ModelEvent, ModelProvider, ToolExecutionContext } from "@dreamcode/shared";
import { runExternalContainerAgent } from "./external-worker.js";
import type { AgentInstallation, ExternalAgent } from "./agents.js";

// JSONL on stdio is the only host bridge. Model credentials never enter this process.
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const waiting = new Map<string, { queue: Record<string, unknown>[]; wake?: () => void }>();
let initialize!: (value: WorkerInput) => void;
const initial = new Promise<WorkerInput>((resolve) => {
  initialize = resolve;
});
let initialized = false,
  sequence = 0;
interface WorkerInput {
  agent?: ExternalAgent;
  installation?: AgentInstallation;
  prompt: string;
  model: string;
  provider: string;
  environment: {
    browser?: { playwrightVersion: string };
    pythonMinVersion?: string;
    pythonMajorMinor?: string;
    pythonPackages?: Record<string, string>;
    pythonVendoredPackages?: Record<string, string>;
    pythonSmokeImports?: string[];
    toolchains?: Record<string, number>;
  };
}
input.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (!initialized) {
      initialized = true;
      initialize(message);
      return;
    }
    const pending = waiting.get(message.id);
    if (!pending) throw Error("Unknown host response");
    pending.queue.push(message);
    pending.wake?.();
    pending.wake = undefined;
  } catch (error) {
    send({ type: "fatal", error: String(error) });
    process.exitCode = 1;
    input.close();
  }
});
input.on("close", () => {
  if (!initialized) process.exit(1);
});
async function* request(type: string, data: unknown) {
  const id = String(++sequence),
    pending = {
      queue: [] as Record<string, unknown>[],
      wake: undefined as (() => void) | undefined,
    };
  waiting.set(id, pending);
  send({ type, id, data });
  try {
    while (true) {
      if (!pending.queue.length)
        await new Promise<void>((resolve) => {
          pending.wake = resolve;
        });
      const message = pending.queue.shift()!;
      if (message.type === "error") throw Error(String(message.error));
      if (message.type === "end") return;
      yield message.data;
    }
  } finally {
    waiting.delete(id);
  }
}
function command(program: string, args: string[]) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw Error(`Runtime ${program} unavailable: ${result.error ?? result.stderr}`);
  return result.stdout + result.stderr;
}
async function preflight(environment: WorkerInput["environment"]) {
  for (const name of ["search.glob", "search.grep"]) {
    const result = await registry.get(name)!.execute(
      { pattern: name === "search.glob" ? "**/*" : "__dreamcode_preflight_no_match__" },
      {
        workspaceRoot: "/workspace",
        sessionDir: "/home/agent/preflight",
        mode: "workspace-write",
        toolCallId: `container_preflight_${name}`,
      },
    );
    if (result.status !== "success")
      throw Error(`Search runtime preflight failed: ${JSON.stringify(result)}`);
  }
  command(process.execPath, ["-e", "console.log(42)"]);
  command("git", ["--version"]);
  for (const [program, minimum] of Object.entries(environment.toolchains ?? {})) {
    const output = command(program, [program === "javac" ? "-version" : "--version"]);
    const version = output.match(/(?:rustc|javac|openjdk|java)\s+(?:version\s+)?"?(\d+)/);
    if (!version || Number(version[1]) < minimum) throw Error(`Incompatible ${program}: ${output}`);
  }
  if (environment.pythonMinVersion) {
    const script = [
      "import sys,importlib,importlib.metadata as m",
      "assert sys.version_info >= (3,9)",
      ...(environment.pythonMajorMinor
        ? [
            `assert '.'.join(map(str,sys.version_info[:2])) == ${JSON.stringify(environment.pythonMajorMinor)}`,
          ]
        : []),
      ...Object.entries({
        ...environment.pythonPackages,
        ...environment.pythonVendoredPackages,
      }).map(
        ([name, version]) =>
          `assert m.version(${JSON.stringify(name)}) == ${JSON.stringify(version)}`,
      ),
      ...(environment.pythonSmokeImports ?? []).map(
        (name) => `importlib.import_module(${JSON.stringify(name)})`,
      ),
    ];
    command("python", ["-B", "-c", script.join("\n")]);
  }
  if (environment.browser) {
    const require = createRequire(import.meta.url);
    const sdk = require("/opt/eval/node_modules/@playwright/test/package.json");
    if (sdk.version !== environment.browser.playwrightVersion)
      throw Error("Playwright pin mismatch");
    const { chromium } = require("/runtime/playwright.cjs");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  }
  // Exercise the actual managed tool path, including nested child pipes and file denial.
  const result = await registry.get("bash")!.execute(
    {
      description: "Verify container pipes and read-only runtime boundary",
      command:
        'node -e \'const fs=require("node:fs"); const r=require("node:child_process").spawnSync(process.execPath,["-e","console.log(42)"],{encoding:"utf8"});if(r.status!==0||r.stdout.trim()!=="42")process.exit(1);let denied=false;try{fs.writeFileSync("/runtime/outside.txt","escape")}catch{denied=true}if(!denied)process.exit(2);console.log("container managed runtime available")\'',
      timeoutMs: 20000,
    },
    {
      workspaceRoot: "/workspace",
      sessionDir: "/home/agent/preflight",
      mode: "workspace-write",
      toolCallId: "container_preflight",
    },
  );
  if (result.status !== "success")
    throw Error(`Managed runtime preflight failed: ${JSON.stringify(result)}`);
  const temporaryFiles = await registry.get("bash")!.execute(
    {
      description: "Verify POSIX temporary-file semantics through the managed tool",
      command:
        'python -c \'import tempfile; f=tempfile.TemporaryFile(); f.write(b"data"); f.truncate(); f.seek(0); assert f.read()==b"data"; print("POSIX_TEMP_OK")\'',
      timeoutMs: 10000,
    },
    {
      workspaceRoot: "/workspace",
      sessionDir: "/home/agent/preflight",
      mode: "workspace-write",
      toolCallId: "container_preflight_temp",
    },
  );
  if (
    temporaryFiles.status !== "success" ||
    !JSON.stringify(temporaryFiles.data).includes("POSIX_TEMP_OK")
  )
    throw Error(`Managed temporary-file preflight failed: ${JSON.stringify(temporaryFiles)}`);
}
const registry = createDefaultToolRegistry();
registry.replaceNamespace(
  "dreamcode:builtins",
  registry.list().map((tool) => ({
    ...tool,
    execute: (value: unknown, context: ToolExecutionContext) =>
      tool.execute(value, {
        ...context,
        sandboxPolicy: {
          mode: context.mode,
          readableRoots: "all",
          // POSIX anonymous temporary files must live on container tmpfs.
          // Windows-backed bind mounts break pytest capture's open/unlink/truncate.
          writableRoots: ["/workspace", "/tmp/dreameval-tool-tmp"],
          networkAccess: true,
          enforcement: "container",
        },
      }),
  })),
);
try {
  const policy = JSON.parse(await readFile("/runtime/container-policy.json", "utf8"));
  if (policy.backend !== "docker-agent" || process.platform !== "linux")
    throw Error("Missing container boundary");
  const config = await initial;
  await mkdir("/home/agent/preflight", { recursive: true });
  await preflight(config.environment);
  send({
    type: "ready",
    data: {
      node: process.version,
      platform: process.platform,
      agent: config.agent ?? "dreamcode",
      ...(config.installation
        ? {
            agentVersion: config.installation.agents[config.agent!].version,
            agentImage: config.installation.image,
            agentLockDigest: config.installation.lockDigest,
          }
        : {}),
    },
  });
  if (config.agent) {
    if (!config.installation) throw Error("External framework installation is missing");
    await runExternalContainerAgent(
      { ...config, agent: config.agent, installation: config.installation },
      request,
      send,
    );
    send({ type: "done" });
  } else {
    const provider: ModelProvider = {
      name: config.provider,
      async *stream(value) {
        for await (const event of request("model", value)) yield event as ModelEvent;
      },
    };
    for await (const event of runTurn({
      prompt: config.prompt,
      workspaceRoot: "/workspace",
      home: "/home/agent",
      mode: "workspace-write",
      model: config.model,
      provider,
      registry,
      questionHandler: async (question) => {
        let answer = "";
        for await (const value of request("question", question)) answer = String(value);
        return answer;
      },
    }))
      send({ type: "event", data: event });
    send({ type: "done" });
  }
} catch (error) {
  send({ type: "fatal", error: String(error) });
  process.exitCode = 1;
} finally {
  await registry.processSupervisor.dispose();
  input.close();
  process.stdin.destroy();
}
