import type {
  AgentEvent,
  ChangedFile,
  FinalSummary,
  ModelUsage,
  TodoItem,
} from "@dreamcode/shared";

export type TuiRunStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "waiting_question"
  | "completed"
  | "failed"
  | "interrupted";

export type TimelineTone = "info" | "success" | "warning" | "danger" | "muted";

export interface TuiRuntimeInfo {
  version: string;
  workspaceRoot: string;
  mode: string;
  provider: string;
  model: string;
  home: string;
}

export interface TuiToolEvent {
  id: string;
  name: string;
  status: "queued" | "running" | "success" | "error" | "cancelled" | "denied";
  summary?: string;
  inputPreview?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TuiTimelineEntry {
  id: string;
  title: string;
  detail?: string;
  tone: TimelineTone;
  timestamp: string;
  turnId?: string;
}

export interface TuiAssistantMessage {
  id: string;
  turnId?: string;
  text: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TuiApprovalEntry {
  tool?: string;
  decision?: string;
  reason?: string;
}

export interface TuiNotice {
  title: string;
  body?: string;
  tone: TimelineTone;
}

export interface TuiDetail {
  title: string;
  body: string;
  tone?: TimelineTone;
}

export interface TuiState {
  runtime: TuiRuntimeInfo;
  status: TuiRunStatus;
  sessionId?: string;
  turnId?: string;
  sessionDir?: string;
  currentPrompt?: string;
  contextSummary?: string;
  assistantText: string;
  assistantMessages: TuiAssistantMessage[];
  latestSummary?: FinalSummary;
  sessionSummary?: string;
  todos: TodoItem[];
  tools: TuiToolEvent[];
  changedFiles: ChangedFile[];
  artifacts: Array<{ kind?: string; path?: string; title?: string; url?: string }>;
  approvals: TuiApprovalEntry[];
  timeline: TuiTimelineEntry[];
  usage: Required<ModelUsage>;
  notice?: TuiNotice;
  detail?: TuiDetail;
}

export function createInitialTuiState(runtime: TuiRuntimeInfo): TuiState {
  return {
    runtime,
    status: "idle",
    assistantText: "",
    assistantMessages: [],
    todos: [],
    tools: [],
    changedFiles: [],
    artifacts: [],
    approvals: [],
    timeline: [
      {
        id: "welcome",
        title: "DreamCode TUI ready",
        detail: "Type a goal, /sessions, /resume <id>, /diff, or /help.",
        tone: "info",
        timestamp: new Date().toISOString(),
      },
    ],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  };
}

export function startTuiTurn(state: TuiState, prompt: string): TuiState {
  return {
    ...state,
    status: "running",
    currentPrompt: prompt,
    assistantText: "",
    latestSummary: undefined,
    notice: undefined,
    detail: undefined,
    timeline: [
      ...state.timeline,
      {
        id: `local-${Date.now()}`,
        title: "User message",
        detail: prompt,
        tone: "info",
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function setTuiStatus(state: TuiState, status: TuiRunStatus): TuiState {
  return { ...state, status };
}

export function addTuiNotice(state: TuiState, notice: TuiNotice): TuiState {
  return {
    ...state,
    notice,
    timeline: [
      ...state.timeline,
      {
        id: `notice-${Date.now()}`,
        title: notice.title,
        detail: notice.body,
        tone: notice.tone,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function setTuiDetail(state: TuiState, detail: TuiDetail | undefined): TuiState {
  return { ...state, detail };
}

export function clearTuiOutput(state: TuiState): TuiState {
  return {
    ...state,
    assistantText: "",
    assistantMessages: [],
    timeline: [],
    notice: undefined,
    detail: undefined,
  };
}

export function reduceTuiEvent(state: TuiState, event: AgentEvent): TuiState {
  const payload = asRecord(event.payload);

  switch (event.type) {
    case "session.created":
    case "session.resumed": {
      const session = asRecord(payload.session);
      const restored = asRecord(payload.restored);
      const sessionId = stringValue(session.id) ?? state.sessionId;
      const workspaceRoot = stringValue(session.workspaceRoot) ?? state.runtime.workspaceRoot;
      const sessionDir = stringValue(session.sessionDir) ?? state.sessionDir;
      return appendTimeline(
        {
          ...state,
          status: "running",
          sessionId,
          sessionDir,
          runtime: {
            ...state.runtime,
            workspaceRoot,
          },
        },
        {
          id: event.id,
          title: event.type === "session.resumed" ? "Session resumed" : "Session created",
          detail: restored
            ? `restored ${numberValue(restored.turnCount) ?? 0} turn(s), status ${stringValue(restored.status) ?? "unknown"}`
            : sessionId,
          tone: event.type === "session.resumed" ? "warning" : "success",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "turn.started": {
      const turn = asRecord(payload.turn);
      return appendTimeline(
        {
          ...state,
          status: "running",
          turnId: stringValue(turn.id) ?? state.turnId,
          currentPrompt: stringValue(turn.prompt) ?? state.currentPrompt,
          runtime: {
            ...state.runtime,
            mode: stringValue(turn.mode) ?? state.runtime.mode,
          },
        },
        {
          id: event.id,
          title: "Turn started",
          detail: stringValue(turn.prompt),
          tone: "info",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "user.message": {
      const content = stringValue(payload.content);
      const nextState = {
        ...state,
        currentPrompt: content ?? state.currentPrompt,
      };
      if (!content) {
        return nextState;
      }
      return appendOrUpdateUserMessage(nextState, {
        id: event.id,
        detail: content,
        timestamp: event.timestamp,
        turnId: event.turnId,
      });
    }

    case "context.built":
      return {
        ...state,
        contextSummary: stringValue(payload.summary),
      };

    case "model.started":
      return appendTimeline(
        {
          ...state,
          runtime: {
            ...state.runtime,
            provider: stringValue(payload.provider) ?? state.runtime.provider,
            model: stringValue(payload.model) ?? state.runtime.model,
          },
        },
        {
          id: event.id,
          title: "Model started",
          detail: `${stringValue(payload.provider) ?? "provider"} / ${stringValue(payload.model) ?? "default"} (${numberValue(payload.toolCount) ?? 0} tools)`,
          tone: "muted",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );

    case "model.delta":
      return appendAssistantDelta(state, event, stringValue(payload.text) ?? "");

    case "model.tool_call": {
      const toolCall = asRecord(payload.toolCall);
      const tool = toToolEvent(toolCall, "queued");
      return appendTimeline(
        {
          ...state,
          tools: upsertTool(state.tools, tool),
        },
        {
          id: event.id,
          title: `Tool requested: ${tool.name}`,
          detail: tool.inputPreview,
          tone: "info",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "permission.decided": {
      const decision = asRecord(payload.decision);
      const approval = {
        tool: stringValue(payload.tool),
        decision: stringValue(decision.decision),
        reason: stringValue(decision.reason),
      };
      return appendTimeline(
        {
          ...state,
          approvals: [...state.approvals.slice(-11), approval],
        },
        {
          id: event.id,
          title: `Permission ${approval.decision ?? "decided"}`,
          detail: approval.tool ? `${approval.tool}: ${approval.reason ?? ""}` : approval.reason,
          tone:
            approval.decision === "allow"
              ? "success"
              : approval.decision === "deny"
                ? "danger"
                : "warning",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "tool.started":
      return {
        ...appendTimeline(state, {
          id: event.id,
          title: `Running ${stringValue(payload.tool) ?? "tool"}`,
          detail: previewJson(payload.input),
          tone: "muted",
          timestamp: event.timestamp,
          turnId: event.turnId,
        }),
        tools: upsertTool(state.tools, {
          id: stringValue(payload.toolCallId) ?? event.id,
          name: stringValue(payload.tool) ?? "unknown",
          status: "running",
          inputPreview: previewJson(payload.input),
          startedAt: event.timestamp,
        }),
      };

    case "tool.completed": {
      const status = normalizeToolStatus(stringValue(payload.status));
      return appendTimeline(
        {
          ...state,
          tools: upsertTool(state.tools, {
            id: stringValue(payload.toolCallId) ?? event.id,
            name: stringValue(payload.tool) ?? "unknown",
            status,
            summary: stringValue(payload.summary),
            completedAt: event.timestamp,
          }),
        },
        {
          id: event.id,
          title: `${stringValue(payload.tool) ?? "tool"} ${status}`,
          detail: stringValue(payload.summary),
          tone: status === "success" ? "success" : status === "denied" ? "warning" : "danger",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "file.snapshot.created":
      return appendTimeline(state, {
        id: event.id,
        title: "Snapshot saved",
        detail: stringValue(payload.path),
        tone: "muted",
        timestamp: event.timestamp,
        turnId: event.turnId,
      });

    case "file.changed": {
      const changedFile = asChangedFile(payload.changedFile);
      if (!changedFile) {
        return state;
      }
      return appendTimeline(
        {
          ...state,
          changedFiles: upsertChangedFile(state.changedFiles, changedFile),
        },
        {
          id: event.id,
          title: `${changedFile.operation} ${changedFile.path}`,
          detail: changedFile.patchRef,
          tone: "warning",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "artifact.created":
    case "web.source.saved": {
      const artifact = {
        kind: stringValue(payload.kind) ?? (event.type === "web.source.saved" ? "web" : undefined),
        path: stringValue(payload.path),
        title: stringValue(payload.title),
        url: stringValue(payload.url),
      };
      return appendTimeline(
        {
          ...state,
          artifacts: [...state.artifacts.slice(-11), artifact],
        },
        {
          id: event.id,
          title: event.type === "web.source.saved" ? "Source saved" : "Artifact created",
          detail: artifact.title ?? artifact.url ?? artifact.path,
          tone: "success",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "skill.loaded":
    case "skill.resource.loaded":
      return appendTimeline(state, {
        id: event.id,
        title: event.type === "skill.loaded" ? "Skill loaded" : "Skill resource loaded",
        detail:
          stringValue(payload.name) ??
          stringValue(payload.resourcePath) ??
          stringValue(payload.path),
        tone: "success",
        timestamp: event.timestamp,
        turnId: event.turnId,
      });

    case "todo.updated": {
      const items = Array.isArray(payload.items) ? (payload.items as TodoItem[]) : [];
      return appendTimeline(
        {
          ...state,
          todos: items,
        },
        {
          id: event.id,
          title: "Todo updated",
          detail: `${items.length} item(s)`,
          tone: "info",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "model.usage": {
      const usage = asRecord(payload.usage);
      return {
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + (numberValue(usage.inputTokens) ?? 0),
          outputTokens: state.usage.outputTokens + (numberValue(usage.outputTokens) ?? 0),
          totalTokens: state.usage.totalTokens + (numberValue(usage.totalTokens) ?? 0),
          costUsd: state.usage.costUsd + (numberValue(usage.costUsd) ?? 0),
        },
      };
    }

    case "session.summarized":
      return {
        ...state,
        sessionSummary: stringValue(payload.summary) ?? state.sessionSummary,
      };

    case "turn.completed": {
      const summary = payload.summary as FinalSummary | undefined;
      const nextState = finalizeAssistantMessage(state, event, "completed", summary?.message);
      return appendTimeline(
        {
          ...nextState,
          status: "completed",
          latestSummary: summary,
          changedFiles: summary?.changedFiles?.length
            ? mergeChangedFiles(nextState.changedFiles, summary.changedFiles)
            : nextState.changedFiles,
        },
        {
          id: event.id,
          title: "Turn completed",
          detail: summary?.message,
          tone: "success",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "turn.failed": {
      const summary = payload.summary as FinalSummary | undefined;
      const detail = stringValue(payload.error) ?? summary?.message;
      const nextState = finalizeAssistantMessage(state, event, "failed", detail);
      return appendTimeline(
        {
          ...nextState,
          status: "failed",
          latestSummary: summary,
        },
        {
          id: event.id,
          title: "Turn failed",
          detail,
          tone: "danger",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    case "turn.interrupted": {
      const nextState = finalizeAssistantMessage(state, event, "interrupted");
      return appendTimeline(
        {
          ...nextState,
          status: "interrupted",
        },
        {
          id: event.id,
          title: "Turn interrupted",
          detail: stringValue(payload.reason),
          tone: "warning",
          timestamp: event.timestamp,
          turnId: event.turnId,
        },
      );
    }

    default:
      return state;
  }
}

function appendTimeline(state: TuiState, entry: TuiTimelineEntry): TuiState {
  return {
    ...state,
    timeline: [...state.timeline, entry],
  };
}

function appendOrUpdateUserMessage(
  state: TuiState,
  entry: Pick<TuiTimelineEntry, "id" | "detail" | "timestamp" | "turnId">,
): TuiState {
  const lastUserIndex = findLastIndex(state.timeline, (item) => item.title === "User message");
  const lastUser = lastUserIndex >= 0 ? state.timeline[lastUserIndex] : undefined;
  if (lastUser && lastUser.detail === entry.detail && !lastUser.turnId) {
    const timeline = [...state.timeline];
    timeline[lastUserIndex] = {
      id: entry.id,
      title: lastUser.title,
      detail: lastUser.detail,
      tone: lastUser.tone,
      timestamp: entry.timestamp,
      turnId: entry.turnId,
    };
    return { ...state, timeline };
  }

  return appendTimeline(state, {
    id: entry.id,
    title: "User message",
    detail: entry.detail,
    tone: "info",
    timestamp: entry.timestamp,
    turnId: entry.turnId,
  });
}

function appendAssistantDelta(state: TuiState, event: AgentEvent, text: string): TuiState {
  if (!text) {
    return state;
  }
  const turnId = event.turnId ?? state.turnId;
  const index = findLastIndex(
    state.assistantMessages,
    (message) => Boolean(turnId) && message.turnId === turnId,
  );
  const assistantText = `${state.assistantText}${text}`;
  if (index === -1) {
    return {
      ...state,
      assistantText,
      assistantMessages: [
        ...state.assistantMessages,
        {
          id: `assistant-${turnId ?? event.id}`,
          turnId,
          text,
          status: "streaming",
          startedAt: event.timestamp,
          updatedAt: event.timestamp,
        },
      ],
    };
  }

  const assistantMessages = [...state.assistantMessages];
  const current = assistantMessages[index];
  if (!current) {
    return { ...state, assistantText };
  }
  assistantMessages[index] = {
    ...current,
    text: `${current.text}${text}`,
    status: "streaming",
    updatedAt: event.timestamp,
  };
  return { ...state, assistantText, assistantMessages };
}

function finalizeAssistantMessage(
  state: TuiState,
  event: AgentEvent,
  status: TuiAssistantMessage["status"],
  fallbackText?: string,
): TuiState {
  const turnId = event.turnId ?? state.turnId;
  const index = findLastIndex(
    state.assistantMessages,
    (message) => Boolean(turnId) && message.turnId === turnId,
  );

  if (index === -1) {
    const text = fallbackText?.trim();
    if (!text) {
      return state;
    }
    return {
      ...state,
      assistantMessages: [
        ...state.assistantMessages,
        {
          id: `assistant-${turnId ?? event.id}`,
          turnId,
          text,
          status,
          startedAt: event.timestamp,
          updatedAt: event.timestamp,
          completedAt: event.timestamp,
        },
      ],
    };
  }

  const assistantMessages = [...state.assistantMessages];
  const current = assistantMessages[index];
  if (!current) {
    return state;
  }
  assistantMessages[index] = {
    ...current,
    status,
    updatedAt: event.timestamp,
    completedAt: event.timestamp,
  };
  return { ...state, assistantMessages };
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) {
      return index;
    }
  }
  return -1;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function previewJson(value: unknown, maxLength = 140): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return undefined;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 15)}...[truncated]` : text;
}

function toToolEvent(
  toolCall: Record<string, unknown>,
  status: TuiToolEvent["status"],
): TuiToolEvent {
  return {
    id: stringValue(toolCall.id) ?? `tool-${Date.now()}`,
    name: stringValue(toolCall.name) ?? "unknown",
    status,
    inputPreview: previewJson(toolCall.input),
  };
}

function upsertTool(tools: TuiToolEvent[], next: TuiToolEvent): TuiToolEvent[] {
  const index = tools.findIndex((tool) => tool.id === next.id);
  if (index === -1) {
    return [...tools.slice(-17), next];
  }
  const copy = [...tools];
  copy[index] = { ...copy[index], ...next };
  return copy;
}

function normalizeToolStatus(status: string | undefined): TuiToolEvent["status"] {
  switch (status) {
    case "success":
    case "error":
    case "cancelled":
    case "denied":
      return status;
    default:
      return "error";
  }
}

function asChangedFile(value: unknown): ChangedFile | undefined {
  const record = asRecord(value);
  const filePath = stringValue(record.path);
  const operation = stringValue(record.operation);
  if (!filePath || !isChangedFileOperation(operation)) {
    return undefined;
  }
  return {
    path: filePath,
    operation,
    beforeHash: stringValue(record.beforeHash),
    afterHash: stringValue(record.afterHash),
    diff: stringValue(record.diff),
    beforeSnapshotRef: stringValue(record.beforeSnapshotRef),
    patchRef: stringValue(record.patchRef),
  };
}

function isChangedFileOperation(value: string | undefined): value is ChangedFile["operation"] {
  return value === "create" || value === "update" || value === "delete";
}

function upsertChangedFile(files: ChangedFile[], next: ChangedFile): ChangedFile[] {
  const index = files.findIndex((file) => file.path === next.path);
  if (index === -1) {
    return [...files, next];
  }
  const copy = [...files];
  copy[index] = { ...copy[index], ...next };
  return copy;
}

function mergeChangedFiles(current: ChangedFile[], incoming: ChangedFile[]): ChangedFile[] {
  return incoming.reduce(upsertChangedFile, current);
}
