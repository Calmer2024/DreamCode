import { createHash } from "node:crypto";
import type { LoadedCase } from "@dreamcode/evals/dataset";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatasetTask } from "./dataset-types";

// Task translations belong to the local dataset and are optional in a checkout.
const translationPaths = [
  new URL("./dataset-instructions.zh-CN.json", import.meta.url),
  path.resolve("packages/eval-web/src/dataset-instructions.zh-CN.json"),
  path.resolve("src/dataset-instructions.zh-CN.json"),
];
let instructions: Record<string, { text: string; sourceSha256: string }> = {};
for (const translationPath of translationPaths) {
  try {
    instructions = JSON.parse(readFileSync(translationPath, "utf8"));
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function catalogTask(entry: LoadedCase): DatasetTask {
  const translation = (instructions as Record<string, { text: string; sourceSha256: string }>)[
    entry.value.id
  ];
  const matched =
    translation?.sourceSha256 === createHash("sha256").update(entry.instruction).digest("hex");
  return {
    id: entry.value.id,
    instruction: matched
      ? translation.text
      : "当前任务要求的中文版本尚未校验，请检查平台翻译与原始任务是否一致。",
    instructionTranslated: !!matched,
    instructionOriginal: entry.instruction,
    environment: entry.value.environment,
    runtime: entry.value.environment.runtime,
    runtimeConfig: entry.runtime,
    acceptance: entry.value.acceptance,
    acceptanceConfig: entry.acceptance,
    evaluator: entry.value.acceptance.evaluator,
    constraints: entry.value.constraints,
    metadata: entry.value.metadata,
    case: entry.value,
  };
}
