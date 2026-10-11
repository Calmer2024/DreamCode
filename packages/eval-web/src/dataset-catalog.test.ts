import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvalCase, LoadedCase } from "@dreamcode/evals/dataset";
import { catalogTask } from "./dataset-catalog";

async function entries() {
  const root = path.resolve("evals/dataset");
  const manifest = JSON.parse(await readFile(path.join(root, "dataset.json"), "utf8"));
  return Promise.all(
    (manifest.cases as string[]).map(async (relative) => {
      const value = JSON.parse(await readFile(path.join(root, relative), "utf8")) as EvalCase;
      const caseRoot = path.dirname(path.join(root, relative));
      return {
        value,
        root: caseRoot,
        workspace: path.join(caseRoot, value.environment.workspace),
        instruction: await readFile(path.join(caseRoot, value.instruction), "utf8"),
        runtime: JSON.parse(
          await readFile(path.join(root, `runtimes/${value.environment.runtime}.json`), "utf8"),
        ),
        acceptance: JSON.parse(
          await readFile(path.join(caseRoot, value.acceptance.config), "utf8"),
        ),
      } as LoadedCase;
    }),
  );
}

describe("case catalogue and Chinese instructions", () => {
  it("covers all 60 current source instructions without altering the execution contract", async () => {
    const source = await entries();
    expect(source).toHaveLength(60);
    for (const entry of source) {
      const task = catalogTask(entry);
      expect(task.instructionTranslated, entry.value.id).toBe(true);
      expect(task.instruction).toMatch(/[\u4e00-\u9fff]/);
      expect(task.instructionOriginal).toBe(entry.instruction);
      expect(task.case).toEqual(entry.value);
      expect(task.environment).toEqual(entry.value.environment);
      expect(task.acceptanceConfig).toEqual(entry.acceptance);
      expect(task.runtimeConfig).toEqual(entry.runtime);
    }
  });
  it("rejects stale translations instead of silently showing obsolete requirements", async () => {
    const entry = (await entries())[0]!;
    const changed = catalogTask({
      ...entry,
      instruction: entry.instruction + "New acceptance requirement.",
    });
    expect(changed.instructionTranslated).toBe(false);
    expect(changed.instruction).toContain("中文版本尚未校验");
    expect(changed.instruction).not.toContain("New acceptance");
    expect(changed.instructionOriginal).toContain("New acceptance");
  });
});
