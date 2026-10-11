/** Current-case ledger: older passing revisions never silently qualify a changed task. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadDataset } from "../src/dataset/loader.js";
import { datasetDigest } from "../src/dataset/integrity.js";
const candidate = path.resolve("evals/dataset-candidate-2026-10-10");
const runs = path.resolve("evals/runs/dataset");
const dataset = await loadDataset(candidate);
const selected = new Set(process.argv.slice(2));
if ([...selected].some((id) => !dataset.cases.some((e) => e.value.id === id)))
  throw Error("Unknown case selection");
let previous: any = null;
try {
  previous = JSON.parse(await readFile(path.join(runs, "calibration-readiness.json"), "utf8"));
} catch {}
const attempts: any[] = [];
for (const directory of await readdir(runs, { withFileTypes: true })) {
  if (!directory.isDirectory() || !directory.name.startsWith("calibration-")) continue;
  let report: any;
  const root = path.join(runs, directory.name);
  try {
    report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
  } catch {
    continue;
  }
  if (report.purpose !== "dataset-calibration-not-benchmark") continue;
  for (const trial of report.completed ?? []) {
    if (selected.size && !selected.has(trial.caseId)) continue;
    try {
      const record = JSON.parse(await readFile(trial.record, "utf8"));
      const frozen = path.join(trial.trial, "dataset");
      const entry = (await loadDataset(frozen)).cases[0]!;
      const caseDigest = (await datasetDigest(entry.root)).digest;
      let review: any = null;
      for (const file of [
        path.join(trial.trial, "engineering-review.json"),
        path.join(root, "engineering-review.json"),
      ]) {
        try {
          const value = JSON.parse(await readFile(file, "utf8"));
          if (value.caseId === trial.caseId) {
            review = value;
            break;
          }
        } catch {}
      }
      attempts.push({
        caseId: trial.caseId,
        caseDigest,
        runtime: entry.runtime,
        qualified: trial.qualified,
        record: trial.record,
        startedAt: record.startedAt,
        wallMs: trial.wallMs,
        review,
        execution: record.execution,
        acceptance: record.acceptance.status,
        report: path.join(root, "report.json"),
      });
    } catch {
      attempts.push({
        caseId: trial.caseId,
        qualified: false,
        error: trial.error ?? "Incomplete trial files",
        report: path.join(root, "report.json"),
      });
    }
  }
}
const cases = [];
for (const entry of dataset.cases) {
  if (selected.size && !selected.has(entry.value.id)) {
    const old =
      previous?.datasetVersion === dataset.version
        ? previous.cases?.find((c: any) => c.id === entry.value.id)
        : null;
    cases.push(old ?? { id: entry.value.id, status: "pending-current-revision", attempts: [] });
    continue;
  }
  const digest = (await datasetDigest(entry.root)).digest;
  const history = attempts.filter((a) => a.caseId === entry.value.id);
  const applicable = history.filter(
    (a) => a.caseDigest === digest && JSON.stringify(a.runtime) === JSON.stringify(entry.runtime),
  );
  const approved = applicable.filter((a) => a.qualified && a.review?.accepted === true);
  const passed = applicable.filter((a) => a.qualified);
  const status = approved.length
    ? "verified"
    : passed.some((a) => a.review?.accepted === false)
      ? "engineering-rejected"
      : passed.length
        ? "needs-engineering-review"
        : applicable.length
          ? "failed"
          : "pending-current-revision";
  cases.push({ id: entry.value.id, status, caseDigest: digest, attempts: history });
}
const verified = cases.filter((c) => c.status === "verified").length;
const output = {
  purpose: "dataset-authoring-readiness-not-ranking",
  updatedAt: new Date().toISOString(),
  datasetVersion: dataset.version,
  total: cases.length,
  verified,
  fullAudit: selected.size === 0,
  ready: !selected.size && verified === 60,
  counts: Object.fromEntries(
    [...new Set(cases.map((c) => c.status))].map((s) => [
      s,
      cases.filter((c) => c.status === s).length,
    ]),
  ),
  cases,
};
await writeFile(path.join(runs, "calibration-readiness.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ ...output, cases: undefined }));
