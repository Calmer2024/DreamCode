import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTasks, loadTask, parseJudgeResponse, runTask } from "./index";

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
  }, 120_000);

  it("includes validated LLM Judge ratings in the 100-point score", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-evals-judge-test-"));
    try {
      const taskPath = (await discoverTasks()).find((item) => item.includes("B01-"));
      expect(taskPath).toBeDefined();
      const result = await runTask(await loadTask(taskPath!), {
        provider: "fake",
        judge: true,
        outputRoot,
        judgeEvaluator: async (evidence) => {
          expect(evidence.assertions.every((item) => item.passed)).toBe(true);
          expect(evidence.finalAnswer).not.toBeNull();
          expect(evidence.sessionLog.some((event) => event.type === "turn.started")).toBe(true);
          expect(evidence.sessionLog.some((event) => event.type === "assistant.message")).toBe(
            true,
          );
          expect(evidence.sessionLog.some((event) => event.type === "model.usage")).toBe(true);
          expect(evidence.workspaceChanges[0]).toMatchObject({
            path: "src/services/task-service.ts",
            change: "modified",
          });
          expect(evidence.workspaceChanges[0]?.beforeHash).toMatch(/^[a-f0-9]{64}$/);
          expect(evidence.workspaceChanges[0]?.afterHash).toMatch(/^[a-f0-9]{64}$/);
          expect(JSON.stringify(evidence.workspaceChanges)).not.toContain("task.status === status");
          return {
            status: "completed",
            taskCompletion: 1,
            toolSelectionQuality: 0.75,
            stepEfficiency: 0.5,
            summaryAccuracy: 0.25,
          };
        },
      });

      expect(result.scores.judge).toEqual({
        taskCompletion: 15,
        finalAnswerFaithfulness: 1.25,
        toolSelectionQuality: 5.25,
        stepEfficiency: 5,
        total: 26.5,
        max: 37,
      });
      expect(result.scores.total).toBe(result.scores.deterministic.total + 26.5);
      expect(result.scores.complete).toBe(true);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed or out-of-rubric Judge output", () => {
    expect(() =>
      parseJudgeResponse(
        JSON.stringify({
          taskCompletion: 0.9,
          toolSelectionQuality: 1,
          stepEfficiency: 1,
          summaryAccuracy: 1,
        }),
      ),
    ).toThrow("invalid rating");
    expect(() =>
      parseJudgeResponse(
        JSON.stringify({
          taskCompletion: 1,
          toolSelectionQuality: 1,
          stepEfficiency: 1,
          summaryAccuracy: 1,
          rationale: "extra fields are not accepted",
        }),
      ),
    ).toThrow("must contain exactly");
  });
});
