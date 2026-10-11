import type { DatasetJob } from "./dataset-types";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayKey = (time: number) => dayFormatter.format(time);

/** A submitted batch counts once, regardless of cases or repetitions. */
export function evaluationHistory(jobs: DatasetJob[], days: number, now = Date.now()) {
  const today = Date.parse(`${dayKey(now)}T00:00:00+08:00`);
  const start = today - (days - 1) * 86400000;
  const selected = jobs.filter((job) => {
    const created = Date.parse(job.createdAt);
    return created >= start && created <= now;
  });
  const frameworks = ["dreamcode", "claude-code", "pi", "opencode", "dsh"].map((id) => ({
    id,
    batches: selected.filter((job) => (job.agent ?? "dreamcode") === id).length,
    executions: selected
      .filter((job) => (job.agent ?? "dreamcode") === id)
      .reduce((sum, job) => sum + job.completed, 0),
  }));
  const counts = new Map<string, number>();
  for (const job of selected) {
    const date = dayKey(Date.parse(job.createdAt));
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const daily = Array.from({ length: days }, (_, index) => {
    const date = dayKey(start + index * 86400000);
    return {
      date,
      count: counts.get(date) ?? 0,
    };
  });
  const statuses = ["completed", "running", "queued", "interrupted", "error"].map((id) => ({
    id,
    count: selected.filter((job) => job.status === id).length,
  }));
  return {
    frameworks,
    daily,
    statuses,
    batches: selected.length,
    executions: frameworks.reduce((sum, item) => sum + item.executions, 0),
  };
}
