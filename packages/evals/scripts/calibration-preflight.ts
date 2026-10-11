/** Recheck candidate deterministic acceptance against original and known corrected workspaces. */
import { cp, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDataset } from "../src/dataset/loader.js";
import { runProgram } from "../src/dataset/acceptance.js";
const dataset = await loadDataset(path.resolve("evals/dataset-candidate-2026-10-10"));
const directory = path.resolve(`evals/runs/dataset/preflight-${randomUUID().slice(0, 8)}`);
await mkdir(directory, { recursive: true });
const results: unknown[] = [];
const selected = process.argv.slice(2);
for (const entry of dataset.cases) {
  if (selected.length && !selected.includes(entry.value.id)) continue;
  if (!entry.acceptance.program) continue;
  const root = path.join(directory, entry.value.id);
  await mkdir(root);
  const reference = path.join(root, "reference");
  let golden = path.resolve("evals/dataset/preparation", entry.value.id, "reference");
  const revised = path.resolve(
    "evals/dataset-candidate-2026-10-10/preparation",
    entry.value.id,
    "reference",
  );
  try {
    await access(revised);
    golden = revised;
  } catch {}
  const replaced: string[] = [];
  for (const name of [".git", "release"]) {
    try {
      await access(path.join(golden, name));
      replaced.push(name);
    } catch {}
  }
  // Complete terminal-state snapshots preserve deletions too (obsolete artifacts/MERGE_HEAD).
  await cp(entry.workspace, reference, {
    recursive: true,
    filter: (file) => !replaced.some((name) => file === path.join(entry.workspace, name)),
  });
  await cp(golden, reference, { recursive: true });
  if (entry.value.id === "CASE-001") {
    // New acceptance requires a real added regression; use the independently verified control.
    await cp(
      path.resolve(
        "evals/runs/dataset/diagnosis-case001-14aa8683-b76f-486c-b366-748361891e76/calibration-positive",
      ),
      reference,
      { recursive: true },
    );
  }
  const baseline = await runProgram(entry, entry.workspace);
  const corrected = await runProgram(entry, reference);
  const result = { caseId: entry.value.id, baseline: baseline.result, reference: corrected.result };
  results.push(result);
  await writeFile(
    path.join(root, "control.json"),
    JSON.stringify({ ...result, baselineOutput: baseline, referenceOutput: corrected }, null, 2),
  );
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify({ status: "running", results }, null, 2),
  );
  console.log(
    JSON.stringify({
      caseId: entry.value.id,
      baseline: baseline.result.status,
      reference: corrected.result.status,
    }),
  );
}
await writeFile(
  path.join(directory, "report.json"),
  JSON.stringify({ status: "completed", results }, null, 2),
);
console.log(directory);
