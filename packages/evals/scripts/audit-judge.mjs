// Read public Judge outcomes without re-running Agents or models.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve("evals/runs/dataset");
const files = [];
for (const dir of await readdir(root, { withFileTypes: true })) {
  if (!dir.isDirectory() || dir.name === "web-jobs") continue;
  if (dir.name.startsWith("CASE-")) files.push(path.join(root, dir.name, "record.json"));
  if (dir.name.startsWith("web-"))
    for (const sub of await readdir(path.join(root, dir.name), { withFileTypes: true }))
      if (sub.isDirectory() && sub.name.startsWith("CASE-"))
        files.push(path.join(root, dir.name, sub.name, "record.json"));
}
const records = [];
for (const file of files) {
  const run = await readFile(file, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (!run) continue;
  const ids = new Set(run.evidence.map((e) => e.id));
  const problems = [];
  for (const dimension of ["toolAccuracy", "pathEfficiency"]) {
    const value = run.process?.[dimension];
    if (!value) continue;
    const refs = [...new Set(value.reason.match(/\bE\d+\b/g) ?? [])];
    const unknown = refs.filter((id) => !ids.has(id));
    const uncited = refs.filter((id) => ids.has(id) && !value.evidence.includes(id));
    if (unknown.length || uncited.length) problems.push({ dimension, unknown, uncited });
  }
  records.push({
    file: path.relative(process.cwd(), file).replaceAll("\\", "/"),
    runId: run.id,
    caseId: run.caseId,
    agent: run.configuration?.agent ?? "dreamcode",
    version: run.processJudgePolicy?.version ?? run.process?.judgeVersion ?? null,
    status: run.processEvaluation?.status ?? (run.process?.score == null ? "ungraded" : "graded"),
    score: run.process?.score ?? null,
    error: run.processError ?? null,
    citationProblems: problems,
    judgeRequests: run.evidence.filter((e) => e.type === "judge.request").length,
    evidenceItems: run.evidence.length,
  });
}
const report = {
  generatedAt: new Date().toISOString(),
  records,
  total: records.length,
  ungraded: records.filter((r) => r.score == null).length,
  citationProblems: records.filter((r) => r.citationProblems.length).length,
};
const output = path.join(root, "judge-audit.json");
await writeFile(output, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      output,
      total: report.total,
      ungraded: report.ungraded,
      citationProblems: report.citationProblems,
      affected: records
        .filter((r) => r.error || r.citationProblems.length)
        .map((r) => ({
          caseId: r.caseId,
          runId: r.runId,
          error: r.error,
          citationProblems: r.citationProblems,
        })),
    },
    null,
    2,
  ),
);
