import { describe, it, expect } from "vitest";
import type { ModelProvider } from "@dreamcode/shared";
import { summarize, compareAgents } from "./scoring.js";
import { reevaluateProcess, traceJudgeProvider, processJudgePolicy } from "./reevaluate.js";
import type { RunRecord } from "./types.js";

function run(
  id: string,
  caseId: string,
  status: "passed" | "failed" | "error",
  rating = 4,
  model = "agent",
): RunRecord {
  const dimension = { score: rating, reason: "Observed operations", evidence: ["E1"] };
  return {
    version: 1,
    id,
    caseId,
    startedAt: "2026-10-10",
    configuration: {
      datasetVersion: "1",
      datasetDigest: "fixed",
      executionProtocolVersion: "dataset-run-v4",
      model,
      provider: "test",
      judgeModel: "judge",
      timeoutMs: 1000,
      maxModelRequests: 10,
    },
    evidence: [{ id: "E1", type: "tool.completed", data: { tool: "bash", exitCode: 0 } }],
    missingEvidence: [],
    execution: { status: "completed" },
    processJudgePolicy: processJudgePolicy("judge"),
    acceptance: { status, checks: [] },
    process: {
      toolAccuracy: dimension,
      pathEfficiency: dimension,
      score: rating * 25,
      judgeVersion: "process-v3",
    },
    engineering: {
      agentLatencyMs: 100,
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 0,
      costUsd: null,
      usageCoverage: { requests: 1, reported: 1 },
      toolCallCount: 1,
      toolErrorCount: 0,
    },
  };
}
describe("scoring closure", () => {
  it("keeps case weights across repetitions, scenarios and outcome process groups", () => {
    const report = summarize(
      [run("a1", "A", "passed"), run("a2", "A", "passed", 2), run("b", "B", "failed", 1)],
      ["A", "B"],
      { A: { scenario: "bugfix" }, B: { scenario: "review" } },
    );
    expect(report.successRate).toBe(0.5);
    expect(report.scenarios?.bugfix?.successRate).toBe(1);
    expect(report.scenarios?.review?.successRate).toBe(0);
    expect(report.processByOutcome.successful.caseMean).toBe(75);
    expect(report.processByOutcome.failed.caseMean).toBe(25);
    expect(report.repetitions.balanced).toBe(false);
    expect(report.coverageComplete).toBe(false);
    expect(report.engineering.consumptionPerSuccess.inputTokens).toBe(15);
    expect(report.engineering.allRuns.costUsd.total).toBeNull();
  });
  it("separates timeout, evaluator failures, missing process and unknown resources", () => {
    const timeout = run("a", "A", "failed");
    timeout.execution = { status: "timeout" };
    const error = run("b", "B", "error");
    error.process = null;
    error.processError = "Malformed Judge JSON";
    error.acceptance.error = "Container unavailable";
    error.missingEvidence = ["Missing output"];
    const report = summarize([timeout, error], ["A", "B"]);
    expect(report.successRate).toBe(0);
    expect(report.outcomes.timeout).toBe(1);
    expect(report.outcomes.evaluatorErrors).toBe(1);
    expect(report.missing[1]?.process).toBe("Malformed Judge JSON");
    expect(report.missing[1]?.acceptance).toBe("Container unavailable");
    expect(report.engineering.consumptionPerSuccess.inputTokens).toBeNull();
  });
  it("compares different models only with matching scope, repetitions and complete evidence", () => {
    const left = [run("a", "A", "passed")],
      right = [run("b", "A", "failed", 3, "other")];
    expect(compareAgents({ left, right }, ["A"]).comparable).toBe(true);
    expect(compareAgents({ left, right }, ["A"]).ranking).toEqual([
      { agent: "left", score: 100, rank: 1 },
      { agent: "right", score: 0, rank: 2 },
    ]);
    const unknownTokens = structuredClone(right[0]!);
    unknownTokens.id = "unknown";
    unknownTokens.acceptance.status = "passed";
    unknownTokens.engineering.inputTokens = null;
    const partial = compareAgents({ left, unknown: [unknownTokens] }, ["A"]);
    expect(partial.comparable).toBe(true);
    expect(partial.compositeComparable).toBe(false);
    expect(partial.ranking).toBeNull();
    expect(
      compareAgents({ left, right: [...right, run("b2", "A", "passed", 4, "other")] }, ["A"])
        .comparable,
    ).toBe(false);
    expect(compareAgents({ left, right }, ["A", "B"]).comparable).toBe(false);
    expect(compareAgents({ left, reused: left }, ["A"]).comparable).toBe(false);
    right[0]!.configuration!.timeoutMs = 2000;
    expect(compareAgents({ left, right }, ["A"]).reasons.join(" ")).toContain("budget");
  });
  it("rejects corrupt totals and invalid numeric grades", () => {
    const record = run("a", "A", "passed");
    record.process!.score = 99;
    expect(() => summarize([record], ["A"])).toThrow("total");
    record.process!.toolAccuracy.score = Number.NaN;
    expect(() => summarize([record], ["A"])).toThrow("dimension");
  });
  it("reevaluates immutable evidence with metered public transcripts", async () => {
    const provider: ModelProvider = {
      name: "test",
      async *stream() {
        yield { type: "reasoning_delta", text: "Private reasoning" };
        yield {
          type: "text_delta",
          text: JSON.stringify({
            toolAccuracy: { score: 3, reason: "Recovered error", evidence: ["P1"] },
            pathEfficiency: { score: 4, reason: "Useful progress", evidence: ["P1"] },
          }),
        };
      },
    };
    const record = run("a", "A", "passed"),
      before = JSON.stringify(record);
    const result = await reevaluateProcess(record, provider, "judge", 1000);
    expect(JSON.stringify(record)).toBe(before);
    expect(result.process?.score).toBe(87.5);
    expect(result.metrics.usageCoverage.requests).toBe(1);
    expect(result.metrics.inputTokens).toBeNull();
    expect(result.transcript).toHaveLength(2);
    expect(JSON.stringify(result.transcript)).not.toContain("Private reasoning");
    record.evidence = [{ id: "T", type: "task", data: "Answer without tools" }];
    expect((await reevaluateProcess(record, provider, "judge", 1000)).status).toBe(
      "not_applicable",
    );
  });
  it("persists failed Judge calls without inventing scores", async () => {
    const provider: ModelProvider = {
      name: "test",
      async *stream() {
        throw Error("Provider unavailable");
        yield { type: "text_delta", text: "" };
      },
    };
    const result = await reevaluateProcess(run("a", "A", "passed"), provider, "judge", 1000);
    expect(result.status).toBe("judge_error");
    expect(result.errorKind).toBe("model_error");
    expect(result.process).toBeNull();
    expect(result.transcript[1]?.data).toMatchObject({ error: "Error: Provider unavailable" });
    const traces: unknown[] = [];
    const traced = traceJudgeProvider(provider, (item) => traces.push(item));
    try {
      for await (const _event of traced.stream({
        model: "judge",
        tools: [],
        messages: [],
        mode: "read-only",
        workspaceRoot: "",
      })) {
      }
    } catch {}
    expect(traces).toHaveLength(2);
  });
  it("distinguishes invalid Judge output from missing evidence without inventing a score", async () => {
    let requests = 0;
    const provider: ModelProvider = {
      name: "test",
      async *stream() {
        requests++;
        yield { type: "text_delta", text: "not JSON" };
      },
    };
    const result = await reevaluateProcess(run("a", "A", "passed"), provider, "judge", 1000);
    expect(result.errorKind).toBe("output_format");
    expect(result.process).toBeNull();
    expect(requests).toBe(3);
    const missing = run("b", "B", "failed");
    missing.missingEvidence = ["Missing tool output"];
    expect((await reevaluateProcess(missing, provider, "judge", 1000)).status).toBe(
      "insufficient_evidence",
    );
    expect(requests).toBe(3);
  });
});
