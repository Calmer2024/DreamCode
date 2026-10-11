/** Real Claude Code trials for dataset authoring; never benchmark ranking or synthetic success. */
import { mkdir, readFile, writeFile, cp, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadDataset } from "../src/dataset/loader.js";
import { freezeIntegrity } from "../src/dataset/integrity.js";
import { runCase, savedModel } from "../src/dataset/runner.js";
import { readAgentInstallation, savedAgentEndpoint } from "../src/dataset/agents.js";

const candidate = path.resolve("evals/dataset-candidate-2026-10-10");
const directory = path.resolve(
  process.env.DREAMCODE_CALIBRATION_DIRECTORY ??
    `evals/runs/dataset/calibration-${randomUUID().slice(0, 8)}`,
);
const selected = process.argv.slice(2);
const model = "mimo-v2.5-pro";
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => controller.abort(Error("Calibration interrupted")));
await mkdir(directory, { recursive: true });
const data = await loadDataset(candidate);
if (selected.some((id) => !data.cases.some((c) => c.value.id === id)))
  throw Error("Unknown case selection");
const entries = data.cases.filter((c) => !selected.length || selected.includes(c.value.id));
const provider = await savedModel(model);
const installation = await readAgentInstallation(process.cwd());
const endpoint = await savedAgentEndpoint(model, "claude-code");
const workerDirectory = path.join(directory, "batch-runtime");
await mkdir(workerDirectory, { recursive: true });
const worker = path.join(workerDirectory, "worker.mjs");
await cp("packages/evals/dist-dataset-container/worker.mjs", worker, {
  errorOnExist: true,
  force: false,
});
const report: {
  status: string;
  createdAt: string;
  purpose: string;
  model: string;
  agent: string;
  candidate: string;
  caseIds: string[];
  completed: unknown[];
  current: unknown;
  budget: {
    agentMs: number;
    combinedAgentMs: number;
    acceptancePhaseMs: number;
    caseWallMs: number;
  };
} = {
  status: "running",
  createdAt: new Date().toISOString(),
  purpose: "dataset-calibration-not-benchmark",
  model,
  agent: "claude-code",
  candidate,
  caseIds: entries.map((e) => e.value.id),
  budget: {
    agentMs: 540000,
    combinedAgentMs: 480000,
    acceptancePhaseMs: 45000,
    caseWallMs: 600000,
  },
  completed: [],
  current: null,
};
let writes = Promise.resolve();
function persist() {
  const file = path.join(directory, "report.json");
  const serialized = JSON.stringify(report, null, 2);
  writes = writes.then(async () => {
    await writeFile(file + ".tmp", serialized);
    await rename(file + ".tmp", file);
  });
  return writes;
}
console.log(JSON.stringify({ directory, cases: report.caseIds, purpose: report.purpose }));
await persist();
for (const entry of entries) {
  if (controller.signal.aborted) break;
  const trial = path.join(directory, entry.value.id);
  const currentVersion = JSON.parse(await readFile(path.join(candidate, "dataset.json"), "utf8"))
    .version as string;
  const frozen = path.join(trial, "dataset");
  await mkdir(path.join(frozen, "cases"), { recursive: true });
  await cp(entry.root, path.join(frozen, "cases", entry.value.id), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await cp(path.join(candidate, "runtimes"), path.join(frozen, "runtimes"), { recursive: true });
  await writeFile(
    path.join(frozen, "dataset.json"),
    JSON.stringify({ version: currentVersion, cases: [`cases/${entry.value.id}/case.json`] }),
  );
  const integrity = await freezeIntegrity(frozen);
  const frozenEntry = (await loadDataset(frozen)).cases[0]!;
  // Leave headroom for verification and cleanup; each pass must also meet the measured wall limit.
  frozenEntry.runtime.timeoutMs = 45000;
  if (frozenEntry.acceptance.program)
    frozenEntry.acceptance.program.timeoutMs = Math.min(
      45000,
      frozenEntry.acceptance.program.timeoutMs,
    );
  const started = performance.now();
  let lastWrite = 0;
  let progress = { modelRequests: 0, toolsCompleted: 0 };
  report.current = {
    caseId: entry.value.id,
    phase: "preparing",
    startedAt: new Date().toISOString(),
  };
  await persist();
  try {
    const result = await runCase(frozenEntry, {
      directory: trial,
      worker,
      provider,
      model,
      judge: { provider, model },
      external: { agent: "claude-code", installation, endpoint },
      processJudge: false,
      timeoutMs: frozenEntry.value.acceptance.evaluator === "combined" ? 480000 : 540000,
      maxModelRequests: 80,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]),
      dataset: { version: currentVersion, digest: integrity.digest },
      onPhase: async (phase) => {
        report.current = { caseId: entry.value.id, phase, ...progress };
        await persist();
        console.log(JSON.stringify(report.current));
      },
      onProgress: (event) => {
        if (event.type === "model.started") progress.modelRequests++;
        if (event.type === "tool.completed") progress.toolsCompleted++;
        if (Date.now() - lastWrite > 15000) {
          lastWrite = Date.now();
          report.current = {
            caseId: entry.value.id,
            phase: "agent",
            ...progress,
            lastEventAt: event.timestamp,
          };
          void persist().catch((error) =>
            console.error("Calibration progress write failed", String(error)),
          );
          console.log(
            JSON.stringify({ caseId: entry.value.id, ...progress, lastEvent: event.type }),
          );
        }
      },
    });
    const wallMs = performance.now() - started;
    const qualified =
      result.record.execution?.status === "completed" &&
      result.record.acceptance.status === "passed" &&
      !result.record.missingEvidence.length &&
      wallMs < 600000;
    const summary = {
      caseId: entry.value.id,
      qualified,
      engineeringReview: "pending",
      wallMs,
      trial,
      frozenDigest: integrity.digest,
      record: path.join(result.directory, "record.json"),
      execution: result.record.execution,
      acceptance: result.record.acceptance,
      engineering: result.record.engineering,
    };
    report.completed.push(summary);
    console.log(
      JSON.stringify({
        caseId: entry.value.id,
        qualified,
        wallMs,
        execution: summary.execution,
        acceptance: summary.acceptance.status,
      }),
    );
  } catch (error) {
    report.completed.push({
      caseId: entry.value.id,
      qualified: false,
      trial,
      error: String(error),
      wallMs: performance.now() - started,
    });
    console.log(JSON.stringify({ caseId: entry.value.id, error: String(error) }));
  }
  report.current = null;
  await persist();
}
report.status = controller.signal.aborted ? "interrupted" : "trial-finished-awaiting-review";
await persist();
console.log(JSON.stringify({ status: report.status, directory }));
