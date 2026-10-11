import { PROCESS_JUDGE_VERSION } from "./scoring.js";
import { processJudgePolicy } from "./reevaluate.js";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { LoadedCase } from "./types.js";
import { validateRelative } from "./loader.js";
async function reviewed(root: string, value: unknown) {
  const review = value as {
    reviewer?: string;
    method?: string;
    evidence?: string;
    accepted?: boolean;
    humanReviewClaimed?: boolean;
  } | null;
  if (
    !review?.reviewer ||
    review.accepted !== true ||
    review.method !== "agent-review" ||
    review.humanReviewClaimed !== false ||
    !review.evidence
  )
    return false;
  try {
    validateRelative(review.evidence);
    const proof = JSON.parse(
      await readFile(path.join(root, "preparation", review.evidence), "utf8"),
    );
    return (
      proof.reviewer === review.reviewer &&
      proof.method === review.method &&
      proof.accepted === true &&
      proof.humanReviewClaimed === false &&
      Array.isArray(proof.findings) &&
      proof.findings.length > 0
    );
  } catch {
    return false;
  }
}
export const targetCoverage: Record<string, number> = {
  bugfix: 12,
  feature: 10,
  refactor: 5,
  migration: 5,
  integration: 6,
  "dependency/build": 6,
  terminal: 6,
  understanding: 4,
  review: 3,
  research: 3,
};
/** Review evidence is explicit; the user authorized Agent review on this dataset. */
export async function admissionReport(root: string, cases: LoadedCase[]) {
  const results: { id: string; scenario: string; admitted: boolean; reasons: string[] }[] = [];
  for (const entry of cases) {
    const reasons: string[] = [];
    let provenance: Record<string, unknown> = {};
    try {
      provenance = JSON.parse(
        await readFile(path.join(root, "preparation", entry.value.id, "provenance.json"), "utf8"),
      );
    } catch {
      reasons.push("Source evidence missing");
    }
    if (typeof provenance.commit !== "string" || !/^[0-9a-f]{40}$/.test(provenance.commit))
      reasons.push("Upstream commit not fixed");
    const review = provenance.engineeringReview as {
      reviewer?: string;
      evidence?: string;
      accepted?: boolean;
    } | null;
    if (!(await reviewed(root, review))) reasons.push("Engineering review pending");
    if (entry.acceptance.program) {
      try {
        const controls = JSON.parse(
          await readFile(path.join(root, "preparation", entry.value.id, "controls.json"), "utf8"),
        );
        if (
          controls.status !== "passed" ||
          controls.reference?.status !== "passed" ||
          controls.baseline?.status !== "failed" ||
          controls.incomplete?.status !== "failed"
        )
          reasons.push("Reference/no-op/incomplete controls not all verified");
        const scope = JSON.parse(
          await readFile(
            path.join(root, "preparation", entry.value.id, "reference-scope.json"),
            "utf8",
          ),
        );
        if (
          scope.status !== "passed" ||
          scope.runtimeImage !== entry.runtime.image ||
          !Array.isArray(scope.violations) ||
          scope.violations.length
        )
          reasons.push("Reference scope/current runtime review missing");
      } catch {
        reasons.push("Deterministic controls missing");
      }
    }
    if (entry.value.acceptance.evaluator !== "program") {
      try {
        const controls = JSON.parse(
          await readFile(
            path.join(root, "preparation", entry.value.id, "judge-controls.json"),
            "utf8",
          ),
        );
        if (
          controls.status !== "passed" ||
          controls.reference?.status !== "passed" ||
          controls.wrong?.status !== "failed"
        )
          reasons.push("Acceptance Judge positive/negative controls not verified");
      } catch {
        reasons.push("Acceptance Judge controls missing");
      }
      const calibration = provenance.judgeCalibrationReview as {
        reviewer?: string;
        evidence?: string;
        accepted?: boolean;
      } | null;
      if (!(await reviewed(root, calibration)))
        reasons.push("Acceptance Judge calibration review pending");
    }
    results.push({
      id: entry.value.id,
      scenario: entry.value.metadata?.scenario ?? "unclassified",
      admitted: reasons.length === 0,
      reasons,
    });
  }
  const coverage = Object.fromEntries(
    Object.entries(targetCoverage).map(([scenario, expected]) => [
      scenario,
      {
        expected,
        candidates: results.filter((item) => item.scenario === scenario).length,
        admitted: results.filter((item) => item.scenario === scenario && item.admitted).length,
      },
    ]),
  );
  let processJudgeCalibrated = false;
  try {
    const calibration = JSON.parse(
      await readFile(path.join(root, "preparation/process-judge-calibration.json"), "utf8"),
    );
    const controls = JSON.parse(
      await readFile(path.join(root, "preparation/process-controls.json"), "utf8"),
    );
    processJudgeCalibrated =
      (await reviewed(root, calibration)) &&
      typeof calibration.reviewer === "string" &&
      typeof calibration.evidence === "string" &&
      calibration.judgeVersion === PROCESS_JUDGE_VERSION &&
      controls.status === "passed" &&
      controls.judgeVersion === PROCESS_JUDGE_VERSION &&
      typeof calibration.model === "string" &&
      controls.model === calibration.model &&
      isDeepStrictEqual(calibration.policy, processJudgePolicy(calibration.model)) &&
      isDeepStrictEqual(controls.policy, processJudgePolicy(calibration.model));
  } catch {
    /* Missing calibration is explicit below. */
  }
  return {
    expected: 60,
    candidates: cases.length,
    admitted: results.filter((item) => item.admitted).length,
    coverage,
    processJudgeCalibrated,
    ready:
      processJudgeCalibrated &&
      cases.length === 60 &&
      results.every((item) => item.admitted) &&
      Object.values(coverage).every((item) => item.admitted === item.expected),
    cases: results,
  };
}
