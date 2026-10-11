import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { resolveInside } from "./loader.js";
import { validateChecks } from "./scoring.js";
import { judgeAcceptance } from "./judge.js";
import type { ModelProvider } from "@dreamcode/shared";
import type { AcceptanceResult, Evidence, LoadedCase } from "./types.js";
const exec = promisify(execFile);
export async function runProgram(
  entry: LoadedCase,
  workspace: string,
): Promise<{ result: AcceptanceResult; stdout: string; stderr: string }> {
  if (!entry.acceptance.program) throw Error("Program not configured");
  const script = await resolveInside(entry.root, entry.acceptance.program.file);
  if (script.includes(",") || workspace.includes(",")) throw Error("Unsupported mount path");
  const name = `dreameval-acceptance-${randomUUID()}`;
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=2g",
    "--cpus=2",
    "--user=10001:10001",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777",
    "--workdir=/workspace",
    "--mount",
    `type=bind,src=${path.resolve(workspace)},dst=/workspace,readonly`,
    "--mount",
    `type=bind,src=${script},dst=/grader/check.py,readonly`,
    "--env=PYTHONDONTWRITEBYTECODE=1",
    "--env=HOME=/tmp",
    "--env=npm_config_cache=/tmp/npm-cache",
    "--env=GOCACHE=/tmp/go-build",
    "--env=PYTHONPATH=/workspace/vendor:/workspace/src:/workspace",
    entry.runtime.image,
    "python",
    "-B",
    "/grader/check.py",
  ];
  let stdout = "",
    stderr = "",
    issue: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", args, { windowsHide: true });
      const timer = setTimeout(() => {
        issue = "Acceptance timeout";
        child.kill();
        void exec("docker", ["rm", "--force", name]).catch(() => undefined);
      }, entry.acceptance.program!.timeoutMs);
      child.on("error", reject);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 8_000_000) {
          issue = "Acceptance output exceeds limit";
          child.kill();
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-32000);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) issue ??= `Acceptance process exited ${code}`;
        resolve();
      });
    });
    if (issue) return { result: { status: "error", checks: [], error: issue }, stdout, stderr };
    const output = JSON.parse(stdout) as { checks?: unknown };
    return {
      result: validateChecks(
        entry.acceptance.criteria.filter((item) => item.method !== "judge"),
        output.checks,
      ),
      stdout,
      stderr,
    };
  } catch (error) {
    return { result: { status: "error", checks: [], error: String(error) }, stdout, stderr };
  } finally {
    await exec("docker", ["rm", "--force", name], { timeout: 10000 }).catch(() => undefined);
  }
}
export async function accept(
  entry: LoadedCase,
  workspace: string,
  evidence: Evidence[],
  judge?: { provider: ModelProvider; model: string },
  signal?: AbortSignal,
): Promise<AcceptanceResult> {
  const evaluator = entry.value.acceptance.evaluator;
  if (evaluator === "program") {
    const output = await runProgram(entry, workspace);
    const id = `acceptance-program-${evidence.length}`;
    evidence.push({ id, type: "acceptance-program-output", data: output });
    return {
      ...output.result,
      checks: output.result.checks.map((check) => ({ ...check, evidence: [id] })),
    };
  }
  let program: AcceptanceResult | undefined;
  if (evaluator === "combined") {
    const output = await runProgram(entry, workspace),
      id = `acceptance-program-${evidence.length}`;
    program = {
      ...output.result,
      checks: output.result.checks.map((check) => ({ ...check, evidence: [id] })),
    };
    evidence.push({ id, type: "acceptance-program-output", data: output });
    if (program.status === "error") return program;
  }
  if (!judge) return { status: "error", checks: [], error: "Judge required but unavailable" };
  try {
    const judgment = await judgeAcceptance(
      judge.provider,
      judge.model,
      {
        ...entry,
        acceptance: {
          ...entry.acceptance,
          criteria: entry.acceptance.criteria.filter((item) => item.method !== "program"),
        },
      },
      evidence,
      signal,
    );
    return program
      ? validateChecks(entry.acceptance.criteria, [...program.checks, ...judgment.checks])
      : judgment;
  } catch (error) {
    return { status: "error", checks: [], error: `Acceptance Judge error: ${String(error)}` };
  }
}
