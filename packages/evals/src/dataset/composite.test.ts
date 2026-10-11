import { describe, it, expect } from "vitest";
import { scoreExecution, COMPOSITE_POLICY } from "./composite.js";
import { summarize, compareAgents } from "./scoring.js";
import type { RunRecord } from "./types.js";

function run(id = "a", caseId = "A"): RunRecord {
  const dimension = { score: 4, reason: "Observed", evidence: ["E1"] };
  return {
    version: 1,
    id,
    caseId,
    startedAt: "2026-10-10",
    missingEvidence: [],
    evidence: [],
    acceptance: { status: "passed", checks: [] },
    execution: { status: "completed" },
    process: {
      toolAccuracy: dimension,
      pathEfficiency: dimension,
      score: 100,
      judgeVersion: "process-v3",
    },
    engineering: {
      inputTokens: 80_000,
      outputTokens: 20_000,
      cachedInputTokens: 60_000,
      agentLatencyMs: 600_000,
      costUsd: null,
      usageCoverage: { requests: 2, reported: 2 },
    },
  };
}
describe("composite scoring v1", () => {
  it("allows controlled comparisons across frameworks while preserving budget and Judge requirements", () => {
    const a = run("a"), b = run("b");
    const configuration = { executionProtocolVersion: "dataset-run-v5", datasetVersion: "test", datasetDigest: "same",
      model: "mimo", provider: "mimo", judgeModel: "judge", timeoutMs: 1000, maxModelRequests: 10, workerSha256: "same-worker" };
    a.configuration = { ...configuration, agent: "dreamcode", agentVersion: "workspace", modelProtocol: "dreamcode-provider" };
    b.configuration = { ...configuration, agent: "claude-code", agentVersion: "2.1", modelProtocol: "anthropic", agentInstallationDigest: "cli-lock" };
    const policy = { model: "judge", version: "process-v3", promptDigest: "same", evidenceProtocolVersion: "same", maxRequests: 32,
      maxFormatRepairs: 2, previewCharacters: 4000, readCharacters: 24000, parameters: "defaults" };
    a.processJudgePolicy = policy; b.processJudgePolicy = policy;
    expect(compareAgents({ DreamCode: [a], Claude: [b] }, ["A"]).comparable).toBe(true);
    b.configuration.timeoutMs = 2000;
    expect(compareAgents({ DreamCode: [a], Claude: [b] }, ["A"]).comparable).toBe(false);
  });
  it("uses total input plus output without double-counting cached input or requiring price", () => {
    expect(scoreExecution(run())).toMatchObject({ score: 100, tokens: 100_000, tokenScore: 100 });
    const expensive = run();
    expensive.engineering.costUsd = 100;
    expect(scoreExecution(expensive).score).toBe(100);
    const twice = run();
    twice.engineering.inputTokens = 180_000;
    twice.engineering.agentLatencyMs = 1_200_000;
    expect(scoreExecution(twice)).toMatchObject({ score: 95, tokenScore: 50, latencyScore: 50 });
  });
  it("gates failed/timeout tasks without changing their process scores", () => {
    const failed = run();
    failed.acceptance.status = "failed";
    failed.execution = { status: "timeout" };
    failed.engineering.inputTokens = null;
    expect(scoreExecution(failed).score).toBe(0);
    expect(failed.process?.score).toBe(100);
    failed.execution = { status: "infrastructure_error" };
    expect(scoreExecution(failed).score).toBeNull();
  });
  it("does not reward missing, partial or invalid evidence", () => {
    for (const mutate of [
      (r: RunRecord) => {
        r.engineering.inputTokens = null;
      },
      (r: RunRecord) => {
        r.engineering.usageCoverage.reported = 1;
      },
      (r: RunRecord) => {
        r.engineering.agentLatencyMs = NaN;
      },
      (r: RunRecord) => {
        r.process = null;
      },
      (r: RunRecord) => {
        r.missingEvidence = ["missing output"];
      },
      (r: RunRecord) => {
        r.acceptance.status = "error";
      },
      (r: RunRecord) => {
        r.process!.score = 90;
      },
    ]) {
      const value = run();
      mutate(value);
      expect(scoreExecution(value).score).toBeNull();
      expect(scoreExecution(value).reasons.length).toBeGreaterThan(0);
    }
  });
  it("caps zero/low consumption, averages repetitions before cases and preserves version", () => {
    const a1 = run("a1"),
      a2 = run("a2"),
      b = run("b", "B");
    a2.acceptance.status = "failed";
    b.engineering.inputTokens = 0;
    b.engineering.outputTokens = 0;
    b.engineering.agentLatencyMs = 0;
    const report = summarize([a1, a2, b], ["A", "B"], {
      A: { scenario: "bugfix" },
      B: { scenario: "review" },
    });
    expect(report.compositeScore).toBe(75);
    expect(report.scenarios?.bugfix?.compositeScore).toBe(50);
    expect(report.scoringPolicy).toEqual(COMPOSITE_POLICY);
    expect(summarize([a1, a2, b], ["A", "B"], undefined, 2).compositeScore).toBeNull();
    expect(summarize([a1], ["A", "B"]).compositeScore).toBeNull();
    b.engineering.outputTokens = null;
    expect(summarize([a1, a2, b], ["A", "B"]).compositeScore).toBeNull();
    expect(compareAgents({ first: [a1], second: [b] }, ["A", "B"]).compositeComparable).toBe(false);
  });
});
