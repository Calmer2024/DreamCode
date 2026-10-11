import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { LoadedCase } from "./types.js";
const control = vi.hoisted(() => ({ accept: vi.fn(), judge: vi.fn() }));
vi.mock("./acceptance.js", () => ({ accept: control.accept }));
vi.mock("./judge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./judge.js")>()),
  judgeProcess: control.judge,
}));
vi.mock("./container.js", () => ({
  runContainerTurn: async (options: any) => {
    options.onReady({ workerSha256: "fixture" });
    options.onEvent({
      id: "tool",
      sessionId: "s",
      turnId: "t",
      type: "model.tool_call",
      timestamp: new Date().toISOString(),
      payload: { toolCall: { id: "t", name: "Read", input: {} } },
    });
  },
}));
import { runCase } from "./runner.js";
describe("dataset calibration keeps acceptance and omits process scoring", () => {
  beforeEach(() => {
    control.accept
      .mockReset()
      .mockResolvedValue({
        status: "passed",
        checks: [{ id: "answer", status: "passed", reason: "verified", evidence: [] }],
      });
    control.judge
      .mockReset()
      .mockResolvedValue({
        score: 75,
        toolAccuracy: { score: 3, reason: "observed", evidence: [] },
        pathEfficiency: { score: 3, reason: "observed", evidence: [] },
      });
  });
  async function fixture(processJudge?: boolean) {
    const root = await mkdtemp(path.join(tmpdir(), "dreameval-calibration-"));
    const workspace = path.join(root, "source");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "main.py"), "print(42)\n");
    const entry: LoadedCase = {
      root,
      workspace,
      instruction: "Explain source",
      value: {
        id: "fixture",
        instruction: "instruction.md",
        environment: { workspace: "source", runtime: "test" },
        acceptance: { evaluator: "judge", config: "acceptance.json" },
      },
      acceptance: {
        criteria: [{ id: "answer", description: "Correct explanation" }],
        rubric: "Judge correctness",
      },
      runtime: { image: `sha256:${"a".repeat(64)}`, timeoutMs: 1000 },
    };
    const provider = { name: "test", async *stream() {} };
    return runCase(entry, {
      directory: path.join(root, "runs"),
      worker: "fixture",
      provider,
      model: "test",
      judge: { provider, model: "test" },
      timeoutMs: 1000,
      maxModelRequests: 1,
      processJudge,
    });
  }
  it("runs task acceptance but never invokes process Judge when explicitly disabled", async () => {
    const { record } = await fixture(false);
    expect(control.accept).toHaveBeenCalledOnce();
    expect(control.accept.mock.calls[0]![3]).toMatchObject({ model: "test" });
    expect(control.judge).not.toHaveBeenCalled();
    expect(record.acceptance.status).toBe("passed");
    expect(record.processEvaluation?.status).toBe("not_requested");
    expect(record.process).toBeNull();
    expect(record.processJudgePolicy).toBeUndefined();
  });
  it("retains process scoring for ordinary benchmark runs", async () => {
    const { record } = await fixture();
    expect(control.judge).toHaveBeenCalledOnce();
    expect(record.processEvaluation?.status).toBe("graded");
    expect(record.process?.score).toBe(75);
    expect(record.processJudgePolicy).toBeDefined();
  });
});
