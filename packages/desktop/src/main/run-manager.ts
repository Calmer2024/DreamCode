import { type ApprovalRequest, runTurn } from "@dreamcode/core";
import type { ModelProvider } from "@dreamcode/shared";
import { createId } from "@dreamcode/shared";
import {
  type DreamCodeConfig,
  type DreamCodeLlmProfile,
  loadDreamCodeConfig,
} from "@dreamcode/store";
import { createDefaultToolRegistry } from "@dreamcode/tools";
import type {
  ApprovalResponse,
  DesktopApprovalRequest,
  DesktopError,
  DesktopQuestionRequest,
  DesktopRunEvent,
  DesktopRunStatus,
  QuestionResponse,
  StartTurnRequest,
} from "../shared/contracts";
import { createDesktopProvider } from "./provider";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface ActiveRun {
  runId: string;
  abortController: AbortController;
  approvals: Map<string, Deferred<boolean>>;
  questions: Map<string, Deferred<string>>;
  completion: Promise<void>;
}

export interface DesktopRunManagerOptions {
  home?: string;
  loadConfig?: (home?: string) => Promise<DreamCodeConfig>;
  createProvider?: (
    prompt: string,
    profile: DreamCodeLlmProfile,
  ) => { provider: ModelProvider; model?: string };
  createRegistry?: typeof createDefaultToolRegistry;
  emitEvent?: (event: DesktopRunEvent) => unknown;
  emitApproval?: (request: DesktopApprovalRequest) => unknown;
  emitQuestion?: (request: DesktopQuestionRequest) => unknown;
  emitStatus?: (status: DesktopRunStatus) => unknown;
}

export class DesktopRunManager {
  readonly #home: string | undefined;
  readonly #loadConfig: NonNullable<DesktopRunManagerOptions["loadConfig"]>;
  readonly #createProvider: NonNullable<DesktopRunManagerOptions["createProvider"]>;
  readonly #createRegistry: NonNullable<DesktopRunManagerOptions["createRegistry"]>;
  readonly #emitEvent: NonNullable<DesktopRunManagerOptions["emitEvent"]>;
  readonly #emitApproval: NonNullable<DesktopRunManagerOptions["emitApproval"]>;
  readonly #emitQuestion: NonNullable<DesktopRunManagerOptions["emitQuestion"]>;
  readonly #emitStatus: NonNullable<DesktopRunManagerOptions["emitStatus"]>;
  #active?: ActiveRun;

  constructor(options: DesktopRunManagerOptions = {}) {
    this.#home = options.home;
    this.#loadConfig = options.loadConfig ?? loadDreamCodeConfig;
    this.#createProvider = options.createProvider ?? createDesktopProvider;
    this.#createRegistry = options.createRegistry ?? createDefaultToolRegistry;
    this.#emitEvent = options.emitEvent ?? (() => undefined);
    this.#emitApproval = options.emitApproval ?? (() => undefined);
    this.#emitQuestion = options.emitQuestion ?? (() => undefined);
    this.#emitStatus = options.emitStatus ?? (() => undefined);
  }

  get activeRunId(): string | undefined {
    return this.#active?.runId;
  }

  async start(request: StartTurnRequest): Promise<{ runId: string; completion: Promise<void> }> {
    if (this.#active) {
      throw desktopError("run_already_active", "Another Turn is already active.");
    }

    const run: ActiveRun = {
      runId: createId("run"),
      abortController: new AbortController(),
      approvals: new Map(),
      questions: new Map(),
      completion: Promise.resolve(),
    };
    this.#active = run;
    run.completion = this.#execute(run, request);
    return { runId: run.runId, completion: run.completion };
  }

  async stop(runId: string): Promise<void> {
    const run = this.#requireRun(runId);
    this.#interrupt(run, "Stopped by user.");
  }

  async respondApproval(response: ApprovalResponse): Promise<void> {
    const run = this.#requireRun(response.runId);
    const pending = run.approvals.get(response.requestId);
    if (!pending) {
      throw desktopError("stale_request", "Approval request is no longer pending.");
    }
    run.approvals.delete(response.requestId);
    pending.resolve(response.approved);
  }

  async respondQuestion(response: QuestionResponse): Promise<void> {
    const run = this.#requireRun(response.runId);
    const pending = run.questions.get(response.requestId);
    if (!pending) {
      throw desktopError("stale_request", "Question request is no longer pending.");
    }
    run.questions.delete(response.requestId);
    pending.resolve(response.answer);
  }

  async dispose(): Promise<void> {
    const run = this.#active;
    if (!run) {
      return;
    }
    this.#interrupt(run, "Desktop run manager disposed.");
    await run.completion;
  }

  async #execute(run: ActiveRun, request: StartTurnRequest): Promise<void> {
    let finalStatus: DesktopRunStatus = {
      runId: run.runId,
      status: "failed",
      error: statusError("run_failed", "Run ended without a terminal event."),
    };

    try {
      await this.#emitStatus({ runId: run.runId, status: "running" });
      const config = await this.#loadConfig(this.#home);
      const profile = resolveProfile(config, request.profileName);
      const { provider, model } = this.#createProvider(request.prompt, profile);

      for await (const event of runTurn({
        prompt: request.prompt,
        workspaceRoot: request.workspaceRoot,
        sessionId: request.sessionId,
        mode: request.mode,
        home: this.#home,
        provider,
        model,
        registry: this.#createRegistry({ mcpServers: config.mcpServers }),
        signal: run.abortController.signal,
        approvalHandler: (approval) => this.#requestApproval(run, approval),
        questionHandler: (question) => this.#requestQuestion(run, question),
      })) {
        await this.#emitEvent({ runId: run.runId, event });
        finalStatus = statusFromEvent(run.runId, event.type, event.payload) ?? finalStatus;
      }
    } catch (error) {
      finalStatus = {
        runId: run.runId,
        status: run.abortController.signal.aborted ? "interrupted" : "failed",
        ...(run.abortController.signal.aborted
          ? {}
          : { error: toDesktopError(error, "run_failed") }),
      };
    } finally {
      rejectPending(run, desktopError("stale_request", "Run is no longer active."));
      try {
        await this.#emitStatus(finalStatus);
      } finally {
        if (this.#active === run) {
          this.#active = undefined;
        }
      }
    }
  }

  async #requestApproval(run: ActiveRun, approval: ApprovalRequest): Promise<boolean> {
    const requestId = createId("approval");
    const pending = createDeferred<boolean>();
    run.approvals.set(requestId, pending);
    try {
      await this.#emitApproval({
        runId: run.runId,
        requestId,
        tool: approval.toolCall.name,
        input: approval.toolCall.input,
        reason: approval.decision.reason,
      });
      return await pending.promise;
    } finally {
      run.approvals.delete(requestId);
    }
  }

  async #requestQuestion(run: ActiveRun, question: string): Promise<string> {
    const requestId = createId("question");
    const pending = createDeferred<string>();
    run.questions.set(requestId, pending);
    try {
      await this.#emitQuestion({ runId: run.runId, requestId, question });
      return await pending.promise;
    } finally {
      run.questions.delete(requestId);
    }
  }

  #requireRun(runId: string): ActiveRun {
    if (!this.#active || this.#active.runId !== runId) {
      throw desktopError("stale_run", "Run is no longer active.");
    }
    return this.#active;
  }

  #interrupt(run: ActiveRun, reason: string): void {
    if (!run.abortController.signal.aborted) {
      run.abortController.abort(reason);
    }
    rejectPending(run, desktopError("run_interrupted", reason));
  }
}

function resolveProfile(
  config: DreamCodeConfig,
  requestedName: string | undefined,
): DreamCodeLlmProfile {
  const profileName = requestedName ?? config.currentProfile;
  const profile = profileName ? config.profiles[profileName] : undefined;
  if (!profile) {
    throw desktopError("profile_not_found", "No matching model profile is configured.");
  }
  return profile;
}

function statusFromEvent(
  runId: string,
  type: DesktopRunEvent["event"]["type"],
  payload: unknown,
): DesktopRunStatus | undefined {
  if (type === "turn.completed") {
    return { runId, status: "completed" };
  }
  if (type === "turn.interrupted") {
    return { runId, status: "interrupted" };
  }
  if (type === "turn.failed") {
    return {
      runId,
      status: "failed",
      error: statusError("run_failed", readFailureMessage(payload)),
    };
  }
  return undefined;
}

function readFailureMessage(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error) {
      return error;
    }
  }
  return "Turn failed.";
}

function rejectPending(run: ActiveRun, reason: DesktopManagerError): void {
  for (const pending of run.approvals.values()) {
    pending.reject(reason);
  }
  run.approvals.clear();
  for (const pending of run.questions.values()) {
    pending.reject(reason);
  }
  run.questions.clear();
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface DesktopManagerError extends Error, DesktopError {}

function desktopError(code: string, message: string): DesktopManagerError {
  return Object.assign(new Error(message), { code, recoverable: true });
}

function statusError(code: string, message: string): DesktopError {
  return { code, message, recoverable: true };
}

function toDesktopError(error: unknown, code: string): DesktopError {
  if (isDesktopManagerError(error)) {
    return statusError(error.code, error.message);
  }
  return statusError(code, error instanceof Error ? error.message : String(error));
}

function isDesktopManagerError(error: unknown): error is DesktopManagerError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      "message" in error &&
      "recoverable" in error,
  );
}
