import type { RunRecord } from "./types.js";

/** Versioned scoring policy, independent of case data and immutable run evidence. */
export const COMPOSITE_POLICY = Object.freeze({
  version: "composite-v1-token",
  correctnessWeight: 0.7,
  processWeight: 0.2,
  resourceWeight: 0.1,
  tokenWeight: 0.6,
  latencyWeight: 0.4,
  tokenBaseline: 100_000,
  latencyBaselineMs: 600_000,
  tokenAccounting: "inputTokens+outputTokens; cached input is already included",
  failureScore: 0,
});

const known = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function scoreExecution(
  run: Pick<RunRecord, "acceptance" | "execution" | "engineering" | "process" | "missingEvidence">,
) {
  const reasons: string[] = [];
  const engineering = run.engineering ?? ({} as RunRecord["engineering"]);
  const tokens =
    engineering.usageCoverage != null &&
    engineering.usageCoverage.reported === engineering.usageCoverage.requests &&
    known(engineering.inputTokens) &&
    known(engineering.outputTokens)
      ? engineering.inputTokens + engineering.outputTokens
      : null;
  const tokenScore =
    tokens !== null && Number.isFinite(tokens)
      ? 100 * Math.min(1, COMPOSITE_POLICY.tokenBaseline / Math.max(tokens, 1))
      : null;
  const latencyScore = known(engineering.agentLatencyMs)
    ? 100 *
      Math.min(1, COMPOSITE_POLICY.latencyBaselineMs / Math.max(engineering.agentLatencyMs, 1))
    : null;
  const resourceScore =
    tokenScore !== null && latencyScore !== null
      ? COMPOSITE_POLICY.tokenWeight * tokenScore + COMPOSITE_POLICY.latencyWeight * latencyScore
      : null;
  if (run.execution?.status === "infrastructure_error" || run.acceptance.status === "error")
    reasons.push("Execution or evaluator error; rerun required");
  if (!Array.isArray(run.missingEvidence) || run.missingEvidence.length)
    reasons.push("Execution evidence is incomplete");
  const processScore = run.process?.score ?? null;
  if (!["passed", "failed", "error"].includes(run.acceptance.status))
    reasons.push("Invalid acceptance status");
  if (run.acceptance.status === "passed") {
    if (!known(processScore) || processScore > 100)
      reasons.push("Process score unavailable or invalid");
    if (
      run.process &&
      (run.process.toolAccuracy.score === null ||
        run.process.pathEfficiency.score === null ||
        ![run.process.toolAccuracy.score, run.process.pathEfficiency.score].every(
          (value) => Number.isInteger(value) && value >= 0 && value <= 4,
        ) ||
        processScore !==
          (100 * (run.process.toolAccuracy.score + run.process.pathEfficiency.score)) / 8)
    )
      reasons.push("Process dimensions do not match total");
    if (tokenScore === null) reasons.push("Complete input/output Token totals unavailable");
    if (latencyScore === null) reasons.push("Agent latency unavailable");
  }
  const score = reasons.length
    ? null
    : run.acceptance.status === "failed"
      ? 0
      : 100 * COMPOSITE_POLICY.correctnessWeight +
        COMPOSITE_POLICY.processWeight * processScore! +
        COMPOSITE_POLICY.resourceWeight * resourceScore!;
  return { score, resourceScore, tokenScore, latencyScore, tokens, reasons };
}

/** Never publish a partial mean as the complete composite score. */
export function completeMean(values: (number | null)[]) {
  return values.length && values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + value!, 0) / values.length
    : null;
}
