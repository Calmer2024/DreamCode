import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBuilder, contextOptionsForModel } from "@dreamcode/context";
import { UsageCalibrator } from "@dreamcode/models";
import { buildPermissionCapabilityContract, PermissionEngine } from "@dreamcode/safety";
import type {
  AgentEvent,
  ChangedFile,
  ChatMessage,
  FinalSummary,
  ModelProvider,
  NormalizedToolCall,
  PermissionDecision,
  RunMode,
  TodoItem,
  ToolCallObservation,
  ToolModelSpec,
  ToolResult,
  Turn,
} from "@dreamcode/shared";
import { createId, makeEvent, nowIso, toErrorMessage } from "@dreamcode/shared";
import {
  parseExplicitSkillInvocations,
  renderSkillCatalog,
  SkillRegistry,
  type SkillSnapshot,
} from "@dreamcode/skills";
import {
  createSession,
  openSession,
  PersistedSkillState,
  rebuildSessionIndex,
  replaySession,
} from "@dreamcode/store";
import { createDefaultToolRegistry, type ToolRegistry } from "@dreamcode/tools";
import { ToolResultAggregator } from "./tool-result-aggregator.js";
import { buildToolCallWaves, mapWithConcurrency } from "./tool-scheduler.js";

export interface ApprovalRequest {
  toolCall: NormalizedToolCall;
  decision: PermissionDecision;
}

export interface RunTurnInput {
  prompt: string;
  workspaceRoot: string;
  provider: ModelProvider;
  sessionId?: string;
  model?: string;
  mode?: RunMode;
  conversationSummary?: string;
  home?: string;
  maxToolCalls?: number;
  registry?: ToolRegistry;
  permissionEngine?: PermissionEngine;
  contextBuilder?: ContextBuilder;
  skillRegistry?: SkillRegistry;
  signal?: AbortSignal;
  approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;
  questionHandler?: (question: string) => Promise<string>;
}

export interface RunTurnState {
  messages: ChatMessage[];
  observations: ToolCallObservation[];
  todoItems: TodoItem[];
  changedFiles: ChangedFile[];
  commands: FinalSummary["commands"];
}

export async function* runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
  const mode = input.mode ?? "yolo";
  const registry = input.registry ?? createDefaultToolRegistry();
  const permissionEngine = input.permissionEngine ?? new PermissionEngine();
  const contextOptions = contextOptionsForModel(input.provider.name, input.model);
  const contextBuilder = input.contextBuilder ?? new ContextBuilder(contextOptions);
  const maxToolCalls = input.maxToolCalls ?? 80;
  const { session, eventLog } = input.sessionId
    ? await openSession({ sessionId: input.sessionId, home: input.home })
    : await createSession({
        workspaceRoot: input.workspaceRoot,
        home: input.home,
      });
  const priorEvents = input.sessionId ? await eventLog.readAll() : [];
  const resumeState = input.sessionId ? replaySession(priorEvents) : undefined;
  const turn: Turn = {
    id: createId("turn"),
    sessionId: session.id,
    prompt: input.prompt,
    mode,
    status: "running",
    startedAt: nowIso(),
  };
  const state: RunTurnState = {
    messages: projectConversationMessages(priorEvents),
    observations: [],
    todoItems: resumeState?.todoItems ?? [],
    // A turn summary must describe only the changes produced by this turn.
    // Session-level history is replayed separately and must not seed this list.
    changedFiles: [],
    commands: resumeState?.commands ?? [],
  };
  if (input.conversationSummary?.trim()) {
    state.messages.push({
      role: "system",
      content: `Additional conversation context:\n${input.conversationSummary.trim()}`,
    });
  }
  let toolCallCount = 0;
  let consecutiveFailures = 0;
  let workspaceRevision = 0;
  let forceSynthesisReason: "budget_exhausted" | "repeated_tools" | undefined;
  let latestCheckpointKey: string | undefined;
  const inspectionCounts = new Map<string, number>();
  const readOnlyCache = new Map<string, ToolResult>();
  const usageCalibrator = new UsageCalibrator();
  await usageCalibrator.load(input.home);
  const capability = buildPermissionCapabilityContract(mode, process.platform);
  const persistedSkillState = input.skillRegistry
    ? undefined
    : await PersistedSkillState.open({ home: input.home, workspaceRoot: session.workspaceRoot });
  const ownedSkillRegistry = input.skillRegistry
    ? undefined
    : new SkillRegistry({
        workspaceRoot: session.workspaceRoot,
        dreamCodeHome: input.home,
        userHome: os.homedir(),
        customRoots: persistedSkillState?.customRoots(),
        state: persistedSkillState,
      });
  const skillSnapshot: SkillSnapshot = input.skillRegistry
    ? input.skillRegistry.current().generation > 0
      ? input.skillRegistry.current()
      : await input.skillRegistry.initialize()
    : await ownedSkillRegistry!.initialize();
  const loadedSkillIds = new Set<string>();
  const baseSkills = skillSnapshot.createTurnContext();
  const skills = {
    ...baseSkills,
    load: async (skillId: string) => {
      const loaded = await baseSkills.load(skillId);
      loadedSkillIds.add(skillId);
      return loaded;
    },
  };
  const explicitSkills = parseExplicitSkillInvocations(input.prompt, skillSnapshot);
  const catalogMaxChars = Math.max(
    1,
    Math.floor((contextOptions.maxContextTokens ?? 100_000) * 0.02 * 4),
  );
  const skillCatalog = renderSkillCatalog(skillSnapshot.catalog, catalogMaxChars);

  const emit = async <TPayload>(
    type: AgentEvent["type"],
    payload: TPayload,
  ): Promise<AgentEvent<TPayload>> => {
    const event = makeEvent(type, {
      sessionId: session.id,
      turnId: turn.id,
      payload,
    });
    await eventLog.append(event);
    return event;
  };

  yield await emit(input.sessionId ? "session.resumed" : "session.created", {
    session,
    restored: resumeState
      ? {
          status: resumeState.status,
          turnCount: resumeState.turns.length,
          changedFiles: resumeState.changedFiles.map((file) => file.path),
          latestSummary: resumeState.latestSummary?.message,
        }
      : undefined,
  });
  yield await emit("turn.started", { turn });
  const userEvent = await emit("user.message", { content: input.prompt });
  yield userEvent;
  state.messages.push({ id: userEvent.id, role: "user", content: explicitSkills.prompt });
  if (explicitSkills.errors.length) {
    state.messages.push({
      role: "system",
      content: `Explicit Skill invocation failed:\n${explicitSkills.errors.map((error) => `- ${error}`).join("\n")}\nTell the user the exact reason and do not silently substitute another Skill.`,
    });
  }
  for (const skillId of explicitSkills.skillIds) {
    const loaded = await skills.load(skillId);
    const toolCallId = createId("explicit_skill");
    state.messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolCallId, name: "skill.load", input: { skillId } }],
    });
    state.messages.push({
      role: "tool",
      name: "skill.load",
      toolCallId,
      content: loaded.content,
    });
    yield await emit("skill.loaded", {
      toolCallId,
      name: loaded.name,
      path: loaded.path,
      skillId: loaded.skillId,
      explicit: true,
    });
  }

  try {
    while (true) {
      throwIfInterrupted(input.signal);
      const synthesizing = forceSynthesisReason !== undefined;
      const budgetMessage = synthesizing
        ? {
            role: "system" as const,
            content:
              forceSynthesisReason === "budget_exhausted"
                ? "The tool budget is exhausted. Do not call tools. Give the most useful final answer from existing evidence and state anything unfinished."
                : "Repeated tool requests were detected. Do not call tools. Use the evidence already collected and give the final answer now.",
          }
        : buildBudgetGuidance(toolCallCount, maxToolCalls);
      // Expose every registered tool to the model. PermissionEngine remains the
      // execution-time gate for tools that require approval or are denied.
      const toolSpecs = synthesizing ? [] : registry.toModelSpecs(mode);
      const context = await contextBuilder.build({
        mode,
        workspaceRoot: session.workspaceRoot,
        messages: budgetMessage ? [...state.messages, budgetMessage] : state.messages,
        todoItems: state.todoItems,
        skillCatalog,
        tools: toolSpecs,
        model: input.model ?? "",
        estimateInputTokens: input.provider.estimateInputTokens
          ? async (estimateInput) => {
              const base = await input.provider.estimateInputTokens!({
                ...estimateInput,
                providerId: input.provider.name,
              });
              const baseInputTokens = base.baseInputTokens ?? base.inputTokens;
              const requestClass = estimateInput.tools.length ? "with_tools" : "messages_only";
              const calibrated = usageCalibrator.estimate(
                baseInputTokens,
                input.provider.name,
                input.model ?? "",
                requestClass,
              );
              return {
                ...base,
                baseInputTokens,
                calibratedInputTokens: calibrated.calibratedInputTokens,
                correctionRatio: calibrated.correctionRatio,
                sampleCount: calibrated.sampleCount,
                coldStart: calibrated.coldStart,
                inputTokens: calibrated.calibratedInputTokens,
              };
            }
          : undefined,
      });
      throwIfInterrupted(input.signal);
      yield await emit("context.built", {
        summary: context.summary,
        estimatedTokens: context.estimatedTokens,
        maxTokens: context.maxTokens,
        compressed: context.compressed,
        tokenEstimate: context.tokenEstimate,
        permissionContract: capability,
      });
      if (context.compressed && context.checkpoint) {
        const checkpointKey = JSON.stringify(context.checkpoint.summary);
        if (checkpointKey !== latestCheckpointKey) {
          latestCheckpointKey = checkpointKey;
          yield await emit("context.compressed", {
            checkpoint: context.checkpoint,
            summary: context.summary,
            estimatedTokens: context.estimatedTokens,
            maxTokens: context.maxTokens,
            tokenEstimate: context.tokenEstimate,
          });
        }
      }

      yield await emit("model.started", {
        provider: input.provider.name,
        model: input.model ?? "default",
        toolCount: toolSpecs.length,
        tools: toolSpecs.map((tool) => tool.name),
        phase: synthesizing ? "synthesis" : "execution",
      });

      let assistantText = "";
      const toolCalls: NormalizedToolCall[] = [];
      let usageReported = false;

      for await (const modelEvent of input.provider.stream({
        messages: context.messages,
        tools: toolSpecs,
        model: input.model ?? "",
        mode,
        workspaceRoot: session.workspaceRoot,
        signal: input.signal,
      })) {
        throwIfInterrupted(input.signal);
        if (modelEvent.type === "text_delta") {
          assistantText += modelEvent.text;
          yield await emit("model.delta", { text: modelEvent.text });
        }
        if (modelEvent.type === "tool_call") {
          if (!synthesizing) {
            toolCalls.push(modelEvent.toolCall);
            yield await emit("model.tool_call", { toolCall: modelEvent.toolCall });
          }
        }
        if (modelEvent.type === "usage") {
          usageReported = true;
          const estimate = context.tokenEstimate;
          if (estimate) {
            usageCalibrator.observe(
              estimate.baseInputTokens ?? estimate.inputTokens,
              modelEvent.usage.inputTokens,
              input.provider.name,
              input.model ?? "",
              toolSpecs.length ? "with_tools" : "messages_only",
            );
            await usageCalibrator.persist(input.home);
          }
          yield await emit("model.usage", { usage: modelEvent.usage });
        }
        throwIfInterrupted(input.signal);
      }

      if (!usageReported) {
        const inputTokens = context.estimatedTokens;
        const outputTokens = Math.ceil(
          (assistantText.length + JSON.stringify(toolCalls.map(canonicalToolCall)).length) / 4,
        );
        yield await emit("model.usage", {
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
          estimated: true,
        });
      }

      const assistantMessage: ChatMessage = {
        id: createId("msg"),
        role: "assistant",
        content: assistantText.trim(),
        toolCalls: toolCalls.map(canonicalToolCall),
      };
      const assistantEvent = await emit("assistant.message", { message: assistantMessage });
      yield assistantEvent;
      state.messages.push({ ...assistantMessage, id: assistantEvent.id });

      if (synthesizing) {
        const fallback =
          forceSynthesisReason === "budget_exhausted"
            ? "Tool budget exhausted. Returning the evidence collected so far; some work may remain."
            : "Stopped after repeated tool requests and returned the evidence already collected.";
        const summary = buildFinalSummary({
          status:
            forceSynthesisReason === "budget_exhausted" ? "budget_exhausted" : "completed_partial",
          message: assistantText.trim() || fallback,
          state,
          eventLogPath: eventLog.filePath,
        });
        yield await emit("turn.completed", { summary });
        await safelyRebuildIndex(input.home);
        return;
      }

      if (toolCalls.length === 0) {
        const summary = buildFinalSummary({
          status: "completed",
          message: assistantText.trim() || "Task completed.",
          state,
          eventLogPath: eventLog.filePath,
        });
        yield await emit("turn.completed", { summary });
        await safelyRebuildIndex(input.home);
        return;
      }

      const executionContext = {
        workspaceRoot: session.workspaceRoot,
        sessionDir: session.sessionDir,
        sessionId: session.id,
        mode,
        toolCallId: "scheduler",
        signal: input.signal,
        questionHandler: input.questionHandler,
        skills,
      };
      const resultAggregator = new ToolResultAggregator();
      const waves = buildToolCallWaves(registry, toolCalls, executionContext);
      yield await emit("tool.schedule.planned", {
        toolCallCount: toolCalls.length,
        actionCount: waves.reduce(
          (sum, wave) =>
            sum + wave.calls.reduce((waveSum, call) => waveSum + (call.plan.actionCost ?? 1), 0),
          0,
        ),
        parallelCallCount: waves
          .filter((wave) => wave.mode === "parallel")
          .reduce((sum, wave) => sum + wave.calls.length, 0),
        waves: waves.map((wave, index) => ({
          index,
          mode: wave.mode,
          maxConcurrency: wave.maxConcurrency,
          toolCallIds: wave.calls.map((call) => call.toolCall.id),
        })),
      });

      for (const wave of waves) {
        const prepared: Array<{
          toolCall: NormalizedToolCall;
          decision: PermissionDecision;
          signature: string;
          inspectionCount: number;
          cacheAllowed: boolean;
          cached?: ToolResult;
          cacheHit: boolean;
          yieldedToolEvents: AgentEvent[];
        }> = [];

        for (const scheduled of wave.calls) {
          const { toolCall } = scheduled;
          const actionCost = scheduled.plan.actionCost ?? 1;
          if (
            forceSynthesisReason === "budget_exhausted" ||
            toolCallCount + actionCost > maxToolCalls
          ) {
            const result: ToolResult = {
              toolCallId: toolCall.id,
              status: "cancelled",
              summary: `Tool action budget exhausted (${maxToolCalls}); this call costing ${actionCost} action(s) was not executed.`,
            };
            state.messages.push(resultAggregator.project(toolCall, result));
            forceSynthesisReason = "budget_exhausted";
            continue;
          }
          toolCallCount += actionCost;

          const preflightResult = await registry.get(toolCall.name)?.preflight?.(toolCall.input, {
            ...executionContext,
            toolCallId: toolCall.id,
          });
          if (preflightResult) {
            const validationDecision: PermissionDecision = {
              decision: "deny",
              reason: "Tool input validation failed before permission evaluation.",
              risk: [],
              reviewer: "rules",
            };
            yield await emit("tool.completed", {
              toolCallId: toolCall.id,
              tool: toolCall.name,
              status: preflightResult.status,
              summary: preflightResult.summary,
              error: preflightResult.error,
              execution: preflightResult.execution,
            });
            state.observations.push({
              toolCall,
              decision: validationDecision,
              result: preflightResult,
            });
            state.messages.push(resultAggregator.project(toolCall, preflightResult));
            consecutiveFailures += 1;
            if (consecutiveFailures >= 5) {
              throw new Error("Stopped after 5 consecutive tool failures.");
            }
            continue;
          }

          const initialDecision = permissionEngine.decide({
            mode,
            workspaceRoot: session.workspaceRoot,
            toolCall,
          });
          const undeclaredCapability = getUndeclaredSkillCapability(
            skillSnapshot,
            loadedSkillIds,
            toolCall.name,
          );
          if (undeclaredCapability) {
            yield await emit("skill.capability.undeclared", {
              toolCallId: toolCall.id,
              tool: toolCall.name,
              capability: undeclaredCapability,
              skillIds: [...loadedSkillIds],
            });
          }
          const finalDecision = await resolveApproval({
            decision: initialDecision,
            toolCall,
            approvalHandler: input.approvalHandler,
          });
          throwIfInterrupted(input.signal);
          yield await emit("permission.decided", {
            toolCallId: toolCall.id,
            tool: toolCall.name,
            decision: finalDecision,
          });

          const signature = `${workspaceRevision}:${makeToolCallSignature(toolCall)}`;
          const inspectionCount = (inspectionCounts.get(signature) ?? 0) + 1;
          inspectionCounts.set(signature, inspectionCount);
          const cacheAllowed = !registry.processSupervisor.hasActiveProcess(session.workspaceRoot);
          prepared.push({
            toolCall,
            decision: finalDecision,
            signature,
            inspectionCount,
            cacheAllowed,
            cached:
              cacheAllowed && readOnlyTools.has(toolCall.name)
                ? readOnlyCache.get(signature)
                : undefined,
            cacheHit: false,
            yieldedToolEvents: [],
          });
        }

        const waveExecutions = new Map<string, Promise<ToolResult>>();
        const results = await mapWithConcurrency(prepared, wave.maxConcurrency, async (item) => {
          if (item.decision.decision !== "allow") {
            return deniedToolResult(item.toolCall.id, item.toolCall.name, item.decision.reason);
          }
          if (item.cached) {
            item.cacheHit = true;
            return compactCacheHit(item.cached, item.toolCall.id, workspaceRevision);
          }
          if (wave.mode === "parallel" && readOnlyTools.has(item.toolCall.name)) {
            const existing = waveExecutions.get(item.signature);
            if (existing) {
              item.cacheHit = true;
              return compactCacheHit(await existing, item.toolCall.id, workspaceRevision);
            }
          }
          const execution = executeToolWithEvents({
            registry,
            toolCall: item.toolCall,
            sessionId: session.id,
            sessionDir: session.sessionDir,
            workspaceRoot: session.workspaceRoot,
            mode,
            signal: input.signal,
            questionHandler: input.questionHandler,
            skills,
            emit,
            yieldEvent: async (event) => {
              item.yieldedToolEvents.push(event);
            },
          });
          if (wave.mode === "parallel" && readOnlyTools.has(item.toolCall.name)) {
            waveExecutions.set(item.signature, execution);
          }
          return execution;
        });

        for (let index = 0; index < prepared.length; index += 1) {
          const item = prepared[index]!;
          const result = results[index]!;
          for (const event of item.yieldedToolEvents) yield event;

          const emittedCompletion = item.yieldedToolEvents.some(
            (event) => event.type === "tool.completed",
          );
          if (!emittedCompletion) {
            yield await emit("tool.completed", {
              toolCallId: item.toolCall.id,
              tool: item.toolCall.name,
              status: result.status,
              summary: result.summary,
              cached: item.cacheHit,
              error: result.error,
              execution: result.execution,
              streams: result.streams,
              warnings: result.warnings,
              cache: result.cache,
            });
          }

          state.observations.push({ toolCall: item.toolCall, decision: item.decision, result });
          state.messages.push(resultAggregator.project(item.toolCall, result));
          applyResultToState(state, item.toolCall, result);
          if (
            item.cacheAllowed &&
            !item.cacheHit &&
            item.decision.decision === "allow" &&
            readOnlyTools.has(item.toolCall.name)
          ) {
            readOnlyCache.set(item.signature, result);
          }
          if (
            !item.cacheHit &&
            item.decision.decision === "allow" &&
            shouldInvalidateReadCache(registry, item.toolCall.name, result)
          ) {
            workspaceRevision += 1;
            readOnlyCache.clear();
          }
          if (item.inspectionCount >= 3 && readOnlyTools.has(item.toolCall.name)) {
            forceSynthesisReason = "repeated_tools";
          }
          throwIfInterrupted(input.signal);

          if (result.status === "success") {
            consecutiveFailures = 0;
          } else {
            consecutiveFailures += 1;
            if (consecutiveFailures >= 5) {
              throw new Error("Stopped after 5 consecutive tool failures.");
            }
          }
        }
      }
      if (toolCallCount >= maxToolCalls) forceSynthesisReason = "budget_exhausted";
    }
  } catch (error) {
    if (error instanceof TurnInterruptedError || input.signal?.aborted) {
      yield await emit("turn.interrupted", {
        reason: getAbortReason(input.signal) ?? toErrorMessage(error),
      });
      await safelyRebuildIndex(input.home);
      return;
    }

    const summary = buildFinalSummary({
      status: "failed",
      message: toErrorMessage(error),
      state,
      eventLogPath: eventLog.filePath,
    });
    yield await emit("turn.failed", { error: toErrorMessage(error), summary });
    await safelyRebuildIndex(input.home);
  }
}

class TurnInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnInterruptedError";
  }
}

function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TurnInterruptedError(getAbortReason(signal) ?? "Turn interrupted by user.");
  }
}

function getAbortReason(signal: AbortSignal | undefined): string | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  const reason = signal.reason;
  if (typeof reason === "string") {
    return reason;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  return "Turn interrupted by user.";
}

async function safelyRebuildIndex(home: string | undefined): Promise<void> {
  try {
    await rebuildSessionIndex(home);
  } catch {
    // The JSONL event log is the fact source. Index rebuild failures should not fail a turn.
  }
}

const readOnlyTools = new Set([
  "job_output",
  "job_list",
  "file.read",
  "file.list",
  "search.grep",
  "search.glob",
  "git.status",
  "git.diff",
]);

export function getUndeclaredSkillCapability(
  snapshot: SkillSnapshot,
  loadedSkillIds: ReadonlySet<string>,
  toolName: string,
): import("@dreamcode/skills").SkillCapability | undefined {
  if (!loadedSkillIds.size || toolName.startsWith("skill.")) return undefined;
  const capability = requiredSkillCapability(toolName);
  if (!capability) return undefined;
  const declared = new Set(
    [...loadedSkillIds].flatMap((skillId) => snapshot.get(skillId)?.metadata?.capabilities ?? []),
  );
  return declared.has(capability) ? undefined : capability;
}

function requiredSkillCapability(
  toolName: string,
): import("@dreamcode/skills").SkillCapability | undefined {
  if (
    toolName === "file.read" ||
    toolName === "file.list" ||
    toolName.startsWith("search.") ||
    toolName === "git.status" ||
    toolName === "git.diff" ||
    toolName === "artifact.read"
  ) {
    return "filesystem.read";
  }
  if (toolName === "file.write" || toolName === "file.patch") {
    return "filesystem.write";
  }
  if (toolName === "bash" || toolName === "pwsh") return "process.execute";
  if (toolName === "job_output" || toolName === "job_list" || toolName === "job_kill") return "process.execute";
  if (toolName.startsWith("web.")) return "network.access";
  if (toolName === "mcp.call") return "mcp.use";
  return undefined;
}


function compactCacheHit(
  source: ToolResult,
  toolCallId: string,
  workspaceRevision: number,
): ToolResult {
  return {
    toolCallId,
    status: "success",
    summary: `Cached result reference reused: ${source.summary}`,
    data: {
      sourceToolCallId: source.toolCallId,
      workspaceRevision,
    },
    cache: {
      outcome: "cache_hit",
      sourceToolCallId: source.toolCallId,
      workspaceRevision,
    },
  };
}

function shouldInvalidateReadCache(
  registry: ToolRegistry,
  toolName: string,
  result: ToolResult,
): boolean {
  if (readOnlyTools.has(toolName)) return false;
  if (result.execution && !result.execution.started) return false;
  if (toolName === "mcp.call") return true;
  const risk = registry.get(toolName)?.risk;
  return Boolean(risk?.writesFiles || risk?.runsCommands || risk?.externalSideEffects);
}

function makeToolCallSignature(toolCall: NormalizedToolCall): string {
  return `${toolCall.name} ${stableStringify(toolCall.input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const input = value as Record<string, unknown>;
  const entries = Object.keys(input)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(input[key])}`);
  return `{${entries.join(",")}}`;
}

function canonicalToolCall(toolCall: NormalizedToolCall): NormalizedToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    rawProvider: toolCall.rawProvider,
  };
}

function buildBudgetGuidance(toolCallCount: number, maxToolCalls: number): ChatMessage | undefined {
  const ratio = toolCallCount / maxToolCalls;
  if (ratio < 0.6) return undefined;
  const remaining = Math.max(0, maxToolCalls - toolCallCount);
  const instruction =
    ratio >= 0.9
      ? "Avoid low-value inspection. Finish the critical path and prepare the final answer."
      : ratio >= 0.8
        ? "Converge the plan and reuse existing evidence before calling more tools."
        : "The tool budget is becoming limited; prioritize calls that add new evidence.";
  return {
    role: "system",
    content: `Tool budget: ${remaining} of ${maxToolCalls} calls remain. ${instruction}`,
  };
}

function truncateContext(value: string, maxChars = 12_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[tool output truncated; use its artifact reference for more]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function projectConversationMessages(events: AgentEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingText = "";
  let pendingCalls: NormalizedToolCall[] = [];
  let pendingEventId: string | undefined;
  const flushPending = () => {
    if (!pendingText && !pendingCalls.length) return;
    messages.push({
      id: pendingEventId,
      role: "assistant",
      content: pendingText.trim(),
      toolCalls: pendingCalls,
    });
    pendingText = "";
    pendingCalls = [];
    pendingEventId = undefined;
  };

  for (const event of events) {
    if (event.type === "user.message") {
      flushPending();
      const payload = event.payload as { content?: string };
      if (payload.content) messages.push({ id: event.id, role: "user", content: payload.content });
      continue;
    }
    if (event.type === "model.started") {
      flushPending();
      continue;
    }
    if (event.type === "model.delta") {
      const payload = event.payload as { text?: string };
      pendingText += payload.text ?? "";
      pendingEventId ??= event.id;
      continue;
    }
    if (event.type === "model.tool_call") {
      const payload = event.payload as { toolCall?: NormalizedToolCall };
      if (payload.toolCall) pendingCalls.push(canonicalToolCall(payload.toolCall));
      pendingEventId ??= event.id;
      continue;
    }
    if (event.type === "assistant.message") {
      pendingText = "";
      pendingCalls = [];
      pendingEventId = undefined;
      const payload = event.payload as { message?: ChatMessage };
      if (payload.message) messages.push({ ...payload.message, id: event.id });
      continue;
    }
    if (event.type === "permission.decided") {
      flushPending();
      continue;
    }
    if (event.type === "tool.completed") {
      flushPending();
      const payload = event.payload as {
        toolCallId?: string;
        tool?: string;
        status?: ToolResult["status"];
        summary?: string;
        data?: unknown;
        artifactRefs?: string[];
        error?: ToolResult["error"];
        execution?: ToolResult["execution"];
        streams?: ToolResult["streams"];
        warnings?: string[];
        cache?: ToolResult["cache"];
      };
      if (payload.toolCallId) {
        messages.push({
          id: event.id,
          role: "tool",
          name: payload.tool,
          toolCallId: payload.toolCallId,
          content: [
            `Status: ${payload.status ?? "success"}`,
            `Summary: ${payload.summary ?? "Tool completed."}`,
            payload.data === undefined &&
            payload.error === undefined &&
            payload.execution === undefined &&
            payload.streams === undefined &&
            payload.warnings === undefined &&
            payload.cache === undefined
              ? undefined
              : `Data: ${truncateContext(
                  safeJson({
                    data: payload.data,
                    error: payload.error,
                    execution: payload.execution,
                    streams: payload.streams,
                    warnings: payload.warnings,
                    cache: payload.cache,
                  }),
                )}`,
            payload.artifactRefs?.length
              ? `Artifacts: ${payload.artifactRefs.join(", ")}`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        });
      }
      continue;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") flushPending();
  }
  flushPending();
  return messages;
}

async function resolveApproval(input: {
  decision: PermissionDecision;
  toolCall: NormalizedToolCall;
  approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;
}): Promise<PermissionDecision> {
  if (input.decision.decision !== "ask") {
    return input.decision;
  }

  if (!input.approvalHandler) {
    return {
      ...input.decision,
      decision: "deny",
      reviewer: "user",
      reason: `${input.decision.reason} No approval handler was available.`,
    };
  }

  const approved = await input.approvalHandler({
    toolCall: input.toolCall,
    decision: input.decision,
  });

  return {
    ...input.decision,
    decision: approved ? "allow" : "deny",
    reviewer: "user",
    reason: approved
      ? `User approved: ${input.decision.reason}`
      : `User denied: ${input.decision.reason}`,
  };
}

async function executeToolWithEvents(input: {
  registry: ToolRegistry;
  toolCall: NormalizedToolCall;
  workspaceRoot: string;
  sessionDir: string;
  sessionId: string;
  mode: RunMode;
  signal?: AbortSignal;
  questionHandler?: (question: string) => Promise<string>;
  skills?: import("@dreamcode/shared").SkillTurnContext;
  emit: <TPayload>(type: AgentEvent["type"], payload: TPayload) => Promise<AgentEvent<TPayload>>;
  yieldEvent: (event: AgentEvent) => Promise<void>;
}): Promise<ToolResult> {
  const tool = input.registry.get(input.toolCall.name);
  if (!tool) {
    return {
      toolCallId: input.toolCall.id,
      status: "error",
      summary: `Unknown tool: ${input.toolCall.name}`,
      error: {
        code: "unknown_tool",
        category: "validation",
        reason: "unknown_tool",
        message: `Unknown tool: ${input.toolCall.name}`,
        retryable: false,
      },
    };
  }

  await input.yieldEvent(
    await input.emit("tool.started", {
      toolCallId: input.toolCall.id,
      tool: input.toolCall.name,
      input: input.toolCall.input,
    }),
  );

  try {
    let result = await tool.execute(input.toolCall.input, {
      workspaceRoot: input.workspaceRoot,
      sessionDir: input.sessionDir,
      sessionId: input.sessionId,
      mode: input.mode,
      toolCallId: input.toolCall.id,
      signal: input.signal,
      questionHandler: input.questionHandler,
      skills: input.skills,
    });
    const externalized = await externalizeLargeToolResult({
      result,
      sessionDir: input.sessionDir,
      toolCallId: input.toolCall.id,
    });
    result = externalized.result;

    await input.yieldEvent(
      await input.emit("tool.completed", {
        toolCallId: input.toolCall.id,
        tool: input.toolCall.name,
        status: result.status,
        summary: result.summary,
        data: externalized.eventData,
        error: result.error,
        execution: result.execution,
        streams: result.streams,
        warnings: result.warnings,
        cache: result.cache,
        stdoutRef: result.stdoutRef,
        stderrRef: result.stderrRef,
        artifactRefs: result.artifactRefs,
      }),
    );

    for (const artifactRef of result.artifactRefs ?? []) {
      await input.yieldEvent(
        await input.emit("artifact.created", {
          toolCallId: input.toolCall.id,
          tool: input.toolCall.name,
          kind: input.toolCall.name.startsWith("web.") ? "web" : "tool",
          path: artifactRef,
        }),
      );
    }

    if (input.toolCall.name === "web.fetch" && result.status === "success") {
      const data = result.data as
        | { title?: string; url?: string; artifactRef?: string }
        | undefined;
      await input.yieldEvent(
        await input.emit("web.source.saved", {
          toolCallId: input.toolCall.id,
          title: data?.title,
          url: data?.url,
          path: data?.artifactRef,
        }),
      );
    }

    if (input.toolCall.name === "skill.load" && result.status === "success") {
      const data = result.data as { skillId?: string; name?: string; path?: string } | undefined;
      await input.yieldEvent(
        await input.emit("skill.loaded", {
          toolCallId: input.toolCall.id,
          name: data?.name,
          path: data?.path,
          skillId: data?.skillId,
        }),
      );
    }

    if (input.toolCall.name === "skill.read_resource" && result.status === "success") {
      const data = result.data as { skillId?: string; resourcePath?: string } | undefined;
      await input.yieldEvent(
        await input.emit("skill.resource.loaded", {
          toolCallId: input.toolCall.id,
          skillId: data?.skillId,
          resourcePath: data?.resourcePath,
        }),
      );
    }

    for (const changedFile of result.changedFiles ?? []) {
      if (changedFile.beforeSnapshotRef) {
        await input.yieldEvent(
          await input.emit("file.snapshot.created", {
            toolCallId: input.toolCall.id,
            path: changedFile.path,
            beforeHash: changedFile.beforeHash,
            snapshotRef: changedFile.beforeSnapshotRef,
          }),
        );
      }
      await input.yieldEvent(
        await input.emit("file.changed", { toolCallId: input.toolCall.id, changedFile }),
      );
    }

    if (input.toolCall.name === "todo.write") {
      const data = result.data as { items?: TodoItem[] } | undefined;
      await input.yieldEvent(
        await input.emit("todo.updated", {
          toolCallId: input.toolCall.id,
          items: data?.items ?? [],
        }),
      );
    }

    return result;
  } catch (error) {
    const result: ToolResult = {
      toolCallId: input.toolCall.id,
      status: "error",
      summary: toErrorMessage(error),
      error: {
        code: "tool_execution_failed",
        category: "internal",
        reason: "tool_execution_failed",
        message: toErrorMessage(error),
        retryable: false,
      },
    };
    await input.yieldEvent(
      await input.emit("tool.completed", {
        toolCallId: input.toolCall.id,
        tool: input.toolCall.name,
        status: result.status,
        summary: result.summary,
      }),
    );
    return result;
  }
}

async function externalizeLargeToolResult(input: {
  result: ToolResult;
  sessionDir: string;
  toolCallId: string;
}): Promise<{ result: ToolResult; eventData: unknown }> {
  if (input.result.data === undefined) {
    return { result: input.result, eventData: undefined };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input.result.data, null, 2);
  } catch {
    return { result: input.result, eventData: input.result.data };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= 24_000) return { result: input.result, eventData: input.result.data };

  const artifactsDir = path.join(input.sessionDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const fileName = `tool-${input.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_")}-output.json`;
  await writeFile(path.join(artifactsDir, fileName), serialized, "utf8");
  const artifactRef = `artifact://${encodeURIComponent(fileName)}`;
  const artifactRefs = [...new Set([...(input.result.artifactRefs ?? []), artifactRef])];
  return {
    result: { ...input.result, artifactRefs },
    eventData: {
      preview: serialized.slice(0, 8_000),
      bytes,
      truncated: true,
      artifactRef,
    },
  };
}

function applyResultToState(
  state: RunTurnState,
  toolCall: NormalizedToolCall,
  result: ToolResult,
): void {
  if (result.changedFiles?.length) {
    state.changedFiles.push(...result.changedFiles);
  }

  if (toolCall.name === "todo.write" && result.status === "success") {
    const data = result.data as { items?: TodoItem[] } | undefined;
    if (Array.isArray(data?.items)) {
      state.todoItems = data.items;
    }
  }

  if (
    (toolCall.name === "bash" || toolCall.name === "pwsh") &&
    result.status !== "denied"
  ) {
    const data = result.data as { command?: string; exitCode?: number } | undefined;
    state.commands.push({
      command: data?.command ?? JSON.stringify(toolCall.input),
      exitCode: data?.exitCode,
      summary: result.summary,
    });
  }
}

function deniedToolResult(toolCallId: string, toolName: string, reason: string): ToolResult {
  return {
    toolCallId,
    status: "denied",
    summary: reason,
    error: {
      code: "permission_denied",
      category: "permission",
      reason: "permission_denied",
      message: reason,
      retryable: false,
    },
    execution:
      toolName === "bash" || toolName === "pwsh"
        ? { outcome: "permission_denied", started: false }
        : undefined,
  };
}

function buildFinalSummary(input: {
  status: FinalSummary["status"];
  message: string;
  state: RunTurnState;
  eventLogPath: string;
}): FinalSummary {
  const risks = input.state.observations
    .filter((observation) => observation.result.status !== "success")
    .map(
      (observation) =>
        `${observation.toolCall.name}: ${observation.result.summary || observation.decision.reason}`,
    );

  return {
    status: input.status,
    message: input.message,
    changedFiles: input.state.changedFiles,
    commands: input.state.commands,
    risks,
    eventLogPath: input.eventLogPath,
  };
}
