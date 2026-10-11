// Activate explicitly reviewed calibration and archive the previous proof; case data is unchanged.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { processJudgePolicy } from "../dist/dataset/index.js";
const root = path.resolve("evals/dataset/preparation");
const review = JSON.parse(await readFile(path.join(root, "process-v5-review.json"), "utf8"));
if (
  review.method !== "agent-review" ||
  review.accepted !== true ||
  review.humanReviewClaimed !== false
)
  throw Error("Explicit review missing");
const controls = JSON.parse(await readFile(path.join(root, review.controls), "utf8"));
const current = processJudgePolicy(controls.model);
if (
  controls.status !== "passed" ||
  controls.judgeVersion !== current.version ||
  !isDeepStrictEqual(controls.policy, current) ||
  controls.outputs.length !== 8 ||
  !controls.outputs.every((o) => o.passed)
)
  throw Error("Current controls not passed");
const archive = path.join(root, "history/process-v3");
await mkdir(archive, { recursive: true });
for (const name of [
  "process-controls.json",
  "process-review.json",
  "process-judge-calibration.json",
]) {
  await copyFile(path.join(root, name), path.join(archive, name), constants.COPYFILE_EXCL).catch(
    (error) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
}
await writeFile(path.join(root, "process-controls.json"), JSON.stringify(controls, null, 2));
await writeFile(
  path.join(root, "process-judge-calibration.json"),
  JSON.stringify(
    {
      reviewer: review.reviewer,
      method: review.method,
      humanReviewClaimed: false,
      accepted: true,
      evidence: "process-v5-review.json",
      judgeVersion: current.version,
      model: current.model,
      policy: current,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    version: current.version,
    controls: controls.outputs.length,
    archive,
    review: "process-v5-review.json",
  }),
);
