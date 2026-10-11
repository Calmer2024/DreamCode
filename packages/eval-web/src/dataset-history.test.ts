import { describe, expect, it } from "vitest";
import type { DatasetJob } from "./dataset-types";
import { evaluationHistory } from "./dataset-history";

const job = (
  createdAt: string,
  agent?: DatasetJob["agent"],
  completed = 0,
  status: DatasetJob["status"] = "completed",
) => ({ createdAt, agent, completed, status, repeats: 3, total: 60 }) as DatasetJob;
describe("evaluation history charts", () => {
  it("counts batches once and uses Shanghai calendar dates at the range boundary", () => {
    const report = evaluationHistory(
      [
        job("2026-10-04T15:59:59Z", "pi", 60),
        job("2026-10-04T16:00:00Z", "pi", 12),
        job("2026-10-10T23:59:59Z", "claude-code", 3, "interrupted"),
        job("2026-10-11T01:00:00Z", undefined, 2, "running"),
        job("2026-10-11T03:00:00Z", "dsh", 60),
      ],
      7,
      Date.parse("2026-10-11T02:00:00Z"),
    );
    expect(report.batches).toBe(3);
    expect(report.executions).toBe(17);
    expect(report.frameworks.find((item) => item.id === "pi")).toMatchObject({
      batches: 1,
      executions: 12,
    });
    expect(report.frameworks.find((item) => item.id === "dreamcode")?.batches).toBe(1);
    expect(report.daily[0]).toEqual({ date: "2026-10-05", count: 1 });
    expect(report.daily.at(-1)).toEqual({ date: "2026-10-11", count: 2 });
    expect(report.daily.reduce((sum, item) => sum + item.count, 0)).toBe(report.batches);
    expect(report.statuses.find((item) => item.id === "interrupted")?.count).toBe(1);
  });
  it("keeps zero days and framework bars for empty history", () => {
    const report = evaluationHistory([], 30, Date.parse("2026-10-11T02:00:00Z"));
    expect(report.daily).toHaveLength(30);
    expect(report.frameworks).toHaveLength(5);
    expect(report.batches).toBe(0);
    expect(report.daily.every((item) => item.count === 0)).toBe(true);
  });
});
