import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTasks, loadTask, runTask } from "./index";

describe("DreamCode eval runner", () => {
  it("discovers and executes all 52 tasks in isolated workspaces", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-evals-test-"));
    try {
      const taskPaths = await discoverTasks();
      expect(taskPaths).toHaveLength(52);

      for (const taskPath of taskPaths) {
        const task = await loadTask(taskPath);
        const result = await runTask(task, {
          provider: "fake",
          outputRoot,
        });
        expect(result.status, task.id).toBe("passed");
        expect(result.hardFailure).toBe(false);
        expect(result.scores.total).toBeGreaterThan(0);
        expect(result.metrics.e2eMs).toBeGreaterThanOrEqual(0);
        await expect(
          readFile(path.join(result.artifactsDir, "evaluation.json"), "utf8"),
        ).resolves.toContain(`"taskId": "${result.taskId}"`);
      }
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
