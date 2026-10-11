// Read-only audit of a persisted full batch. Does not call models or alter run evidence.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { summarize } from "../dist/dataset/index.js";

const jobId = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(jobId ?? "")) throw Error("Usage: node audit-full-eval.mjs BATCH_ID");
const repo = process.cwd();
const datasetRoot = path.join(repo, "evals/dataset");
const runsRoot = path.join(repo, "evals/runs/dataset");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const job = await json(path.join(runsRoot, "web-jobs", `${jobId}.json`));
const manifest = await json(path.join(datasetRoot, "dataset.json"));
const metadata = {}, criteria = {};
for (const relative of manifest.cases) {
  const file = path.join(datasetRoot, relative);
  const value = await json(file);
  metadata[value.id] = value.metadata ?? {};
  criteria[value.id] = (await json(path.join(path.dirname(file), value.acceptance.config))).criteria;
}
const records = [];
const unreadable = [];
for (const key of job.records) {
  const file = path.resolve(runsRoot, Buffer.from(key, "base64url").toString("utf8"));
  if (!file.startsWith(`${runsRoot}${path.sep}`) || path.basename(file) !== "record.json") throw Error("Invalid record path");
  try {
    const full = await json(file);
    const observed = {};
    const evidenceTypes = {};
    for (const item of full.evidence) {
      observed[item.type] = (observed[item.type] ?? 0) + 1;
      evidenceTypes[item.id] = item.type;
    }
    // Aggregate telemetry with compact records rather than retaining every repeated model context.
    records.push({ file, value: { ...full, evidence: [] }, observed, evidenceTypes });
  }
  catch (error) { unreadable.push({ file, error: String(error) }); }
}
const summary = summarize(records.map(({ value }) => value), job.caseIds, metadata, job.repeats);
const cases = records.map(({ file, value: run, observed, evidenceTypes }) => {
  const expected = new Set(criteria[run.caseId].map((item) => item.id));
  const received = run.acceptance.checks.map((item) => item.id);
  const issues = [];
  if (run.acceptance.status === "passed" && (expected.size !== received.length
    || received.some((id) => !expected.has(id)) || new Set(received).size !== received.length
    || run.acceptance.checks.some((item) => item.status !== "passed"))) issues.push("Passed verdict has inconsistent required checks");
  if (run.acceptance.status === "error") issues.push("Evaluator or execution error");
  if (run.missingEvidence?.length) issues.push("Missing execution evidence");
  if (run.process?.score == null) issues.push("Process score unavailable");
  if (run.engineering.inputTokens == null || run.engineering.outputTokens == null) issues.push("Incomplete Token telemetry");
  if (run.engineering.costUsd == null) issues.push("Price unavailable; Token scoring remains applicable");
  if (run.execution?.status === "infrastructure_error") issues.push("Infrastructure error");
  const judgeReferences = {};
  for (const dimension of ["toolAccuracy", "pathEfficiency"]) {
    const result = run.process?.[dimension];
    if (!result) continue;
    const mentioned = [...new Set(result.reason.match(/\bE\d+\b/g) ?? [])];
    judgeReferences[dimension] = mentioned.filter((id) => !result.evidence.includes(id)).map((id) =>
      ({ id, type: evidenceTypes[id] ?? null }));
    if (judgeReferences[dimension].length) issues.push(`${dimension}: narrative/structured evidence references differ; review required`);
  }
  const tokenTotal = run.engineering.inputTokens != null && run.engineering.outputTokens != null
    ? run.engineering.inputTokens + run.engineering.outputTokens : null;
  return {
    caseId: run.caseId, ...metadata[run.caseId], record: path.relative(repo, file).replaceAll("\\", "/"),
    execution: run.execution, acceptance: run.acceptance, process: run.process,
    processEvaluation: run.processEvaluation, processError: run.processError,
    engineering: run.engineering, evaluation: run.evaluation, tokenTotal,
    modelRequests: observed["model.request"] ?? 0, evidenceCounts: observed,
    composite: summary.compositeCoverage.executions.find((item) => item.runId === run.id), issues, judgeReferences,
  };
});
let live = null;
if (job.currentCase) {
  const batchRoot = path.join(runsRoot, `web-${jobId}`);
  for (const directory of await readdir(batchRoot).catch(() => [])) {
    if (!directory.startsWith(`${job.currentCase}-`)) continue;
    const sessions = path.join(batchRoot, directory, "agent-home/sessions");
    for (const session of await readdir(sessions).catch(() => [])) {
      const text = await readFile(path.join(sessions, session, "events.jsonl"), "utf8").catch(() => "");
      const counts = {};
      let reportedInputTokens = 0, reportedOutputTokens = 0, reportedCachedInputTokens = 0;
      let modelStart = null, observedModelMs = 0, observedToolMs = 0;
      const toolStarts = new Map();
      let lastPublicEvent = null;
      for (const line of text.split("\n")) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        // Inspect only event names/timestamps; never retain internal reasoning or message content.
        if (event.type?.includes("reasoning")) continue;
        const timestamp = Date.parse(event.timestamp);
        if (event.type === "model.started") modelStart = timestamp;
        if (event.type === "model.usage" && modelStart !== null) {
          observedModelMs += Math.max(0, timestamp - modelStart); modelStart = null;
        }
        if (event.type === "tool.started") toolStarts.set(event.payload?.toolCallId, timestamp);
        if (event.type === "tool.completed" && toolStarts.has(event.payload?.toolCallId)) {
          observedToolMs += Math.max(0, timestamp - toolStarts.get(event.payload.toolCallId));
          toolStarts.delete(event.payload.toolCallId);
        }
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (event.type === "model.usage") {
          reportedInputTokens += event.payload?.usage?.inputTokens ?? 0;
          reportedOutputTokens += event.payload?.usage?.outputTokens ?? 0;
          reportedCachedInputTokens += event.payload?.usage?.cachedInputTokens ?? 0;
        }
        lastPublicEvent = { type: event.type, timestamp: event.timestamp };
      }
      live = { caseId: job.currentCase, modelRequests: counts["model.started"] ?? 0,
        toolsStarted: counts["tool.started"] ?? 0, toolsCompleted: counts["tool.completed"] ?? 0,
        reportedInputTokens, reportedOutputTokens, reportedCachedInputTokens,
        observedModelMs, observedToolMs,
        lastPublicEvent };
    }
  }
}
const audit = {
  generatedAt: new Date().toISOString(), jobId, status: job.status,
  currentCase: job.currentCase, startedAt: job.startedAt, finishedAt: job.finishedAt,
  selectedCases: job.caseIds.length, repeats: job.repeats, completed: job.completed, total: job.total,
  model: job.model, judgeModel: job.judgeModel, datasetVersion: job.datasetVersion,
  datasetDigest: job.datasetDigest, complete: job.status === "completed" && job.completed === job.total
    && records.length === job.total && !unreadable.length && !job.errors.length,
  errors: job.errors, unreadable, summary, cases, live,
};
const output = path.join(runsRoot, `web-${jobId}`);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "full-eval-audit.json"), JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ jobId, status: audit.status, currentCase: audit.currentCase,
  completed: audit.completed, total: audit.total, recorded: cases.length,
  passed: summary.outcomes.passed, failed: summary.outcomes.failed, evaluatorErrors: summary.outcomes.evaluatorErrors,
  compositeScore: summary.compositeScore, processScore: summary.processScore,
  live,
  latest: cases.slice(-2).map((item) => ({ caseId: item.caseId, acceptance: item.acceptance.status,
    process: item.process?.score, tokens: item.tokenTotal, issues: item.issues })),
}));
