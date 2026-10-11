#!/usr/bin/env node
import path from "node:path";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadDataset } from "./loader.js";
import { runCase, savedModel } from "./runner.js";
import { runProgram } from "./acceptance.js";
import { summarize, compareAgents } from "./scoring.js";
import { reevaluateProcess } from "./reevaluate.js";
import type { RunRecord } from "./types.js";
import { freezeIntegrity, verifyIntegrity } from "./integrity.js";
import { admissionReport } from "./admission.js";
import {
  isDatasetAgent,
  readAgentInstallation,
  savedAgentEndpoint,
  datasetAgentCatalog,
} from "./agents.js";
const [command, ...rawArgs] = process.argv.slice(2);
const agentIndex = rawArgs.indexOf("--agent");
const agent = agentIndex < 0 ? "dreamcode" : rawArgs[agentIndex + 1];
const args =
  agentIndex < 0
    ? rawArgs
    : rawArgs.filter((_, index) => index !== agentIndex && index !== agentIndex + 1);
const root = path.resolve("evals/dataset");
try {
  if (!isDatasetAgent(agent))
    throw Error("--agent requires dreamcode | claude-code | pi | dsh | opencode");
  const externalFor = async (model: string) =>
    agent === "dreamcode"
      ? undefined
      : {
          agent,
          installation: await readAgentInstallation(process.cwd()),
          endpoint: await savedAgentEndpoint(model, agent),
        };
  const dataset = await loadDataset(root);
  const metadata = Object.fromEntries(
    dataset.cases.map((entry) => [entry.value.id, entry.value.metadata ?? {}]),
  );
  const readRecord = async (file: string): Promise<RunRecord> => {
    const record = JSON.parse(await readFile(path.resolve(file), "utf8")) as RunRecord;
    if (
      record.version !== 1 ||
      typeof record.id !== "string" ||
      typeof record.caseId !== "string" ||
      !Array.isArray(record.evidence) ||
      !Array.isArray(record.missingEvidence) ||
      !["passed", "failed", "error"].includes(record.acceptance?.status) ||
      !record.engineering
    )
      throw Error(`Invalid execution record: ${file}`);
    if (new Set(record.evidence.map((item) => item.id)).size !== record.evidence.length)
      throw Error(`Duplicate evidence IDs: ${file}`);
    return record;
  };
  if (command === "agents")
    console.log(JSON.stringify(await datasetAgentCatalog(process.cwd()), null, 2));
  else if (command === "freeze") console.log(await freezeIntegrity(root));
  else if (command === "quality") {
    const result = await admissionReport(root, dataset.cases);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  } else if (command === "validate")
    console.log(
      JSON.stringify(
        {
          version: dataset.version,
          integrity: await verifyIntegrity(root),
          cases: dataset.cases.length,
          ids: dataset.cases.map((entry) => entry.value.id),
        },
        null,
        2,
      ),
    );
  else if (command === "accept") {
    const entry = dataset.cases.find((entry) => entry.value.id === args[0]);
    if (!entry || !args[1]) throw Error("Usage: accept CASE-ID WORKSPACE");
    const output = await runProgram(entry, path.resolve(args[1]));
    console.log(JSON.stringify(output, null, 2));
    if (output.result.status !== "passed") process.exitCode = 1;
  } else if (command === "run") {
    const integrity = await verifyIntegrity(root);
    const entry = dataset.cases.find((entry) => entry.value.id === args[0]);
    if (!entry) throw Error("Usage: run CASE-ID [MODEL]");
    const model = args[1] ?? "mimo-v2.5-pro",
      provider = await savedModel(model);
    const budget = JSON.parse(await readFile(path.join(root, "execution.json"), "utf8"));
    if (
      !Number.isSafeInteger(budget.timeoutMs) ||
      budget.timeoutMs <= 0 ||
      !Number.isSafeInteger(budget.maxModelRequests) ||
      budget.maxModelRequests <= 0
    )
      throw Error("Invalid execution budget");
    const output = await runCase(entry, {
      directory: path.resolve("evals/runs/dataset"),
      worker: path.resolve("packages/evals/dist-dataset-container/worker.mjs"),
      provider,
      model,
      external: await externalFor(model),
      judge: { provider, model },
      dataset: { version: dataset.version, digest: integrity.digest },
      ...budget,
      onProgress: (event) => {
        if (event.type === "tool.completed") {
          const payload = event.payload as { tool?: string; status?: string };
          console.error(
            JSON.stringify({ event: event.type, tool: payload.tool, status: payload.status }),
          );
        }
      },
    });
    console.log(
      JSON.stringify(
        {
          directory: output.directory,
          acceptance: output.record.acceptance,
          process: output.record.process,
          engineering: output.record.engineering,
        },
        null,
        2,
      ),
    );
    if (output.record.acceptance.status !== "passed") process.exitCode = 1;
  } else if (command === "run-all") {
    const model = args[0] ?? "mimo-v2.5-pro",
      repeats = Number(args[1] ?? 1);
    if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10)
      throw Error("Agent repeats must be 1..10");
    const admission = await admissionReport(root, dataset.cases);
    if (!admission.ready) throw Error("Dataset admission checks did not pass");
    const integrity = await verifyIntegrity(root),
      provider = await savedModel(model);
    const budget = JSON.parse(await readFile(path.join(root, "execution.json"), "utf8"));
    if (
      !Number.isSafeInteger(budget.timeoutMs) ||
      budget.timeoutMs <= 0 ||
      !Number.isSafeInteger(budget.maxModelRequests) ||
      budget.maxModelRequests <= 0
    )
      throw Error("Invalid execution budget");
    const directory = path.resolve("evals/runs/dataset", `benchmark-${randomUUID()}`);
    const external = await externalFor(model);
    await mkdir(directory, { recursive: true });
    const runtimeDirectory = path.join(directory, "batch-runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const worker = path.join(runtimeDirectory, "worker.mjs");
    await copyFile(path.resolve("packages/evals/dist-dataset-container/worker.mjs"), worker);
    await copyFile(
      path.resolve("packages/evals/dist-dataset-container/dsh-driver.mjs"),
      path.join(runtimeDirectory, "dsh-driver.mjs"),
    );
    const records: RunRecord[] = [],
      completed: { caseId: string; repetition: number; record: string }[] = [],
      errors: { caseId: string; repetition: number; error: string }[] = [];
    const persist = async (status: string) => {
      const summary = summarize(
        records,
        dataset.cases.map((entry) => entry.value.id),
        metadata,
        repeats,
      );
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(
          {
            status,
            model,
            agent,
            repeats,
            datasetVersion: dataset.version,
            datasetDigest: integrity.digest,
            budget,
            caseIds: dataset.cases.map((entry) => entry.value.id),
            completed,
            errors,
          },
          null,
          2,
        ),
      );
      await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2));
      return summary;
    };
    await persist("running");
    for (const entry of dataset.cases)
      for (let repetition = 1; repetition <= repeats; repetition++) {
        try {
          const output = await runCase(entry, {
            directory,
            worker,
            provider,
            model,
            external,
            judge: { provider, model },
            dataset: { version: dataset.version, digest: integrity.digest },
            ...budget,
          });
          records.push(output.record);
          completed.push({
            caseId: entry.value.id,
            repetition,
            record: path
              .relative(directory, path.join(output.directory, "record.json"))
              .split(path.sep)
              .join("/"),
          });
          console.error(
            JSON.stringify({
              caseId: entry.value.id,
              repetition,
              acceptance: output.record.acceptance.status,
              completed: completed.length,
            }),
          );
        } catch (failure) {
          errors.push({ caseId: entry.value.id, repetition, error: String(failure) });
          console.error(JSON.stringify(errors[errors.length - 1]));
        }
        await persist("running");
      }
    const summary = await persist(errors.length ? "finished_with_execution_errors" : "finished");
    console.log(JSON.stringify({ directory, summary }, null, 2));
    if (errors.length || !summary.coverageComplete) process.exitCode = 1;
  } else if (command === "summarize") {
    const records: RunRecord[] = [];
    for (const file of args) records.push(await readRecord(file));
    const summary = summarize(
      records,
      dataset.cases.map((entry) => entry.value.id),
      metadata,
    );
    await mkdir("evals/runs/dataset", { recursive: true });
    await writeFile("evals/runs/dataset/summary.json", JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "compare") {
    if (!args[0]) throw Error("Usage: compare MANIFEST.json");
    const manifestPath = path.resolve(args[0]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const ids: string[] = manifest.caseIds ?? dataset.cases.map((entry) => entry.value.id);
    if (
      !Array.isArray(ids) ||
      ids.some((id) => !dataset.cases.some((entry) => entry.value.id === id))
    )
      throw Error("Comparison scope contains unknown cases");
    const groups: Record<string, RunRecord[]> = {};
    if (!manifest.agents || typeof manifest.agents !== "object" || Array.isArray(manifest.agents))
      throw Error("Comparison manifest requires agents: {name: [record paths]}");
    for (const [name, files] of Object.entries(manifest.agents)) {
      if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== "string"))
        throw Error(`Invalid record paths for ${name}`);
      groups[name] = await Promise.all(
        files.map((file) => readRecord(path.resolve(path.dirname(manifestPath), file))),
      );
    }
    const summary = compareAgents(groups, ids, metadata);
    await mkdir("evals/runs/dataset", { recursive: true });
    const output = path.resolve("evals/runs/dataset", `comparison-${randomUUID()}.json`);
    await writeFile(output, JSON.stringify(summary, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ output, ...summary }, null, 2));
    if (!summary.comparable) process.exitCode = 1;
  } else if (command === "judge-process") {
    if (!args[0]) throw Error("Usage: judge-process RECORD.json [MODEL] [REPEATS]");
    const record = await readRecord(args[0]),
      model = args[1] ?? "mimo-v2.5-pro",
      repeats = Number(args[2] ?? 2);
    if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10)
      throw Error("Judge repeats must be 1..10");
    const provider = await savedModel(model);
    const results: {
      output: string;
      status: string;
      process: RunRecord["process"];
      error: string | null;
    }[] = [];
    for (let index = 0; index < repeats; index++) {
      const result = await reevaluateProcess(record, provider, model, 600000);
      const output = path.resolve(
        "evals/runs/dataset",
        `process-${record.caseId}-${randomUUID()}.json`,
      );
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(result, null, 2), { flag: "wx" });
      results.push({ output, status: result.status, process: result.process, error: result.error });
      console.error(JSON.stringify({ repetition: index + 1, output, status: result.status }));
    }
    console.log(
      JSON.stringify(
        {
          sourceRunId: record.id,
          evaluations: results,
          identicalRatings:
            results.every((item) => item.status === "graded") &&
            results.every(
              (item) =>
                JSON.stringify([
                  item.process?.toolAccuracy.score,
                  item.process?.pathEfficiency.score,
                ]) ===
                JSON.stringify([
                  results[0]?.process?.toolAccuracy.score,
                  results[0]?.process?.pathEfficiency.score,
                ]),
            ),
        },
        null,
        2,
      ),
    );
    if (results.some((item) => item.status !== "graded")) process.exitCode = 1;
  } else
    throw Error(
      "Commands: agents | validate | freeze | quality | accept CASE-ID WORKSPACE | run CASE-ID [MODEL] [--agent FRAMEWORK] | run-all [MODEL] [REPEATS] [--agent FRAMEWORK] | summarize RECORD... | compare MANIFEST.json | judge-process RECORD.json [MODEL] [REPEATS]",
    );
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
