import type { DatasetJob, DatasetRun } from "./dataset-types";
export function agentLabel(agent?: string) {
  return (
    (
      {
        dreamcode: "DreamCode",
        "claude-code": "Claude Code",
        pi: "Pi",
        dsh: "DeepSeek Harness",
        opencode: "OpenCode",
      } as Record<string, string>
    )[agent ?? "dreamcode"] ?? agent
  );
}
export function phaseLabel(phase?: string) {
  return (
    (
      {
        preparing: "准备工作区",
        agent: "Agent 执行",
        acceptance: "任务验收",
        process_judge: "过程 Judge",
        completed: "写入结果",
      } as Record<string, string>
    )[phase ?? ""] ?? "执行中"
  );
}

/** Keep the submitted case scope, including pending and failed attempts. */
export function batchCases(job: DatasetJob, runs: DatasetRun[]) {
  const records = new Map(runs.map((run) => [run.key, run]));
  return job.caseIds.map((caseId) => {
    const ordered = job.records
      .map((key) => records.get(key))
      .filter((run) => run?.caseId === caseId);
    let next = 0;
    const attempts = Array.from({ length: job.repeats }, (_, index) => {
      const repetition = index + 1;
      const saved = job.attempts?.find(
        (attempt) => attempt.caseId === caseId && attempt.repetition === repetition,
      );
      const error =
        saved?.error ??
        job.errors.find((item) => item.caseId === caseId && item.repetition === repetition)?.reason;
      // Earlier batch manifests have ordered successful records and numbered errors.
      const run = job.attempts
        ? saved?.key
          ? records.get(saved.key)
          : undefined
        : error
          ? undefined
          : ordered[next++];
      return { repetition, run, error, missingRecord: !!saved?.key && !run };
    });
    return { caseId, attempts, summary: job.summary?.cases.find((item) => item.id === caseId) };
  });
}

/** Execution wall time excludes queue waiting; interrupted jobs lack a trustworthy end. */
export function batchElapsed(job: DatasetJob, now = Date.now()): number | null {
  if (!job.startedAt || job.status === "interrupted" || job.status === "queued") return null;
  const start = Date.parse(job.startedAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : job.status === "running" ? now : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function caseElapsed(job: DatasetJob, now = Date.now()): number | null {
  if (job.status !== "running" || !job.currentCase || !job.currentCaseStartedAt) return null;
  const start = Date.parse(job.currentCaseStartedAt);
  return Number.isFinite(start) && now >= start ? now - start : null;
}

export function duration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return "_";
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
