// Re-evaluate immutable evidence with the new policy; never re-run Agents or overwrite scores.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { reevaluateProcess, savedModel } from "../src/dataset/index.js";
import type { RunRecord } from "../src/dataset/types.js";
const root = path.resolve("evals/runs/dataset");
const audit = JSON.parse(await readFile(path.join(root, "judge-audit.json"), "utf8"));
const selected = audit.records.filter(
  (r: any) =>
    r.error || r.citationProblems.length || r.runId === "1c7f231c-9058-4abd-8e12-61c5026b36cb",
);
selected.sort((a: any, b: any) => Number(Boolean(b.error)) - Number(Boolean(a.error)));
const model = process.argv[2] ?? "mimo-v2.5-pro",
  provider = await savedModel(model);
const directory = path.join(root, `judge-recheck-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const results: any[] = [];
for (const source of selected) {
  const file = path.resolve(source.file),
    before = await readFile(file);
  if (!file.startsWith(`${root}${path.sep}`)) throw Error("Source outside dataset runs");
  const record = JSON.parse(before.toString()) as RunRecord;
  const repetitions = source.error ? 2 : 1;
  for (let repeat = 1; repeat <= repetitions; repeat++) {
    let rounds = 0;
    const result = await reevaluateProcess(record, provider, model, 600000, (event) => {
      if (event.type === "judge.request") rounds++;
      const data = event.data as { toolCalls?: Array<{ name: string }>; messages?: unknown[] };
      console.log(
        JSON.stringify({
          caseId: record.caseId,
          agent: source.agent,
          repeat,
          judgeRound: rounds,
          phase: event.type,
          tools: data.toolCalls?.map((c) => c.name),
          contextCharacters: data.messages ? JSON.stringify(data.messages).length : undefined,
        }),
      );
    });
    const output = path.join(root, `process-${record.caseId}-${randomUUID()}.json`);
    await writeFile(output, JSON.stringify(result, null, 2), { flag: "wx" });
    const item = {
      source: source.file,
      caseId: record.caseId,
      runId: record.id,
      agent: source.agent,
      repeat,
      originalScore: record.process?.score ?? null,
      originalError: record.processError ?? null,
      sourceDigest: createHash("sha256").update(before).digest("hex"),
      output: path.relative(process.cwd(), output).replaceAll("\\", "/"),
      status: result.status,
      process: result.process,
      policy: result.policy,
      metrics: result.metrics,
      error: result.error,
    };
    results.push(item);
    await writeFile(
      path.join(directory, "report.json"),
      JSON.stringify({ model, status: "running", results }, null, 2),
    );
    console.log(
      JSON.stringify({
        caseId: item.caseId,
        agent: item.agent,
        repeat,
        status: item.status,
        score: item.process?.score,
        error: item.error,
        output: item.output,
      }),
    );
  }
  if (!before.equals(await readFile(file)))
    throw Error("Source evidence changed during re-evaluation");
}
const failed = results.filter((r) => r.status !== "graded");
const report = {
  model,
  status: "completed",
  sourceRecords: selected.length,
  evaluations: results.length,
  graded: results.length - failed.length,
  failed: failed.length,
  originalsUnchanged: true,
  results,
};
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    directory,
    sourceRecords: report.sourceRecords,
    evaluations: report.evaluations,
    graded: report.graded,
    failed: report.failed,
  }),
);
if (failed.length) process.exitCode = 1;
