import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "@dreamcode/shared";
import type { DreamCodeConfig, DreamCodeLlmProfile } from "@dreamcode/store";
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
  version: 2,
  currentProfileId: "fake",
  profiles: { fake: { alias: "fake", provider: "fake" } },
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
      profileId: "fake",
      mode: "yolo",
    });
    await completion;

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((item) => item.runId === runId)).toBe(true);
    expect(events.some((item) => item.event.type === "turn.completed")).toBe(true);
    expect(statuses.map((status) => status.status)).toEqual(["running", "completed"]);
    expect(manager.activeRunId).toBeUndefined();
  });

  it("uses the requested model without changing the stored profile connection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-home-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-workspace-"));
    let receivedProfile: DreamCodeLlmProfile | undefined;
    const provider: ModelProvider = {
      name: "model-override",
      async *stream() {
        yield { type: "text_delta", text: "Done." };
        yield { type: "done" };
      },
    };
    const manager = createManager({
      home,
      createProvider: (_prompt, profile) => {
        receivedProfile = profile;
        return { provider, model: profile.model };
      },
    });

    const { completion } = await manager.start({
      prompt: "Use another model",
      workspaceRoot,
      profileId: "fake",
      model: "temporary-model",
      mode: "yolo",
    });
    await completion;

    expect(receivedProfile).toEqual({
      ...fakeConfig.profiles.fake,
      model: "temporary-model",
    });
    expect(fakeConfig.profiles.fake?.model).toBeUndefined();
  });

  it("releases the active run before delivering a terminal status", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-home-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-workspace-"));
    let manager!: DesktopRunManager;
    let activeRunWhenCompleted: string | undefined;
    manager = createManager({
      home,
      emitStatus: (status) => {
        if (status.status === "completed") {
          activeRunWhenCompleted = manager.activeRunId;
        }
      },
    });

    const { completion } = await manager.start({
      prompt: "Inspect workspace",
      workspaceRoot,
      profileId: "fake",
      mode: "yolo",
    });
    await completion;

    expect(activeRunWhenCompleted).toBeUndefined();
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

  it("waits for interrupted run completion before stop resolves", async () => {
    const interruptedDelivery = deferred<void>();
    const { manager, request } = await createBlockingManager({
      emitStatus: (status) =>
        status.status === "interrupted" ? interruptedDelivery.promise : undefined,
    });
    const active = await manager.start(request);
    let stopSettled = false;

    const stopping = manager.stop(active.runId).then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    interruptedDelivery.resolve();
    await stopping;
    await active.completion;
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
      tool: process.platform === "win32" ? "pwsh" : "bash",
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

  it("emits provider setup failures as plain serializable desktop errors", async () => {
    const statuses: DesktopRunStatus[] = [];
    const manager = createManager({
      createProvider: () => {
        throw new Error("Provider could not be created.");
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
      code: "provider_setup_failed",
      message: "Provider could not be created.",
      recoverable: true,
    });
    expect(statuses.at(-1)?.error).not.toBeInstanceOf(Error);
    expect(manager.activeRunId).toBeUndefined();
  });

  it("stops without waiting for a delayed approval emitter", async () => {
    const approval = deferred<DesktopApprovalRequest>();
    const emission = deferred<void>();
    const { manager, request } = await createScriptedManager(approvalProvider(), {
      emitApproval: (pending) => {
        approval.resolve(pending);
        return emission.promise;
      },
    });
    const { runId, completion } = await manager.start({ ...request, mode: "guided" });
    const pending = await approval.promise;

    await manager.respondApproval({ ...pending, approved: true });
    await expect(manager.respondApproval({ ...pending, approved: false })).rejects.toMatchObject({
      code: "stale_request",
    });

    await manager.stop(runId);

    await expectSettlesPromptly(completion);
    expect(manager.activeRunId).toBeUndefined();
  });

  it("disposes without waiting for a delayed question emitter", async () => {
    const question = deferred<DesktopQuestionRequest>();
    const emission = deferred<void>();
    const { manager, request } = await createScriptedManager(questionProvider(), {
      emitQuestion: (pending) => {
        question.resolve(pending);
        return emission.promise;
      },
    });
    const { completion } = await manager.start(request);
    const pending = await question.promise;

    await manager.respondQuestion({ ...pending, answer: "README.md" });
    await expect(
      manager.respondQuestion({ ...pending, answer: "src/index.ts" }),
    ).rejects.toMatchObject({ code: "stale_request" });

    const disposal = manager.dispose();

    await expectSettlesPromptly(disposal);
    await expectSettlesPromptly(completion);
    expect(manager.activeRunId).toBeUndefined();
  });

  it("settles an approval exchange when its emitter rejects", async () => {
    const statuses: DesktopRunStatus[] = [];
    const { manager, request } = await createScriptedManager(approvalProvider(), {
      emitApproval: async () => {
        throw new Error("Approval delivery failed.");
      },
      emitStatus: (status) => statuses.push(status),
    });

    const { completion } = await manager.start({ ...request, mode: "guided" });
    await expectSettlesPromptly(completion);

    expect(statuses.at(-1)).toMatchObject({
      status: "failed",
      error: { code: "run_failed", message: "Approval delivery failed.", recoverable: true },
    });
    expect(manager.activeRunId).toBeUndefined();
  });

  it("settles a question exchange when its emitter rejects", async () => {
    const statuses: DesktopRunStatus[] = [];
    const events: DesktopRunEvent[] = [];
    const { manager, request } = await createScriptedManager(questionProvider(), {
      emitQuestion: async () => {
        throw new Error("Question delivery failed.");
      },
      emitEvent: (event) => events.push(event),
      emitStatus: (status) => statuses.push(status),
    });

    const { completion } = await manager.start(request);
    await expectSettlesPromptly(completion);

    expect(statuses.at(-1)?.status).toBe("completed");
    expect(
      events.find((event) => event.event.type === "tool.completed")?.event.payload,
    ).toMatchObject({
      status: "error",
      summary: "Question delivery failed.",
    });
    expect(manager.activeRunId).toBeUndefined();
  });

  it("rejects public validation errors as plain stack-free data", async () => {
    const { manager, request } = await createBlockingManager();
    const active = await manager.start(request);

    const concurrentError = await manager.start(request).catch((error: unknown) => error);
    const staleError = await manager.stop("stale-run").catch((error: unknown) => error);

    expect(concurrentError).toEqual({
      code: "run_already_active",
      message: "Another Turn is already active.",
      recoverable: true,
    });
    expect(staleError).toEqual({
      code: "stale_run",
      message: "Run is no longer active.",
      recoverable: true,
    });
    expect(Object.hasOwn(concurrentError as object, "stack")).toBe(false);
    expect(Object.hasOwn(staleError as object, "stack")).toBe(false);
    expect(JSON.parse(JSON.stringify(concurrentError))).toEqual(concurrentError);

    await manager.stop(active.runId);
    await active.completion;
  });

  it("does not expose an exception message from configuration loading", async () => {
    const secret = "stored-config-secret-value";
    const statuses: DesktopRunStatus[] = [];
    const manager = createManager({
      loadConfig: async () => {
        throw new Error(`Could not parse config containing ${secret}.`);
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
      code: "config_load_failed",
      message: "Failed to load DreamCode configuration.",
      recoverable: true,
    });
    expect(JSON.stringify(statuses)).not.toContain(secret);
  });

  it("redacts stored and environment API keys from provider errors", async () => {
    const storedSecret = "stored-provider-secret-value";
    const environmentSecret = "environment-provider-secret-value";
    const environmentName = "DREAMCODE_RUN_MANAGER_TEST_API_KEY";
    const previousEnvironmentValue = process.env[environmentName];
    process.env[environmentName] = environmentSecret;
    const config: DreamCodeConfig = {
      version: 2,
      currentProfileId: "secret",
      profiles: {
        secret: {
          alias: "secret",
          provider: "secret-test",
          apiKey: storedSecret,
          apiKeyEnv: environmentName,
        },
      },
    };
    const events: DesktopRunEvent[] = [];
    const statuses: DesktopRunStatus[] = [];
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-home-"));
    const provider: ModelProvider = {
      name: "secret-test",
      async *stream() {
        yield { type: "text_delta", text: "Starting provider request.\n" };
        throw new Error(`Provider rejected ${storedSecret} and ${environmentSecret}.`);
      },
    };
    const manager = createManager({
      home,
      loadConfig: async () => config,
      createProvider: () => ({ provider }),
      emitEvent: (event) => events.push(event),
      emitStatus: (status) => statuses.push(status),
    });
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-workspace-"));

    try {
      const { completion } = await manager.start({
        prompt: "Inspect workspace",
        workspaceRoot,
        profileId: "secret",
        mode: "yolo",
      });
      await completion;

      const outbound = JSON.stringify({ events, statuses });
      expect(outbound).not.toContain(storedSecret);
      expect(outbound).not.toContain(environmentSecret);
      expect(outbound).toContain("[REDACTED]");
      expect(statuses.at(-1)?.error).toEqual({
        code: "run_failed",
        message: "Provider rejected [REDACTED] and [REDACTED].",
        recoverable: true,
      });
      expect(Object.hasOwn(statuses.at(-1)?.error ?? {}, "stack")).toBe(false);
    } finally {
      if (previousEnvironmentValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = previousEnvironmentValue;
      }
    }
  });

  it("ignores whitespace-only stored and environment credentials", async () => {
    const environmentName = "DREAMCODE_RUN_MANAGER_BLANK_API_KEY";
    const previousEnvironmentValue = process.env[environmentName];
    process.env[environmentName] = " ";
    const events: DesktopRunEvent[] = [];
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-home-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-workspace-"));
    const provider: ModelProvider = {
      name: "blank-secret-test",
      async *stream() {
        yield { type: "text_delta", text: "Normal provider message remains readable." };
        yield { type: "done" };
      },
    };
    const manager = createManager({
      home,
      loadConfig: async () => ({
        version: 2,
        currentProfileId: "blank",
        profiles: {
          blank: {
            alias: "blank",
            provider: "blank-secret-test",
            apiKey: "   ",
            apiKeyEnv: environmentName,
          },
        },
      }),
      createProvider: () => ({ provider }),
      emitEvent: (event) => events.push(event),
    });

    try {
      const { completion } = await manager.start({
        prompt: "Inspect workspace",
        workspaceRoot,
        profileId: "blank",
        mode: "yolo",
      });
      await completion;

      const delta = events.find((event) => event.event.type === "model.delta");
      expect(delta?.event.payload).toEqual({
        text: "Normal provider message remains readable.",
      });
      expect(events.some((event) => event.event.type === "turn.completed")).toBe(true);
    } finally {
      if (previousEnvironmentValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = previousEnvironmentValue;
      }
    }
  });

  it("redacts the whole affected string for trimmed short credentials", async () => {
    const environmentName = "DREAMCODE_RUN_MANAGER_SHORT_API_KEY";
    const previousEnvironmentValue = process.env[environmentName];
    process.env[environmentName] = " z ";
    const events: DesktopRunEvent[] = [];
    const statuses: DesktopRunStatus[] = [];
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-home-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-manager-workspace-"));
    const provider: ModelProvider = {
      name: "short-secret-test",
      async *stream() {
        yield { type: "text_delta", text: "Progress remains readable." };
        throw new Error("Secrets q and z were rejected.");
      },
    };
    const manager = createManager({
      home,
      loadConfig: async () => ({
        version: 2,
        currentProfileId: "short",
        profiles: {
          short: {
            alias: "short",
            provider: "short-secret-test",
            apiKey: " q ",
            apiKeyEnv: environmentName,
          },
        },
      }),
      createProvider: () => ({ provider }),
      emitEvent: (event) => events.push(event),
      emitStatus: (status) => statuses.push(status),
    });

    try {
      const { completion } = await manager.start({
        prompt: "Inspect workspace",
        workspaceRoot,
        profileId: "short",
        mode: "yolo",
      });
      await completion;

      expect(events.find((event) => event.event.type === "model.delta")?.event.payload).toEqual({
        text: "Progress remains readable.",
      });
      expect(events.some((event) => event.event.type === "session.summarized")).toBe(false);
      const failed = events.find((event) => event.event.type === "turn.failed")?.event.payload as {
        error?: string;
        summary?: { message?: string };
      };
      expect(failed.error).toBe("[REDACTED]");
      expect(failed.summary?.message).toBe("[REDACTED]");
      expect(statuses.at(-1)?.error?.message).toBe("[REDACTED]");
    } finally {
      if (previousEnvironmentValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = previousEnvironmentValue;
      }
    }
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
    profileId: "fake",
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
            name: process.platform === "win32" ? "pwsh" : "bash",
            input: { command: "echo approval", description: "approval test command" },
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

async function expectSettlesPromptly(promise: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "rejected" as const,
    ),
    new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), 500);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  expect(outcome).toBe("settled");
}
