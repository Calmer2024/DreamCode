import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { admissionReport } from "./admission.js";
import { processJudgePolicy } from "./reevaluate.js";
async function setup(digest: string) {
  const root = await mkdtemp(path.join(tmpdir(), "judge-admission-")),
    preparation = path.join(root, "preparation");
  await mkdir(preparation);
  const policy = { ...processJudgePolicy("mimo-v2.5-pro"), promptDigest: digest };
  await writeFile(
    path.join(preparation, "process-judge-calibration.json"),
    JSON.stringify({
      reviewer: "Codex",
      method: "agent-review",
      humanReviewClaimed: false,
      accepted: true,
      evidence: "review.json",
      judgeVersion: policy.version,
      model: policy.model,
      policy,
    }),
  );
  await writeFile(
    path.join(preparation, "review.json"),
    JSON.stringify({
      reviewer: "Codex",
      method: "agent-review",
      humanReviewClaimed: false,
      accepted: true,
      findings: ["Controlled semantic calibration reviewed"],
    }),
  );
  await writeFile(
    path.join(preparation, "process-controls.json"),
    JSON.stringify({ status: "passed", judgeVersion: policy.version, model: policy.model, policy }),
  );
  return root;
}
it("does not treat calibration for a different prompt as valid just because its version label matches", async () => {
  expect((await admissionReport(await setup("wrong-digest"), [])).processJudgeCalibrated).toBe(
    false,
  );
});
it("accepts the reviewed controls for the exact current Judge policy", async () => {
  expect(
    (await admissionReport(await setup(processJudgePolicy("mimo-v2.5-pro").promptDigest), []))
      .processJudgeCalibrated,
  ).toBe(true);
});
