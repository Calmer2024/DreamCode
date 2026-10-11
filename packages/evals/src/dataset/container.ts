import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, ModelProvider, ModelStreamInput } from "@dreamcode/shared";
import type { AgentInstallation, ExternalAgent } from "./agents.js";
import type { BridgeRequest, BridgeResponse } from "./model-bridge.js";
const exec = promisify(execFile);
export function dockerAgentArguments(
  image: string,
  workspace: string,
  home: string,
  runtime: string,
  name: string,
  readOnlyWorkspace = false,
  harnessVolume?: string,
) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw Error("Agent image must be pinned by local sha256 ID");
  const mounts = [workspace, home, runtime].map((value) => path.resolve(value));
  if (mounts.some((value) => value.includes(",") || /[\r\n]/.test(value)))
    throw Error("Unsupported container bind path");
  if (harnessVolume && !/^dreameval-harness-[a-f0-9]{16,64}$/.test(harnessVolume))
    throw Error("Invalid harness volume");
  return [
    "run",
    "--name",
    name,
    "--rm",
    "--pull=never",
    "--interactive",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=2g",
    "--cpus=2",
    "--user=10001:10001",
    "--shm-size=256m",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777",
    "--workdir=/workspace",
    "--mount",
    `type=bind,src=${mounts[0]},dst=/workspace${readOnlyWorkspace ? ",readonly" : ""}`,
    "--mount",
    `type=bind,src=${mounts[1]},dst=/home/agent`,
    "--mount",
    `type=bind,src=${mounts[2]},dst=/runtime,readonly`,
    ...(harnessVolume
      ? ["--mount", `type=volume,src=${harnessVolume},dst=/opt/harness,readonly,volume-nocopy`]
      : []),
    "--env=HOME=/home/agent",
    "--env=TMPDIR=/tmp",
    "--env=TMP=/tmp",
    "--env=TEMP=/tmp",
    "--env=DREAMCODE_CONTAINER_SANDBOX=1",
    "--env=PYTHONDONTWRITEBYTECODE=1",
    "--env=PYTHONPATH=/workspace/src:/workspace/vendor:/workspace",
    "--env=GIT_CONFIG_COUNT=1",
    "--env=GIT_CONFIG_KEY_0=safe.directory",
    "--env=GIT_CONFIG_VALUE_0=/workspace",
    "--env=JAVA_TOOL_OPTIONS=-Xmx256m",
    image,
    "node",
    "/runtime/worker.mjs",
  ];
}
export async function runContainerTurn(options: {
  execution: { backend: "docker"; image: string; worker: string };
  workspace: string;
  readOnlyWorkspace?: boolean;
  home: string;
  runtimeDir: string;
  prompt: string;
  environment: unknown;
  model: string;
  provider: ModelProvider;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onReady: (runtime: Record<string, unknown>) => void;
  questionHandler: (question: string) => Promise<string>;
  external?: { agent: ExternalAgent; installation: AgentInstallation };
  onHttp?: (input: BridgeRequest, signal?: AbortSignal) => AsyncIterable<BridgeResponse>;
  onExternal?: (data: unknown) => void;
}) {
  const { execution } = options;
  const inspection = JSON.parse(
    (
      await exec("docker", ["image", "inspect", execution.image], {
        timeout: 10000,
        maxBuffer: 1_000_000,
      })
    ).stdout,
  )[0];
  if (inspection.Os !== "linux" || inspection.Id !== execution.image)
    throw Error("Container image missing or incompatible");
  await mkdir(options.runtimeDir, { recursive: true });
  const bytes = await readFile(execution.worker),
    workerSha256 = createHash("sha256").update(bytes).digest("hex");
  await copyFile(execution.worker, path.join(options.runtimeDir, "worker.mjs"));
  if (options.external?.agent === "dsh")
    await copyFile(
      path.join(path.dirname(execution.worker), "dsh-driver.mjs"),
      path.join(options.runtimeDir, "dsh-driver.mjs"),
    );
  await writeFile(
    path.join(options.runtimeDir, "container-policy.json"),
    JSON.stringify({ backend: "docker-agent", workerSha256 }),
  );
  await writeFile(
    path.join(options.runtimeDir, "playwright.cjs"),
    `const sdk=require('/opt/eval/node_modules/@playwright/test'); const launch=sdk.chromium.launch.bind(sdk.chromium);sdk.chromium.launch=(options={})=>launch({...options,executablePath:'/usr/bin/chromium',args:['--no-sandbox',...(options.args||[])]});module.exports=sdk;\n`,
  );
  const name = `dreamcode-eval-${randomUUID()}`;
  const child = spawn(
    "docker",
    dockerAgentArguments(
      execution.image,
      options.workspace,
      options.home,
      options.runtimeDir,
      name,
      options.readOnlyWorkspace,
      options.external?.installation.volume,
    ),
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const runtimeAbort = new AbortController();
  const pendingHttp = new Set<Promise<void>>();
  const signal = AbortSignal.any([options.signal, runtimeAbort.signal]);
  let buffer = "",
    stderr = "",
    ready = false,
    done = false,
    active = false,
    ended = false;
  let terminalFailure: Error | undefined;
  const reply = (message: unknown) => {
    if (!ended && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const abort = () => {
    runtimeAbort.abort(Error("Container execution stopped"));
    child.kill();
    void exec("docker", ["rm", "--force", name], { timeout: 10000 }).catch(() => undefined);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        if (ended) return;
        ended = true;
        abort();
        reject(error instanceof Error ? error : Error(String(error)));
      };
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stderr.on("data", (data) => {
        stderr = (stderr + String(data)).slice(-32000);
      });
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
          fail(Error("Container protocol exceeds limit"));
          return;
        }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.type === "ready") {
              if (ready) throw Error("Duplicate container readiness");
              ready = true;
              options.onReady({
                ...message.data,
                backend: "docker",
                platform: "linux",
                image: execution.image,
                workerSha256,
                readOnlyWorkspace: options.readOnlyWorkspace ?? false,
              });
            } else if (message.type === "event") {
              if (!ready) throw Error("Event before preflight");
              options.onEvent(message.data);
              if (["turn.failed", "turn.interrupted"].includes(message.data?.type))
                terminalFailure = Error(
                  `Agent ${message.data.type}: ${message.data.payload?.error ?? message.data.payload?.reason ?? "Unexpected terminal failure"}`,
                );
            } else if (message.type === "external") {
              if (!ready || !options.external) throw Error("Unexpected external Agent event");
              options.onExternal?.(message.data);
            } else if (message.type === "http") {
              if (!ready || !options.onHttp || typeof message.id !== "string" || signal.aborted)
                throw Error("Unexpected model HTTP request");
              const pending = (async () => {
                try {
                  for await (const value of options.onHttp!(message.data, signal))
                    reply({ type: "data", id: message.id, data: value });
                  reply({ type: "end", id: message.id });
                } catch (error) {
                  reply({ type: "error", id: message.id, error: String(error) });
                  if (String(error).includes("Model request budget exhausted")) fail(error);
                }
              })();
              pendingHttp.add(pending);
              void pending.finally(() => pendingHttp.delete(pending));
            } else if (message.type === "done") {
              done = true;
            } else if (message.type === "fatal") {
              fail(Error(`Container ${ready ? "Agent" : "preflight"} error: ${message.error}`));
            } else if (message.type === "model") {
              if (!ready || active || typeof message.id !== "string" || signal.aborted)
                throw Error("Invalid model request ordering");
              active = true;
              void (async () => {
                try {
                  const data = message.data as ModelStreamInput;
                  if (!Array.isArray(data.messages) || !Array.isArray(data.tools))
                    throw Error("Invalid model input");
                  for await (const event of options.provider.stream({
                    ...data,
                    model: options.model,
                    workspaceRoot: options.workspace,
                    mode: "workspace-write",
                    signal,
                  }))
                    reply({ type: "data", id: message.id, data: event });
                  reply({ type: "end", id: message.id });
                } catch (error) {
                  reply({ type: "error", id: message.id, error: String(error) });
                } finally {
                  active = false;
                }
              })();
            } else if (message.type === "question") {
              if (!ready || typeof message.data !== "string")
                throw Error("Invalid clarification request");
              void options
                .questionHandler(message.data)
                .then((answer) => {
                  reply({ type: "data", id: message.id, data: answer });
                  reply({ type: "end", id: message.id });
                })
                .catch(fail);
            } else throw Error(`Unknown container protocol message: ${message.type}`);
          } catch (error) {
            fail(error);
            return;
          }
        }
      });
      child.on("close", (code) => {
        if (ended) return;
        ended = true;
        if (options.signal.aborted) reject(options.signal.reason);
        else if (terminalFailure) reject(terminalFailure);
        else if (code !== 0 || !ready || !done || buffer.trim())
          reject(Error(`Container exited unexpectedly (${code}): ${stderr}`));
        else resolve();
      });
      if (options.signal.aborted) {
        fail(options.signal.reason);
        return;
      }
      reply({
        prompt: options.prompt,
        provider: options.provider.name,
        model: options.model,
        environment: options.environment,
        ...(options.external ?? {}),
      });
    });
  } finally {
    ended = true;
    options.signal.removeEventListener("abort", abort);
    child.stdin.destroy();
    runtimeAbort.abort(Error("Container execution complete"));
    await Promise.allSettled(pendingHttp);
    await exec("docker", ["rm", "--force", name], { timeout: 10000 }).catch(() => undefined);
  }
}
