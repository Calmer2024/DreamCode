// Labeled synthetic controls, not production Agent executions. No automatic approval of calibration.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  savedModel,
  judgeProcess,
  traceJudgeProvider,
  processJudgePolicy,
} from "../src/dataset/index.js";
import { meterProvider, usageTotals } from "../src/dataset/usage.js";
import type { Evidence } from "../src/dataset/types.js";
import type { ModelUsage } from "@dreamcode/shared";
const preparation = path.resolve("evals/dataset/preparation");
const previous = JSON.parse(
  await readFile(path.join(preparation, "process-controls.json"), "utf8"),
);
const model = process.argv[2] ?? "mimo-v2.5-pro",
  provider = await savedModel(model);
const directory = path.join(
  preparation,
  `${processJudgePolicy(model).version}-controls-${randomUUID()}`,
);
await mkdir(directory, { recursive: true });
const outputs: any[] = [];
for (const control of previous.outputs) {
  for (let repetition = 1; repetition <= 2; repetition++) {
    const usage: (ModelUsage | null)[] = [],
      transcript: Evidence[] = [];
    let result = null,
      error = null;
    try {
      result = await judgeProcess(
        meterProvider(
          traceJudgeProvider(provider, (e) => transcript.push(e)),
          usage,
        ),
        model,
        control.evidence,
        AbortSignal.timeout(600000),
      );
    } catch (failure) {
      error = String(failure);
    }
    const accuracy = result?.toolAccuracy.score,
      efficiency = result?.pathEfficiency.score;
    const expected =
      control.name === "clean"
        ? { accuracy: [4], efficiency: [4] }
        : control.name === "ignored-errors"
          ? { accuracy: [0, 1], efficiency: [0, 1] }
          : control.name === "missing"
            ? { accuracy: [null], efficiency: [null] }
            : control.name === "minor-recovery"
              ? { accuracy: [3], efficiency: [3, 4] }
              : null;
    if (!expected) throw Error("Unlabeled control");
    const passed =
      !error &&
      expected.accuracy.includes(accuracy as never) &&
      expected.efficiency.includes(efficiency as never);
    const output = {
      name: control.name,
      repetition,
      evidence: control.evidence,
      expected,
      result,
      error,
      passed,
      metrics: usageTotals(usage),
      transcript,
    };
    outputs.push(output);
    await writeFile(
      path.join(directory, "controls.json"),
      JSON.stringify(
        {
          model,
          policy: processJudgePolicy(model),
          kind: "controlled-calibration-traces",
          humanReviewClaimed: false,
          status: "running",
          outputs,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ name: control.name, repetition, passed, accuracy, efficiency, error }),
    );
  }
}
const status = outputs.every((x) => x.passed) ? "passed" : "failed";
await writeFile(
  path.join(directory, "controls.json"),
  JSON.stringify(
    {
      model,
      judgeVersion: processJudgePolicy(model).version,
      policy: processJudgePolicy(model),
      kind: "controlled-calibration-traces",
      humanReviewClaimed: false,
      status,
      outputs,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ directory, status }));
if (status !== "passed") process.exitCode = 1;
