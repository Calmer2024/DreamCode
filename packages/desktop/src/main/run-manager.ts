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
  resolve(value: T): boolean;
  reject(reason: unknown): boolean;
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
    if (!pending?.resolve(response.approved)) {
      throw desktopError("stale_request", "Approval request is no longer pending.");
    }
  }

  async respondQuestion(response: QuestionResponse): Promise<void> {
    const run = this.#requireRun(response.runId);
    const pending = run.questions.get(response.requestId);
    if (!pending?.resolve(response.answer)) {
      throw desktopError("stale_request", "Question request is no longer pending.");
    }
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
    let sensitiveValues: string[] = [];
    let finalStatus: DesktopRunStatus = {
      runId: run.runId,
      status: "failed",
      error: statusError("run_failed", "Run ended without a terminal event."),
    };

    try {
      await this.#emitStatus({ runId: run.runId, status: "running" });
      let config: DreamCodeConfig;
      try {
        config = await this.#loadConfig(this.#home);
      } catch {
        throw desktopError("config_load_failed", "Failed to load DreamCode configuration.");
      }
      sensitiveValues = collectSensitiveValues(config);
      const profile = resolveProfile(config, request.profileName);
      let providerResult: ReturnType<NonNullable<DesktopRunManagerOptions["createProvider"]>>;
      try {
        providerResult = this.#createProvider(request.prompt, profile);
      } catch (error) {
        throw desktopError(
          "provider_setup_failed",
          redactText(readErrorMessage(error), sensitiveValues),
        );
      }
      const { model } = providerResult;
      const provider = redactProviderErrors(providerResult.provider, sensitiveValues);

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
        const outboundEvent = sanitizeEvent(event, sensitiveValues);
        await this.#emitEvent({ runId: run.runId, event: outboundEvent });
        finalStatus =
          statusFromEvent(run.runId, outboundEvent.type, outboundEvent.payload) ?? finalStatus;
      }
    } catch (error) {
      finalStatus = {
        runId: run.runId,
        status: run.abortController.signal.aborted ? "interrupted" : "failed",
        ...(run.abortController.signal.aborted
          ? {}
          : { error: toDesktopError(error, "run_failed", sensitiveValues) }),
      };
    } finally {
      await this.#finalize(run, finalStatus, sensitiveValues);
    }
  }

  async #requestApproval(run: ActiveRun, approval: ApprovalRequest): Promise<boolean> {
    const requestId = createId("approval");
    const pending = createDeferred<boolean>();
    run.approvals.set(requestId, pending);
    try {
      return await coordinateRequest(
        run.abortController.signal,
        () =>
          this.#emitApproval({
            runId: run.runId,
            requestId,
            tool: approval.toolCall.name,
            input: approval.toolCall.input,
            reason: approval.decision.reason,
          }),
        pending,
      );
    } finally {
      run.approvals.delete(requestId);
    }
  }

  async #requestQuestion(run: ActiveRun, question: string): Promise<string> {
    const requestId = createId("question");
    const pending = createDeferred<string>();
    run.questions.set(requestId, pending);
    try {
      return await coordinateRequest(
        run.abortController.signal,
        () => this.#emitQuestion({ runId: run.runId, requestId, question }),
        pending,
      );
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

  async #finalize(
    run: ActiveRun,
    finalStatus: DesktopRunStatus,
    sensitiveValues: string[],
  ): Promise<void> {
    rejectPending(run, desktopError("stale_request", "Run is no longer active."));
    let deliveryError: DesktopError | undefined;
    try {
      await this.#emitStatus(finalStatus);
    } catch (error) {
      deliveryError = desktopError(
        "status_delivery_failed",
        redactText(readErrorMessage(error), sensitiveValues),
      );
    } finally {
      if (this.#active === run) {
        this.#active = undefined;
      }
    }
    if (deliveryError) {
      throw deliveryError;
    }
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

function rejectPending(run: ActiveRun, reason: DesktopError): void {
  for (const pending of run.approvals.values()) {
    pending.reject(reason);
  }
  for (const pending of run.questions.values()) {
    pending.reject(reason);
  }
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let settleResolve!: (value: T) => void;
  let settleReject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    settleResolve = resolvePromise;
    settleReject = rejectPromise;
  });
  return {
    promise,
    resolve(value) {
      if (settled) {
        return false;
      }
      settled = true;
      settleResolve(value);
      return true;
    },
    reject(reason) {
      if (settled) {
        return false;
      }
      settled = true;
      settleReject(reason);
      return true;
    },
  };
}

async function coordinateRequest<T>(
  signal: AbortSignal,
  emit: () => unknown,
  pending: Deferred<T>,
): Promise<T> {
  const emission = Promise.resolve()
    .then(emit)
    .catch((error: unknown) => {
      pending.reject(error);
      throw error;
    });
  const exchange = Promise.all([emission, pending.promise]).then(([, response]) => response);
  return abortable(exchange, signal);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function desktopError(code: string, message: string): DesktopError {
  return { code, message, recoverable: true };
}

function statusError(code: string, message: string): DesktopError {
  return { code, message, recoverable: true };
}

function toDesktopError(error: unknown, code: string, sensitiveValues: string[]): DesktopError {
  if (isDesktopError(error)) {
    return statusError(error.code, redactText(error.message, sensitiveValues));
  }
  return statusError(code, redactText(readErrorMessage(error), sensitiveValues));
}

function isDesktopError(error: unknown): error is DesktopError {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as Partial<DesktopError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.recoverable === "boolean"
  );
}

function collectSensitiveValues(config: DreamCodeConfig): string[] {
  const values = new Set<string>();
  for (const profile of Object.values(config.profiles)) {
    addSensitiveValue(values, profile.apiKey);
    if (profile.apiKeyEnv) {
      addSensitiveValue(values, process.env[profile.apiKeyEnv]);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function addSensitiveValue(values: Set<string>, value: string | undefined): void {
  if (!value) {
    return;
  }
  values.add(value);
  const trimmed = value.trim();
  if (trimmed) {
    values.add(trimmed);
  }
}

function redactProviderErrors(provider: ModelProvider, sensitiveValues: string[]): ModelProvider {
  return {
    name: provider.name,
    async *stream(input) {
      try {
        yield* provider.stream(input);
      } catch (error) {
        throw new Error(redactText(readErrorMessage(error), sensitiveValues));
      }
    },
  };
}

function sanitizeEvent(
  event: DesktopRunEvent["event"],
  sensitiveValues: string[],
): DesktopRunEvent["event"] {
  if (sensitiveValues.length === 0) {
    return event;
  }
  return { ...event, payload: sanitizeValue(event.payload, sensitiveValues) };
}

function sanitizeValue(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, sensitiveValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, sensitiveValues));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, sensitiveValues)]),
    );
  }
  return value;
}

function redactText(message: string, sensitiveValues: string[]): string {
  let redacted = message;
  for (const sensitiveValue of sensitiveValues) {
    redacted = redacted.replaceAll(sensitiveValue, "[REDACTED]");
  }
  return redacted;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error || isDesktopError(error)) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unexpected run failure.";
}
