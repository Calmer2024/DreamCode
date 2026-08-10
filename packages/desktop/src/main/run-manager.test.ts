import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "@dreamcode/shared";
import type { DreamCodeConfig } from "@dreamcode/store";
import { describe, expect, it } from "vitest";
import type {
  DesktopApprovalRequest,
  DesktopQuestionRequest,
  DesktopRunEvent,
  DesktopRunStatus,
  StartTurnRequest,
} from "../shared/contracts";
import { DesktopRunManager, type DesktopRunManagerOptions } from "./run-manager";

const fakeConfig: DreamCodeConfig = {
  version: 1,
  currentProfile: "fake",
  profiles: { fake: { provider: "fake" } },
};

describe("DesktopRunManager", () => {
  it("streams a complete Fake Provider Turn and releases the active run", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-home-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-workspace-"));
    const events: DesktopRunEvent[] = [];
    const statuses: DesktopRunStatus[] = [];
    const manager = createManager({
      home,
      emitEvent: (event) => events.push(event),
      emitStatus: (status) => statuses.push(status),
    });

    const { runId, completion } = await manager.start({
      prompt: "Inspect workspace",
      workspaceRoot,
      profileName: "fake",
      mode: "yolo",
    });
    await completion;

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((item) => item.runId === runId)).toBe(true);
    expect(events.some((item) => item.event.type === "turn.completed")).toBe(true);
    expect(statuses.map((status) => status.status)).toEqual(["running", "completed"]);
    expect(manager.activeRunId).toBeUndefined();
  });

  it("rejects a second active Turn", async () => {
    const { manager, request } = await createBlockingManager();
    const first = await manager.start(request);

    await expect(manager.start(request)).rejects.toMatchObject({ code: "run_already_active" });

    await manager.stop(first.runId);
    await first.completion;
  });

  it("aborts only the matching run id", async () => {
    const events: DesktopRunEvent[] = [];
    const statuses: DesktopRunStatus[] = [];
    const { manager, request } = await createBlockingManager({
      emitEvent: (event) => events.push(event),
      emitStatus: (status) => statuses.push(status),
    });
    const { runId, completion } = await manager.start(request);

    await expect(manager.stop("stale-run")).rejects.toMatchObject({ code: "stale_run" });
    expect(manager.activeRunId).toBe(runId);

    await manager.stop(runId);
    await completion;

    expect(events.map((item) => item.event.type)).toContain("turn.interrupted");
    expect(statuses.at(-1)?.status).toBe("interrupted");
    expect(manager.activeRunId).toBeUndefined();
  });

  it("resolves only the matching independently identified approval request", async () => {
    const approval = deferred<DesktopApprovalRequest>();
    const events: DesktopRunEvent[] = [];
    const { manager, request } = await createScriptedManager(approvalProvider(), {
      emitApproval: (request) => approval.resolve(request),
      emitEvent: (event) => events.push(event),
    });
    const { runId, completion } = await manager.start({ ...request, mode: "guided" });
    const pending = await approval.promise;

    expect(pending).toMatchObject({
      runId,
      tool: "shell.run",
      input: { command: "echo approval" },
    });
    expect(pending.requestId).not.toBe("tool-call-approval");
    await expect(
      manager.respondApproval({ ...pending, runId: "stale-run", approved: false }),
    ).rejects.toMatchObject({ code: "stale_run" });
    await expect(
      manager.respondApproval({ ...pending, requestId: "stale-request", approved: false }),
    ).rejects.toMatchObject({ code: "stale_request" });

    await manager.respondApproval({ ...pending, approved: false });
    await completion;

    expect(events.some((item) => item.event.type === "turn.completed")).toBe(true);
  });

  it("resolves only the matching question request", async () => {
    const question = deferred<DesktopQuestionRequest>();
    const events: DesktopRunEvent[] = [];
    const { manager, request } = await createScriptedManager(questionProvider(), {
      emitQuestion: (request) => question.resolve(request),
      emitEvent: (event) => events.push(event),
    });
    const { runId, completion } = await manager.start(request);
    const pending = await question.promise;

    expect(pending).toMatchObject({ runId, question: "Which target?" });
    expect(pending.requestId).not.toBe("tool-call-question");
    await expect(
      manager.respondQuestion({ ...pending, runId: "stale-run", answer: "README.md" }),
    ).rejects.toMatchObject({ code: "stale_run" });
    await expect(
      manager.respondQuestion({ ...pending, requestId: "stale-request", answer: "README.md" }),
    ).rejects.toMatchObject({ code: "stale_request" });

    await manager.respondQuestion({ ...pending, answer: "README.md" });
    await completion;

    expect(events.some((item) => item.event.type === "turn.completed")).toBe(true);
    const completed = events.find((item) => item.event.type === "tool.completed");
    expect(completed?.event.payload).toMatchObject({
      data: { question: "Which target?", answer: "README.md" },
    });
  });

  it("disposes an active run waiting for approval and settles its completion", async () => {
    const approval = deferred<DesktopApprovalRequest>();
    const events: DesktopRunEvent[] = [];
    const { manager, request } = await createScriptedManager(approvalProvider(), {
      emitApproval: (request) => approval.resolve(request),
      emitEvent: (event) => events.push(event),
    });
    const { completion } = await manager.start({ ...request, mode: "guided" });
    const pending = await approval.promise;

    await manager.dispose();
    await completion;

    expect(events.some((item) => item.event.type === "turn.interrupted")).toBe(true);
    expect(manager.activeRunId).toBeUndefined();
    await expect(manager.respondApproval({ ...pending, approved: true })).rejects.toMatchObject({
      code: "stale_run",
    });
  });

  it("emits failed status errors as plain serializable desktop errors", async () => {
    const statuses: DesktopRunStatus[] = [];
    const manager = createManager({
      loadConfig: async () => {
        throw new Error("Configuration could not be read.");
      },
      emitStatus: (status) => statuses.push(status),
    });
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-workspace-"));

    const { completion } = await manager.start({
      prompt: "Inspect workspace",
      workspaceRoot,
      mode: "yolo",
    });
    await completion;

    expect(statuses.at(-1)?.error).toEqual({
      code: "run_failed",
      message: "Configuration could not be read.",
      recoverable: true,
    });
    expect(statuses.at(-1)?.error).not.toBeInstanceOf(Error);
    expect(manager.activeRunId).toBeUndefined();
  });
});

function createManager(overrides: Partial<DesktopRunManagerOptions> = {}) {
  return new DesktopRunManager({
    loadConfig: async () => fakeConfig,
    ...overrides,
  });
}

async function createBlockingManager(overrides: Partial<DesktopRunManagerOptions> = {}) {
  return createScriptedManager(blockingProvider(), overrides);
}

async function createScriptedManager(
  provider: ModelProvider,
  overrides: Partial<DesktopRunManagerOptions> = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-home-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-workspace-"));
  const manager = createManager({
    home,
    createProvider: () => ({ provider }),
    ...overrides,
  });
  const request: StartTurnRequest = {
    prompt: "Run scripted provider",
    workspaceRoot,
    profileName: "fake",
    mode: "yolo",
  };
  return { manager, request };
}

function blockingProvider(): ModelProvider {
  return {
    name: "blocking",
    async *stream({ signal }) {
      yield { type: "text_delta", text: "Waiting for stop.\n" };
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
}

function approvalProvider(): ModelProvider {
  let step = 0;
  return {
    name: "approval",
    async *stream() {
      if (step++ === 0) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "tool-call-approval",
            name: "shell.run",
            input: { command: "echo approval" },
          },
        };
      } else {
        yield { type: "text_delta", text: "Approval handled." };
      }
      yield { type: "done" };
    },
  };
}

function questionProvider(): ModelProvider {
  let step = 0;
  return {
    name: "question",
    async *stream() {
      if (step++ === 0) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "tool-call-question",
            name: "question.ask",
            input: { question: "Which target?" },
          },
        };
      } else {
        yield { type: "text_delta", text: "Question answered." };
      }
      yield { type: "done" };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
