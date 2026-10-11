export const PROCESS_JUDGE_VERSION = "process-v5";
import { COMPOSITE_POLICY, scoreExecution, completeMean } from "./composite.js";
import type {
  AcceptanceResult,
  CheckResult,
  Criterion,
  ProcessResult,
  RunRecord,
} from "./types.js";

/** A missing, duplicate, extra or malformed check is an evaluator error, never a pass. */
export function validateChecks(criteria: Criterion[], input: unknown): AcceptanceResult {
  if (!Array.isArray(input))
    return { status: "error", checks: [], error: "Evaluator did not return checks" };
  const expected = new Set(criteria.map((item) => item.id)),
    seen = new Set<string>();
  const checks: CheckResult[] = [];
  for (const item of input) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some((key) => !["id", "status", "reason", "evidence"].includes(key)) ||
      !expected.has(item.id) ||
      seen.has(item.id) ||
      !["passed", "failed", "error"].includes(item.status) ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      !Array.isArray(item.evidence) ||
      !item.evidence.every((id: unknown) => typeof id === "string")
    )
      return { status: "error", checks, error: "Invalid or duplicate check" };
    seen.add(item.id);
    checks.push(item);
  }
  for (const criterion of criteria)
    if (!seen.has(criterion.id))
      checks.push({
        id: criterion.id,
        status: "error",
        reason: "Required check missing",
        evidence: [],
      });
  return {
    status: checks.some((item) => item.status === "error")
      ? "error"
      : checks.every((item) => item.status === "passed")
        ? "passed"
        : "failed",
    checks,
  };
}
export function validateProcess(input: unknown, evidenceIds: Set<string>): ProcessResult {
  const value = input as Record<string, unknown>;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["toolAccuracy", "pathEfficiency"].includes(key))
  )
    throw Error("Invalid process result");
  for (const name of ["toolAccuracy", "pathEfficiency"]) {
    const dimension = value[name] as { score: unknown; reason: unknown; evidence: unknown };
    if (
      !dimension ||
      typeof dimension !== "object" ||
      Array.isArray(dimension) ||
      Object.keys(dimension).some((key) => !["score", "reason", "evidence"].includes(key))
    )
      throw Error(`Invalid process dimension: ${name}`);
    if (
      dimension.score !== null &&
      (!Number.isInteger(dimension.score) ||
        Number(dimension.score) < 0 ||
        Number(dimension.score) > 4)
    )
      throw Error(
        `${name}.score must be integer 0..4 or null, received ${JSON.stringify(dimension.score)}`,
      );
    if (typeof dimension.reason !== "string" || !dimension.reason.trim())
      throw Error(`${name}.reason must be nonempty string`);
    if (!Array.isArray(dimension.evidence))
      throw Error(`${name}.evidence must be an array of exact supplied evidence IDs`);
    const cited = dimension.evidence;
    const unknown = cited.filter((id) => typeof id !== "string" || !evidenceIds.has(id));
    if (unknown.length)
      throw Error(`${name}.evidence contains unknown IDs: ${JSON.stringify(unknown.slice(0, 8))}`);
    if (new Set(dimension.evidence).size !== dimension.evidence.length)
      throw Error(`${name}.evidence contains duplicate IDs`);
    const proseReferences = dimension.reason.match(/\b(?:E|P)\d+\b/g) ?? [];
    const invalidProse = proseReferences.filter(
      (id) => !evidenceIds.has(id) || !cited.includes(id),
    );
    if (invalidProse.length)
      throw Error(
        `${name}.reason references unknown or uncited IDs: ${JSON.stringify([...new Set(invalidProse)])}`,
      );
    if (dimension.score !== null && !dimension.evidence.length)
      throw Error(`${name} requires cited evidence for a graded score`);
  }
  const result = value as unknown as ProcessResult;
  return {
    ...result,
    score:
      result.toolAccuracy.score === null || result.pathEfficiency.score === null
        ? null
        : (100 * (result.toolAccuracy.score + result.pathEfficiency.score)) / 8,
    judgeVersion: PROCESS_JUDGE_VERSION,
  };
}
/** Each case has equal weight; repetitions do not increase that case's weight. */
export function summarize(
  records: RunRecord[],
  expectedCaseIds: string[],
  metadata?: Record<string, { scenario?: string }>,
  expectedRepeats?: number,
) {
  if (expectedRepeats !== undefined && (!Number.isInteger(expectedRepeats) || expectedRepeats < 1))
    throw Error("Expected repetitions must be a positive integer");
  if (!expectedCaseIds.length || new Set(expectedCaseIds).size !== expectedCaseIds.length)
    throw Error("Expected case IDs must be nonempty and unique");
  if (records.some((run) => run.configuration) && records.some((run) => !run.configuration))
    throw Error("Cannot aggregate configured runs with unversioned runs");
  const groups = new Map<string, RunRecord[]>();
  const runIds = new Set<string>();
  for (const record of records) {
    if (!["passed", "failed", "error"].includes(record.acceptance.status))
      throw Error("Invalid acceptance status");
    if (record.process) {
      const dimensions = [record.process.toolAccuracy.score, record.process.pathEfficiency.score];
      if (
        dimensions.some(
          (score) => score !== null && (!Number.isInteger(score) || score < 0 || score > 4),
        )
      )
        throw Error("Invalid process dimension");
      const expected = dimensions.some((score) => score === null)
        ? null
        : (100 * (dimensions[0]! + dimensions[1]!)) / 8;
      if (record.process.score !== expected) throw Error("Process total does not match dimensions");
    }
    if (runIds.has(record.id)) throw Error(`Duplicate execution record: ${record.id}`);
    runIds.add(record.id);
    if (!expectedCaseIds.includes(record.caseId)) throw Error(`Unexpected case: ${record.caseId}`);
    const group = groups.get(record.caseId) ?? [];
    group.push(record);
    groups.set(record.caseId, group);
  }
  const cases = expectedCaseIds.map((id) => {
    const runs = groups.get(id) ?? [];
    const valid = runs.filter((run) => run.acceptance.status !== "error");
    const process = runs
      .map((run) => run.process?.score)
      .filter((score): score is number => typeof score === "number");
    const metrics = [
      "agentLatencyMs",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "costUsd",
      "toolCallCount",
      "toolErrorCount",
    ] as const;
    const engineering = Object.fromEntries(
      metrics.map((key) => {
        const values = runs
          .map((run) => run.engineering?.[key])
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value) && value >= 0,
          );
        return [
          key,
          {
            mean: values.length
              ? values.reduce((sum, value) => sum + value, 0) / values.length
              : null,
            reported: values.length,
            runs: runs.length,
          },
        ];
      }),
    );
    return {
      id,
      compositeScore:
        expectedRepeats !== undefined && runs.length !== expectedRepeats
          ? null
          : completeMean(runs.map((run) => scoreExecution(run).score)),
      resourceScore: completeMean(runs.map((run) => scoreExecution(run).resourceScore)),
      runs: runs.length,
      evaluatorErrors: runs.length - valid.length,
      successRate: valid.length
        ? valid.filter((run) => run.acceptance.status === "passed").length / valid.length
        : null,
      processScore: process.length
        ? process.reduce((sum, score) => sum + score, 0) / process.length
        : null,
      processCoverage: { graded: process.length, runs: runs.length },
      processDimensionCoverage: {
        toolAccuracy: runs.filter((run) => run.process?.toolAccuracy.score != null).length,
        pathEfficiency: runs.filter((run) => run.process?.pathEfficiency.score != null).length,
        runs: runs.length,
      },
      engineering,
    };
  });
  const mean = (values: (number | null)[]) => {
    const valid = values.filter((value): value is number => value !== null);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  };
  const configurations = new Set(
    records.filter((run) => run.configuration).map((run) => JSON.stringify(run.configuration)),
  );
  if (configurations.size > 1)
    throw Error("Cannot aggregate different datasets, models or execution budgets");
  if (new Set(records.map((run) => JSON.stringify(run.processJudgePolicy ?? null))).size > 1)
    throw Error("Cannot aggregate different or missing process Judge policies");
  if (
    new Set(records.filter((run) => run.process).map((run) => run.process!.judgeVersion)).size > 1
  )
    throw Error("Cannot aggregate different process Judge versions");
  const resourceKeys = ["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"] as const;
  const resourceTotals = (runs: RunRecord[]) =>
    Object.fromEntries(
      resourceKeys.map((key) => {
        const known = runs
          .map((run) => run.engineering?.[key])
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value) && value >= 0,
          );
        const reported = runs
          .map((run) => run.engineering?.reportedSubtotal?.[key] ?? run.engineering?.[key])
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value) && value >= 0,
          );
        return [
          key,
          {
            total:
              known.length === runs.length ? known.reduce((sum, value) => sum + value, 0) : null,
            reportedSubtotal:
              reported.length || !runs.length
                ? reported.reduce((sum, value) => sum + value, 0)
                : null,
            reportedRuns: known.length,
            runs: runs.length,
          },
        ];
      }),
    ) as Record<
      (typeof resourceKeys)[number],
      { total: number | null; reportedSubtotal: number | null; reportedRuns: number; runs: number }
    >;
  const successful = records.filter((run) => run.acceptance.status === "passed");
  const failed = records.filter((run) => run.acceptance.status === "failed");
  const processGroup = (runs: RunRecord[]) => {
    const scores = expectedCaseIds.map((id) => {
      const values = runs
        .filter((run) => run.caseId === id)
        .map((run) => run.process?.score ?? null)
        .filter((score): score is number => score !== null);
      return values.length ? mean(values) : null;
    });
    return {
      caseMean: mean(scores),
      gradedRuns: runs.filter((run) => run.process?.score != null).length,
      runs: runs.length,
    };
  };
  const missing = records.map((run) => ({
    runId: run.id,
    caseId: run.caseId,
    evidence: run.missingEvidence ?? [],
    acceptance:
      run.acceptance.status === "error"
        ? (run.acceptance.error ??
          (run.acceptance.checks
            ?.filter((check) => check.status === "error")
            .map((check) => check.reason)
            .join("; ") ||
            "Evaluator error"))
        : null,
    process:
      run.processEvaluation?.reason ??
      run.processError ??
      (!run.process
        ? "Process Judge result unavailable"
        : run.process.score === null
          ? [run.process.toolAccuracy, run.process.pathEfficiency]
              .filter((d) => d.score === null)
              .map((d) => d.reason)
              .join("; ")
          : null),
    engineering: ["agentLatencyMs", ...resourceKeys, "toolCallCount", "toolErrorCount"].filter(
      (key) => {
        const value = run.engineering?.[key as keyof RunRecord["engineering"]];
        return typeof value !== "number" || !Number.isFinite(value) || value < 0;
      },
    ),
  }));
  const repetitions = cases.map((item) => item.runs);
  return {
    cases,
    scoringPolicy: COMPOSITE_POLICY,
    compositeScore: completeMean(cases.map((item) => item.compositeScore)),
    resourceScore: completeMean(cases.map((item) => item.resourceScore)),
    compositeCoverage: {
      gradedCases: cases.filter((item) => item.compositeScore !== null).length,
      expectedCases: cases.length,
      expectedRepeats: expectedRepeats ?? null,
      executions: records.map((run) => ({
        runId: run.id,
        caseId: run.caseId,
        ...scoreExecution(run),
      })),
    },
    coverage: {
      expected: cases.length,
      executed: cases.filter((item) => item.runs).length,
      acceptanceEvaluated: cases.filter((item) => item.successRate !== null).length,
      process: cases.filter((item) => item.processScore !== null).length,
    },
    successRate: mean(cases.map((item) => item.successRate)),
    processScore: mean(cases.map((item) => item.processScore)),
    configuration: records[0]?.configuration ?? null,
    processJudgePolicy: records[0]?.processJudgePolicy ?? null,
    processByOutcome: {
      successful: processGroup(successful),
      failed: processGroup(failed),
      evaluatorError: processGroup(records.filter((run) => run.acceptance.status === "error")),
    },
    outcomes: {
      passed: successful.length,
      failed: failed.length,
      evaluatorErrors: records.filter((run) => run.acceptance.status === "error").length,
      timeout: records.filter((run) => run.execution?.status === "timeout").length,
      budgetExhausted: records.filter((run) => run.execution?.status === "budget_exhausted").length,
      infrastructureErrors: records.filter(
        (run) => run.execution?.status === "infrastructure_error",
      ).length,
      executionStatusUnavailable: records.filter((run) => !run.execution).length,
    },
    repetitions: {
      byCase: Object.fromEntries(cases.map((item) => [item.id, item.runs])),
      balanced: new Set(repetitions).size === 1,
    },
    missing,
    scenarios: metadata
      ? Object.fromEntries(
          [...new Set(expectedCaseIds.map((id) => metadata[id]?.scenario ?? "unclassified"))].map(
            (scenario) => {
              const ids = expectedCaseIds.filter(
                (id) => (metadata[id]?.scenario ?? "unclassified") === scenario,
              );
              const subset = cases.filter((item) => ids.includes(item.id));
              return [
                scenario,
                {
                  cases: subset,
                  compositeScore: completeMean(subset.map((item) => item.compositeScore)),
                  successRate: mean(subset.map((item) => item.successRate)),
                  processScore: mean(subset.map((item) => item.processScore)),
                  coverage: {
                    expected: ids.length,
                    executed: subset.filter((item) => item.runs).length,
                    process: subset.filter((item) => item.processScore !== null).length,
                  },
                  engineering: resourceTotals(records.filter((run) => ids.includes(run.caseId))),
                },
              ];
            },
          ),
        )
      : undefined,
    engineering: {
      agentLatencyMs: {
        caseMean: mean(cases.map((item) => item.engineering.agentLatencyMs!.mean)),
        reportedCases: cases.filter((item) => item.engineering.agentLatencyMs!.mean !== null)
          .length,
        cases: cases.length,
      },
      allRuns: resourceTotals(records),
      successfulRuns: resourceTotals(successful),
      consumptionPerSuccess: Object.fromEntries(
        resourceKeys.map((key) => [
          key,
          successful.length && resourceTotals(records)[key].total !== null
            ? resourceTotals(records)[key].total! / successful.length
            : null,
        ]),
      ),
      evaluation: Object.fromEntries(
        (["acceptance", "processJudge"] as const).map((phase) => [
          phase,
          Object.fromEntries(
            (["latencyMs", ...resourceKeys] as const).map((key) => {
              const values = records
                .map((run) => run.evaluation?.[phase]?.[key])
                .filter(
                  (value): value is number =>
                    typeof value === "number" && Number.isFinite(value) && value >= 0,
                );
              const subtotals = records
                .map((run) =>
                  key === "latencyMs"
                    ? run.evaluation?.[phase]?.latencyMs
                    : (run.evaluation?.[phase]?.reportedSubtotal?.[key] ??
                      run.evaluation?.[phase]?.[key]),
                )
                .filter(
                  (value): value is number =>
                    typeof value === "number" && Number.isFinite(value) && value >= 0,
                );
              return [
                key,
                {
                  total:
                    values.length === records.length ? values.reduce((a, b) => a + b, 0) : null,
                  reportedSubtotal: subtotals.length ? subtotals.reduce((a, b) => a + b, 0) : null,
                  reportedRuns: values.length,
                  runs: records.length,
                },
              ];
            }),
          ),
        ]),
      ),
    },
    coverageComplete:
      records.every((run) => run.configuration) &&
      records.every((run) => !run.missingEvidence?.length) &&
      new Set(repetitions).size === 1 &&
      cases.every(
        (item) =>
          item.runs > 0 && item.evaluatorErrors === 0 && item.processCoverage.graded === item.runs,
      ),
  };
}

/** Compare fixed case sets and repetitions. Never silently select an intersection. */
export function compareAgents(
  groups: Record<string, RunRecord[]>,
  expectedCaseIds: string[],
  metadata?: Record<string, { scenario?: string }>,
) {
  if (Object.keys(groups).length < 2) throw Error("Comparison requires at least two Agent groups");
  const reports = Object.fromEntries(
    Object.entries(groups).map(([name, records]) => [
      name,
      summarize(records, expectedCaseIds, metadata),
    ]),
  );
  const records = Object.values(groups).flat();
  const policies = new Set(
    records.map((run) => {
      if (!run.configuration) return "unversioned";
      const {
        model: _model,
        provider: _provider,
        agent: _agent,
        agentVersion: _agentVersion,
        agentInstallationDigest: _installation,
        modelProtocol: _protocol,
        ...policy
      } = run.configuration;
      return JSON.stringify(policy);
    }),
  );
  const reasons: string[] = [];
  if (new Set(records.map((run) => run.id)).size !== records.length)
    reasons.push("Execution records are reused between Agent groups");
  if (policies.size !== 1 || policies.has("unversioned"))
    reasons.push("Dataset, budget, Judge model or execution protocol differs or is missing");
  if (
    new Set(records.filter((run) => run.process).map((run) => run.process!.judgeVersion)).size > 1
  )
    reasons.push("Process Judge versions differ");
  if (new Set(records.map((run) => JSON.stringify(run.processJudgePolicy ?? null))).size > 1)
    reasons.push("Process Judge policies differ or are missing");
  if (records.some((run) => !run.processJudgePolicy))
    reasons.push("Process Judge policy is not recorded");
  if (
    new Set(Object.values(reports).map((report) => JSON.stringify(report.repetitions.byCase)))
      .size > 1
  )
    reasons.push("Case repetition counts differ");
  for (const [name, report] of Object.entries(reports))
    if (!report.coverageComplete)
      reasons.push(`${name}: incomplete or unbalanced evaluation coverage`);
  const compositeReasons = [...reasons];
  for (const [name, report] of Object.entries(reports))
    if (report.compositeScore === null)
      compositeReasons.push(`${name}: composite score incomplete`);
  const ordered = Object.entries(reports).sort(
    (a, b) => (b[1].compositeScore ?? 0) - (a[1].compositeScore ?? 0),
  );
  const ranking = compositeReasons.length
    ? null
    : ordered.map(([agent, report]) => ({
        agent,
        score: report.compositeScore!,
        rank: ordered.findIndex(([, value]) => value.compositeScore === report.compositeScore) + 1,
      }));
  return {
    comparable: !reasons.length,
    reasons,
    compositeComparable: !compositeReasons.length,
    compositeReasons,
    ranking,
    scoringPolicy: COMPOSITE_POLICY,
    expectedCaseIds,
    agents: reports,
    configurations: Object.fromEntries(
      Object.entries(groups).map(([name, runs]) => [name, runs[0]?.configuration ?? null]),
    ),
  };
}
