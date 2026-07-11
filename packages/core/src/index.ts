import { ContextBuilder } from "@dreamcode/context";
import { PermissionEngine } from "@dreamcode/safety";
import type {
  AgentEvent,
  ChangedFile,
  FinalSummary,
  ModelProvider,
  NormalizedToolCall,
  PermissionDecision,
  RunMode,
  TodoItem,
  ToolCallObservation,
  ToolResult,
  Turn,
} from "@dreamcode/shared";
import { createId, makeEvent, nowIso, toErrorMessage } from "@dreamcode/shared";
import { createSession, openSession, rebuildSessionIndex, replaySession } from "@dreamcode/store";
import { createDefaultToolRegistry, type ToolRegistry } from "@dreamcode/tools";

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
  signal?: AbortSignal;
  approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;
  questionHandler?: (question: string) => Promise<string>;
}

export interface RunTurnState {
  observations: ToolCallObservation[];
  todoItems: TodoItem[];
  changedFiles: ChangedFile[];
  commands: FinalSummary["commands"];
}

export async function* runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
  const mode = input.mode ?? "yolo";
  const registry = input.registry ?? createDefaultToolRegistry();
  const permissionEngine = input.permissionEngine ?? new PermissionEngine();
  const contextBuilder = input.contextBuilder ?? new ContextBuilder();
  const maxToolCalls = input.maxToolCalls ?? 80;
  const { session, eventLog } = input.sessionId
    ? await openSession({ sessionId: input.sessionId, home: input.home })
    : await createSession({
        workspaceRoot: input.workspaceRoot,
        home: input.home,
      });
  const priorEvents = input.sessionId ? await eventLog.readAll() : [];
  const resumeState = input.sessionId ? replaySession(priorEvents) : undefined;
  const conversationSummary = [
    input.conversationSummary,
    resumeState ? buildResumeSummary(resumeState) : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  const turn: Turn = {
    id: createId("turn"),
    sessionId: session.id,
    prompt: input.prompt,
    mode,
    status: "running",
    startedAt: nowIso(),
  };
  const state: RunTurnState = {
    observations: [],
    todoItems: [],
    changedFiles: [],
    commands: [],
  };
  let toolCallCount = 0;
  let consecutiveFailures = 0;
  const postChangeInspectionCounts = new Map<string, number>();

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
  yield await emit("user.message", { content: input.prompt });

  try {
    while (toolCallCount < maxToolCalls) {
      throwIfInterrupted(input.signal);
      const context = await contextBuilder.build({
        prompt: input.prompt,
        mode,
        workspaceRoot: session.workspaceRoot,
        conversationSummary,
        observations: state.observations,
        todoItems: state.todoItems,
      });
      throwIfInterrupted(input.signal);
      yield await emit("context.built", { summary: context.summary });

      yield await emit("model.started", {
        provider: input.provider.name,
        model: input.model ?? "default",
        toolCount: registry.list().length,
      });

      let assistantText = "";
      const toolCalls: NormalizedToolCall[] = [];

      for await (const modelEvent of input.provider.stream({
        messages: context.messages,
        tools: registry.toModelSpecs(),
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
          toolCalls.push(modelEvent.toolCall);
          yield await emit("model.tool_call", { toolCall: modelEvent.toolCall });
        }
        if (modelEvent.type === "usage") {
          yield await emit("model.usage", { usage: modelEvent.usage });
        }
        throwIfInterrupted(input.signal);
      }

      if (toolCalls.length === 0) {
        const summary = buildFinalSummary({
          status: "completed",
          message: assistantText.trim() || "Task completed.",
          state,
          eventLogPath: eventLog.filePath,
        });
        yield await emit("session.summarized", { summary: summary.message });
        yield await emit("turn.completed", { summary });
        await safelyRebuildIndex(input.home);
        return;
      }

      for (const toolCall of toolCalls) {
        toolCallCount += 1;
        if (toolCallCount > maxToolCalls) {
          throw new Error(`Maximum tool call count reached (${maxToolCalls}).`);
        }

        const repeatedInspection = recordPostChangeInspection({
          state,
          counts: postChangeInspectionCounts,
          toolCall,
        });
        if (repeatedInspection) {
          const summary = buildFinalSummary({
            status: "completed",
            message: `Task completed after applying changes. Stopped after repeated post-change inspection: ${repeatedInspection}.`,
            state,
            eventLogPath: eventLog.filePath,
          });
          yield await emit("session.summarized", { summary: summary.message });
          yield await emit("turn.completed", { summary });
          await safelyRebuildIndex(input.home);
          return;
        }

        const initialDecision = permissionEngine.decide({
          mode,
          workspaceRoot: session.workspaceRoot,
          toolCall,
        });
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

        const yieldedToolEvents: AgentEvent[] = [];
        const result =
          finalDecision.decision === "allow"
            ? await executeToolWithEvents({
                registry,
                toolCall,
                sessionDir: session.sessionDir,
                workspaceRoot: session.workspaceRoot,
                mode,
                signal: input.signal,
                questionHandler: input.questionHandler,
                emit,
                yieldEvent: async (event) => {
                  yieldedToolEvents.push(event);
                },
              })
            : deniedToolResult(toolCall.id, finalDecision.reason);

        for (const event of yieldedToolEvents) {
          yield event;
        }
        yieldedToolEvents.length = 0;

        if (finalDecision.decision !== "allow") {
          yield await emit("tool.completed", {
            toolCallId: toolCall.id,
            tool: toolCall.name,
            status: result.status,
            summary: result.summary,
          });
        }

        const observation: ToolCallObservation = {
          toolCall,
          decision: finalDecision,
          result,
        };
        state.observations.push(observation);
        applyResultToState(state, toolCall, result);
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

    throw new Error(`Maximum tool call count reached (${maxToolCalls}).`);
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
    yield await emit("session.summarized", { summary: summary.message });
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

function buildResumeSummary(state: ReturnType<typeof replaySession>): string {
  const changedFiles = state.changedFiles.map((file) => `${file.operation}: ${file.path}`);
  const commands = state.commands.map(
    (command) => `${command.command} -> ${command.exitCode ?? "unknown"} (${command.summary})`,
  );
  return [
    "This turn resumes an existing DreamCode session.",
    `Previous status: ${state.status}.`,
    state.latestSummary ? `Latest summary: ${state.latestSummary.message}` : undefined,
    state.todoItems.length
      ? `Previous todo:\n${state.todoItems.map((item) => `- ${item.status}: ${item.content}`).join("\n")}`
      : undefined,
    changedFiles.length ? `Files already changed:\n${changedFiles.join("\n")}` : undefined,
    commands.length ? `Commands already run:\n${commands.join("\n")}` : undefined,
    state.warnings.length ? `Replay warnings:\n${state.warnings.join("\n")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

async function safelyRebuildIndex(home: string | undefined): Promise<void> {
  try {
    await rebuildSessionIndex(home);
  } catch {
    // The JSONL event log is the fact source. Index rebuild failures should not fail a turn.
  }
}

const postChangeInspectionTools = new Set([
  "file.read",
  "file.list",
  "search.grep",
  "search.glob",
  "git.status",
  "git.diff",
]);

function recordPostChangeInspection(input: {
  state: RunTurnState;
  counts: Map<string, number>;
  toolCall: NormalizedToolCall;
}): string | undefined {
  if (!input.state.changedFiles.length || !postChangeInspectionTools.has(input.toolCall.name)) {
    return undefined;
  }

  const signature = makeToolCallSignature(input.toolCall);
  const count = (input.counts.get(signature) ?? 0) + 1;
  input.counts.set(signature, count);

  return count >= 4 ? signature : undefined;
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
  mode: RunMode;
  signal?: AbortSignal;
  questionHandler?: (question: string) => Promise<string>;
  emit: <TPayload>(type: AgentEvent["type"], payload: TPayload) => Promise<AgentEvent<TPayload>>;
  yieldEvent: (event: AgentEvent) => Promise<void>;
}): Promise<ToolResult> {
  const tool = input.registry.get(input.toolCall.name);
  if (!tool) {
    return {
      toolCallId: input.toolCall.id,
      status: "error",
      summary: `Unknown tool: ${input.toolCall.name}`,
      error: { code: "unknown_tool", message: `Unknown tool: ${input.toolCall.name}` },
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
    const result = await tool.execute(input.toolCall.input, {
      workspaceRoot: input.workspaceRoot,
      sessionDir: input.sessionDir,
      mode: input.mode,
      toolCallId: input.toolCall.id,
      signal: input.signal,
      questionHandler: input.questionHandler,
    });

    await input.yieldEvent(
      await input.emit("tool.completed", {
        toolCallId: input.toolCall.id,
        tool: input.toolCall.name,
        status: result.status,
        summary: result.summary,
        data: result.data,
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

    if (input.toolCall.name === "skill.read" && result.status === "success") {
      const data = result.data as { name?: string; path?: string } | undefined;
      await input.yieldEvent(
        await input.emit("skill.loaded", {
          toolCallId: input.toolCall.id,
          name: data?.name,
          path: data?.path,
        }),
      );
    }

    if (input.toolCall.name === "skill.read_resource" && result.status === "success") {
      const data = result.data as { name?: string; resourcePath?: string } | undefined;
      await input.yieldEvent(
        await input.emit("skill.resource.loaded", {
          toolCallId: input.toolCall.id,
          name: data?.name,
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
        message: toErrorMessage(error),
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

  if (toolCall.name === "shell.run" && result.status !== "denied") {
    const data = result.data as { command?: string; exitCode?: number } | undefined;
    state.commands.push({
      command: data?.command ?? JSON.stringify(toolCall.input),
      exitCode: data?.exitCode,
      summary: result.summary,
    });
  }
}

function deniedToolResult(toolCallId: string, reason: string): ToolResult {
  return {
    toolCallId,
    status: "denied",
    summary: reason,
    error: {
      code: "permission_denied",
      message: reason,
    },
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
