import { describe, expect, it } from "vitest";
import { batchCases, batchElapsed, caseElapsed, duration } from "./dataset-batches";
import type { DatasetJob, DatasetRun } from "./dataset-types";

const run = (key: string, caseId: string) => ({ key, caseId }) as DatasetRun;
const job = (extra: Partial<DatasetJob> = {}) =>
  ({
    caseIds: ["A", "B"],
    repeats: 2,
    records: ["a2", "b1"],
    errors: [],
    status: "running",
    ...extra,
  }) as DatasetJob;

describe("batch record hierarchy", () => {
  it("times the current case independently and renders seconds without inventing missing times", () => {
    const active = job({
      startedAt: "2026-10-10T00:00:00Z",
      currentCase: "A",
      currentCaseStartedAt: "2026-10-10T00:02:00Z",
    });
    const now = Date.parse("2026-10-10T00:04:30Z");
    expect(duration(batchElapsed(active, now))).toBe("4 min 30 s");
    expect(duration(caseElapsed(active, now))).toBe("2 min 30 s");
    expect(duration(caseElapsed(job(), now))).toBe("_");
    expect(caseElapsed({ ...active, status: "completed" }, now)).toBeNull();
  });
  it("preserves selected scope, numbered failures, pending attempts and missing evidence", () => {
    const groups = batchCases(
      job({
        attempts: [
          { caseId: "A", repetition: 1, error: "runtime failed" },
          { caseId: "A", repetition: 2, key: "a2" },
          { caseId: "B", repetition: 1, key: "b1" },
        ],
      }),
      [run("a2", "A"), run("outside", "C")],
    );
    expect(groups.map((group) => group.caseId)).toEqual(["A", "B"]);
    expect(groups[0]!.attempts[0]!.error).toBe("runtime failed");
    expect(groups[0]!.attempts[1]!.run?.key).toBe("a2");
    expect(groups[1]!.attempts[0]!.missingRecord).toBe(true);
    expect(groups[1]!.attempts[1]).toMatchObject({
      run: undefined,
      error: undefined,
      missingRecord: false,
    });
  });
  it("reads existing batch manifests without shifting a failed repetition onto a later record", () => {
    const groups = batchCases(job({ errors: [{ caseId: "A", repetition: 1, reason: "failed" }] }), [
      run("a2", "A"),
      run("b1", "B"),
    ]);
    expect(groups[0]!.attempts[0]!.error).toBe("failed");
    expect(groups[0]!.attempts[1]!.run?.key).toBe("a2");
  });
  it("does not infer wall time from queue creation or restart interruption", () => {
    const startedAt = "2026-10-10T00:01:00Z",
      finishedAt = "2026-10-10T00:03:00Z";
    expect(
      batchElapsed(
        job({ createdAt: "2026-10-10T00:00:00Z", startedAt, finishedAt, status: "completed" }),
      ),
    ).toBe(120000);
    expect(batchElapsed(job({ status: "completed" }))).toBeNull();
    expect(batchElapsed(job({ startedAt, finishedAt, status: "interrupted" }))).toBeNull();
    expect(batchElapsed(job({ startedAt }), Date.parse(finishedAt))).toBe(120000);
  });
});
