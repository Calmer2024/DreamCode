import type { AgentEvent, ChangedFile, ModelUsage } from "@dreamcode/shared";
import type { ReplayedSessionState, SessionListItem } from "@dreamcode/store";
import type {
  DesktopBootstrap,
  DesktopError,
  DesktopRunEvent,
  DesktopRunStatus,
  DesktopSessionDetail,
  StartTurnRequest,
} from "../../shared/contracts";
import type { TodoItem } from "@dreamcode/shared";

export type DesktopRunState = "idle" | DesktopRunStatus["status"];
export type DesktopDrawer = "logs" | "terminal";
export type DesktopDialog = { type: "profile" | "settings" | "approval" | "question" };
export type DesktopTimelineKind =
  | "user"
  | "session"
  | "turn"
  | "assistant"
  | "tool"
  | "file"
  | "status"
  | "event";
export type DesktopTimelineTone = "info" | "success" | "warning" | "danger" | "muted";

export interface DesktopTimelineEntry {
  id: string;
  kind: DesktopTimelineKind;
  title: string;
  detail?: string;
  tone: DesktopTimelineTone;
  timestamp: string;
  turnId?: string;
}

export interface DesktopToolEvent {
  id: string;
  turnId?: string;
  name: string;
  status: "queued" | "running" | "success" | "error" | "cancelled" | "denied";
  summary?: string;
  inputPreview?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface DesktopTerminalEntry {
  id: string;
  toolCallId: string;
  tool: string;
  status: DesktopToolEvent["status"];
  stream: "stdout" | "stderr" | "summary";
  text: string;
  summary?: string;
  exitCode?: number;
  timestamp: string;
}

export interface DesktopContextUsage {
  estimatedTokens: number;
  maxTokens: number;
  compressed: boolean;
}

export interface DesktopTurnUsage extends ModelUsage {
  estimated?: boolean;
}

export interface WorkspaceGroup {
  workspaceRoot: string;
  name?: string;
  pinned?: boolean;
  sessions: SessionListItem[];
}

export interface DesktopState {
  bootstrap?: DesktopBootstrap;
  profiles: DesktopBootstrap["profiles"];
  presets: DesktopBootstrap["presets"];
  sessions: SessionListItem[];
  workspaceRoot?: string;
  activeSessionId?: string;
  activeSession?: DesktopSessionDetail;
  activeRunId?: string;
  runStatus: DesktopRunState;
  request?: StartTurnRequest;
  requestTimestamp?: string;
  rawEvents: AgentEvent[];
  timeline: DesktopTimelineEntry[];
  contextUsage?: DesktopContextUsage;
  turnUsage: Record<string, DesktopTurnUsage>;
  tools: DesktopToolEvent[];
  changedFiles: ChangedFile[];
  changedFilesByTurn: Record<string, ChangedFile[]>;
  todoItems: TodoItem[];
  activeChangedFilePath?: string;
  terminalEntries: DesktopTerminalEntry[];
  drawer?: DesktopDrawer;
  dialog?: DesktopDialog;
  error?: DesktopError;
}

export type DesktopAction =
  | { type: "bootstrap.loaded"; bootstrap: DesktopBootstrap }
  | { type: "bootstrap.refreshed"; bootstrap: DesktopBootstrap }
  | { type: "conversation.new" }
  | { type: "workspace.selected"; workspaceRoot?: string }
  | { type: "session.selected"; sessionId?: string }
  | { type: "session.loaded"; sessionId: string; session: DesktopSessionDetail }
  | { type: "run.started"; runId: string; request: StartTurnRequest }
  | { type: "run.event"; message: DesktopRunEvent }
  | { type: "run.status"; status: DesktopRunStatus }
  | { type: "drawer.open"; drawer: DesktopDrawer }
  | { type: "drawer.close" }
  | { type: "dialog.set"; dialog?: DesktopDialog }
  | { type: "error"; error?: DesktopError };

export function createDesktopState(bootstrap?: DesktopBootstrap): DesktopState {
  return {
    bootstrap,
    profiles: bootstrap?.profiles ?? [],
    presets: bootstrap?.presets ?? [],
    sessions: bootstrap?.sessions ?? [],
    runStatus: "idle",
    rawEvents: [],
    timeline: [],
    turnUsage: {},
    tools: [],
    changedFiles: [],
    changedFilesByTurn: {},
    todoItems: [],
    terminalEntries: [],
  };
}

export function desktopReducer(state: DesktopState, action: DesktopAction): DesktopState {
  if (action.type === "run.event" && action.message.runId !== state.activeRunId) {
    return state;
  }

  switch (action.type) {
    case "bootstrap.loaded":
      return { ...createDesktopState(action.bootstrap), workspaceRoot: state.workspaceRoot };
    case "bootstrap.refreshed":
      return {
        ...state,
        bootstrap: action.bootstrap,
        profiles: action.bootstrap.profiles,
        presets: action.bootstrap.presets,
        sessions: mergeSessionLists(state.sessions, action.bootstrap.sessions),
      };
    case "conversation.new":
      return resetConversation(state);
    case "workspace.selected":
      return { ...resetConversation(state), workspaceRoot: action.workspaceRoot };
    case "session.selected":
      return { ...state, activeSessionId: action.sessionId };
    case "session.loaded": {
      const events = action.session.events ?? [];
      let restored: DesktopState = {
        ...state,
        activeSessionId: action.sessionId,
        activeSession: action.session,
        workspaceRoot: action.session.session?.workspaceRoot ?? state.workspaceRoot,
        runStatus:
          action.session.status === "unknown" || action.session.status === "rolled_back"
            ? "idle"
            : action.session.status,
        activeRunId: undefined,
        request: undefined,
        requestTimestamp: undefined,
        rawEvents: [],
        timeline: [],
        contextUsage: undefined,
        turnUsage: {},
        tools: [],
        changedFiles: events.length ? [] : action.session.changedFiles,
        changedFilesByTurn: {},
        todoItems: [],
        activeChangedFilePath: undefined,
        terminalEntries: events.length
          ? []
          : terminalEntriesFromSession(action.session, action.sessionId),
        error: undefined,
      };
      for (const event of events) restored = reduceAgentEvent(restored, event);
      return {
        ...restored,
        activeSession: action.session,
        activeRunId: undefined,
        runStatus:
          action.session.status === "unknown" || action.session.status === "rolled_back"
            ? "idle"
            : action.session.status,
        activeChangedFilePath: restored.changedFiles[0]?.path,
      };
    }
    case "run.started": {
      const continuing =
        Boolean(state.activeSessionId) && action.request.sessionId === state.activeSessionId;
      return {
        ...state,
        activeRunId: action.runId,
        request: action.request,
        requestTimestamp: new Date().toISOString(),
        workspaceRoot: action.request.workspaceRoot,
        runStatus: "running",
        rawEvents: continuing ? state.rawEvents : [],
        timeline: continuing ? state.timeline : [],
        contextUsage: continuing ? state.contextUsage : undefined,
        turnUsage: continuing ? state.turnUsage : {},
        tools: continuing ? state.tools : [],
        changedFiles: continuing ? state.changedFiles : [],
        changedFilesByTurn: continuing ? state.changedFilesByTurn : {},
        todoItems: continuing ? state.todoItems : [],
        activeChangedFilePath: continuing ? state.activeChangedFilePath : undefined,
        terminalEntries: continuing ? state.terminalEntries : [],
        error: undefined,
      };
    }
    case "run.event":
      return reduceAgentEvent(state, action.message.event);
    case "run.status":
      if (action.status.runId !== state.activeRunId) {
        return state;
      }
      return {
        ...state,
        runStatus: action.status.status,
        error: action.status.error ?? state.error,
        activeRunId: action.status.status === "running" ? state.activeRunId : undefined,
      };
    case "drawer.open":
      return { ...state, drawer: action.drawer };
    case "drawer.close":
      return { ...state, drawer: undefined };
    case "dialog.set":
      return { ...state, dialog: action.dialog };
    case "error":
      return { ...state, error: action.error };
  }
}

export function selectWorkspaceGroups(state: DesktopState): WorkspaceGroup[] {
  const groups = new Map<string, SessionListItem[]>();
  for (const session of state.sessions) {
    const existing = groups.get(session.workspaceRoot);
    if (existing) {
      existing.push(session);
    } else {
      groups.set(session.workspaceRoot, [session]);
    }
  }
  for (const project of state.bootstrap?.projects ?? []) {
    if (!groups.has(project.workspaceRoot)) groups.set(project.workspaceRoot, []);
  }
  if (state.workspaceRoot && !groups.has(state.workspaceRoot)) {
    groups.set(state.workspaceRoot, []);
  }
  const pinnedSessionIds = new Set(state.bootstrap?.pinnedSessionIds ?? []);
  const projectOrder = new Map(
    (state.bootstrap?.projects ?? [])
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((project, index) => [project.workspaceRoot, index]),
  );
  return Array.from(groups, ([workspaceRoot, sessions]) => {
    const project = state.bootstrap?.projects?.find((item) => item.workspaceRoot === workspaceRoot);
    return {
      workspaceRoot,
      name: project?.name ?? workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceRoot,
      pinned: project?.pinned === true,
      sessions: sessions
        .filter((session) => !pinnedSessionIds.has(session.id))
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    };
  }).toSorted(
    (left, right) =>
      (projectOrder.get(left.workspaceRoot) ?? Number.MAX_SAFE_INTEGER) -
      (projectOrder.get(right.workspaceRoot) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function selectPinnedSessions(state: DesktopState): SessionListItem[] {
  const pinnedSessionIds = new Set(state.bootstrap?.pinnedSessionIds ?? []);
  return state.sessions
    .filter((session) => pinnedSessionIds.has(session.id))
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function selectTimeline(state: DesktopState): DesktopTimelineEntry[] {
  return state.timeline;
}

export function selectActiveChangedFile(state: DesktopState): ChangedFile | undefined {
  return (
    state.changedFiles.find((file) => file.path === state.activeChangedFilePath) ??
    state.changedFiles[0]
  );
}

export function selectTerminalEntries(state: DesktopState): DesktopTerminalEntry[] {
  return state.terminalEntries;
}

function reduceAgentEvent(state: DesktopState, event: AgentEvent): DesktopState {
  const next = { ...state, rawEvents: [...state.rawEvents, event] };
  const payload = asRecord(event.payload);

  switch (event.type) {
    case "session.created":
    case "session.resumed": {
      const session = asRecord(payload.session);
      const sessionId = stringValue(session.id) ?? next.activeSessionId;
      const workspaceRoot = stringValue(session.workspaceRoot) ?? next.workspaceRoot;
      const existingSession = sessionId
        ? next.sessions.find((item) => item.id === sessionId)
        : undefined;
      const sessions =
        event.type === "session.created" && sessionId && workspaceRoot && !existingSession
          ? upsertSessionListItem(next.sessions, {
              id: sessionId,
              workspaceRoot,
              status: "running",
              title: next.request?.prompt ?? "新对话",
              firstPrompt: next.request?.prompt ?? "新对话",
              createdAt: stringValue(session.createdAt) ?? event.timestamp,
              updatedAt: event.timestamp,
              changedFileCount: 0,
              commandCount: 0,
              totalCostUsd: 0,
              eventLogPath: stringValue(session.sessionDir) ?? "",
            })
          : next.sessions;
      return appendTimeline(
        { ...next, activeSessionId: sessionId, workspaceRoot, sessions },
        event,
        "session",
        event.type === "session.created" ? "Session created" : "Session resumed",
        sessionId,
        event.type === "session.created" ? "success" : "warning",
      );
    }
    case "turn.started": {
      return appendTimeline(
        { ...next, runStatus: "running" },
        event,
        "turn",
        "Turn started",
        undefined,
      );
    }
    case "user.message":
      return appendTimeline(next, event, "user", "User message", stringValue(payload.content));
    case "context.built": {
      const contextUsage = contextUsageFrom(payload, next.contextUsage);
      return appendTimeline(
        { ...next, contextUsage },
        event,
        "event",
        "Context built",
        `${formatTokenCount(contextUsage.estimatedTokens)} / ${formatTokenCount(contextUsage.maxTokens)} tokens`,
        "muted",
      );
    }
    case "context.compressed": {
      const contextUsage = {
        ...contextUsageFrom(payload, next.contextUsage),
        compressed: true,
      };
      return appendTimeline(
        { ...next, contextUsage },
        event,
        "event",
        "上下文已压缩",
        stringValue(payload.summary) ?? "较早消息已压缩为结构化检查点，近期消息保持完整。",
        "warning",
      );
    }
    case "model.started":
      return appendTimeline(
        next,
        event,
        "event",
        "Model started",
        `${stringValue(payload.provider) ?? "provider"} / ${stringValue(payload.model) ?? "default"}`,
        "muted",
      );
    case "model.delta": {
      const text = stringValue(payload.text);
      return text ? appendAssistantDelta(next, event, text) : next;
    }
    case "model.usage": {
      const turnId = event.turnId;
      if (!turnId) return next;
      const usage = modelUsageFrom(payload.usage, payload.estimated === true);
      return {
        ...next,
        turnUsage: {
          ...next.turnUsage,
          [turnId]: mergeModelUsage(next.turnUsage[turnId], usage),
        },
      };
    }
    case "model.tool_call": {
      const toolCall = asRecord(payload.toolCall);
      const tool: DesktopToolEvent = {
        id: stringValue(toolCall.id) ?? event.id,
        turnId: event.turnId,
        name: stringValue(toolCall.name) ?? "unknown",
        status: "queued",
        inputPreview: previewJson(toolCall.input),
      };
      return appendTimeline(
        { ...next, tools: upsertTool(next.tools, tool) },
        event,
        "tool",
        `Tool requested: ${tool.name}`,
        tool.inputPreview,
      );
    }
    case "permission.decided": {
      const decision = asRecord(payload.decision);
      const outcome = stringValue(decision.decision) ?? "decided";
      return appendTimeline(
        next,
        event,
        "event",
        `Permission ${outcome}`,
        formatPermissionDetail(stringValue(payload.tool), stringValue(decision.reason)),
        outcome === "allow" ? "success" : outcome === "deny" ? "danger" : "warning",
      );
    }
    case "todo.updated": {
      const items = Array.isArray(payload.items) ? payload.items : [];
      const todoItems: TodoItem[] = items.flatMap((item) => {
        const value = asRecord(item);
        const content = stringValue(value.content);
        const status = stringValue(value.status);
        return content && (status === "pending" || status === "in_progress" || status === "completed" || status === "blocked")
          ? [{ content, status }]
          : [];
      });
      return appendTimeline({ ...next, todoItems }, event, "event", "Todo updated", `${todoItems.length} item(s)`);
    }
    case "artifact.created":
    case "web.source.saved": {
      const title = event.type === "artifact.created" ? "Artifact created" : "Source saved";
      const detail =
        stringValue(payload.title) ?? stringValue(payload.url) ?? stringValue(payload.path);
      return appendTimeline(next, event, "event", title, detail, "success");
    }
    case "skill.loaded":
    case "skill.resource.loaded":
      return appendTimeline(
        next,
        event,
        "event",
        event.type === "skill.loaded" ? "Skill loaded" : "Skill resource loaded",
        stringValue(payload.name) ?? stringValue(payload.resourcePath) ?? stringValue(payload.path),
        "success",
      );
    case "tool.started": {
      const toolCallId = stringValue(payload.toolCallId) ?? event.id;
      const name = stringValue(payload.tool) ?? "unknown";
      const tool: DesktopToolEvent = {
        id: toolCallId,
        turnId: event.turnId,
        name,
        status: "running",
        inputPreview: previewJson(payload.input),
        startedAt: event.timestamp,
      };
      return appendTimeline(
        { ...next, tools: upsertTool(next.tools, tool) },
        event,
        "tool",
        `Running ${name}`,
        tool.inputPreview,
        "muted",
      );
    }
    case "tool.completed": {
      const toolCallId = stringValue(payload.toolCallId) ?? event.id;
      const name = stringValue(payload.tool) ?? "unknown";
      const status = normalizeToolStatus(stringValue(payload.status));
      const summary = stringValue(payload.summary);
      const terminalEntries = terminalOutput(event, payload, toolCallId, name, status, summary);
      return appendTimeline(
        {
          ...next,
          tools: upsertTool(next.tools, {
            id: toolCallId,
            turnId: event.turnId,
            name,
            status,
            summary,
            completedAt: event.timestamp,
          }),
          terminalEntries: [...next.terminalEntries, ...terminalEntries],
        },
        event,
        "tool",
        `${name} ${status}`,
        summary,
        status === "success" ? "success" : status === "denied" ? "warning" : "danger",
      );
    }
    case "file.changed": {
      const changedFile = changedFileFrom(payload.changedFile);
      if (!changedFile) {
        return next;
      }
      return appendTimeline(
        {
          ...next,
          changedFiles: upsertChangedFile(next.changedFiles, changedFile),
          changedFilesByTurn: event.turnId
            ? { ...next.changedFilesByTurn, [event.turnId]: upsertChangedFile(next.changedFilesByTurn[event.turnId] ?? [], changedFile) }
            : next.changedFilesByTurn,
          activeChangedFilePath: next.activeChangedFilePath ?? changedFile.path,
        },
        event,
        "file",
        `${changedFile.operation} ${changedFile.path}`,
        changedFile.patchRef,
        "warning",
      );
    }
    case "turn.completed": {
      const summary = asRecord(payload.summary);
      return appendTimeline(
        {
          ...next,
          runStatus: "completed",
          changedFiles: mergeChangedFiles(next.changedFiles, changedFilesFromSummary(summary)),
          changedFilesByTurn: event.turnId
            ? { ...next.changedFilesByTurn, [event.turnId]: mergeChangedFiles(next.changedFilesByTurn[event.turnId] ?? [], changedFilesFromSummary(summary)) }
            : next.changedFilesByTurn,
        },
        event,
        "status",
        "Turn completed",
        undefined,
        "success",
      );
    }
    case "session.summarized":
      return next;
    case "turn.failed":
      return appendTimeline(
        { ...next, runStatus: "failed" },
        event,
        "status",
        "Turn failed",
        stringValue(payload.error) ?? summaryMessage(payload),
        "danger",
      );
    case "turn.interrupted":
      return appendTimeline(
        { ...next, runStatus: "interrupted" },
        event,
        "status",
        "Turn interrupted",
        stringValue(payload.reason),
        "warning",
      );
    default:
      return appendTimeline(
        next,
        event,
        "event",
        readableEventTitle(event.type),
        undefined,
        "muted",
      );
  }
}

function upsertSessionListItem(
  sessions: SessionListItem[],
  session: SessionListItem,
): SessionListItem[] {
  return [session, ...sessions.filter((item) => item.id !== session.id)];
}

function mergeSessionLists(
  current: SessionListItem[],
  incoming: SessionListItem[],
): SessionListItem[] {
  const currentById = new Map(current.map((session) => [session.id, session]));
  return incoming.map((session) => {
    const previous = currentById.get(session.id);
    if (!previous || session.title !== "新对话" || previous.title === "新对话") return session;
    return { ...session, title: previous.title, firstPrompt: previous.firstPrompt };
  });
}

function resetConversation(state: DesktopState, workspaceRoot = state.workspaceRoot): DesktopState {
  return {
    ...state,
    workspaceRoot,
    activeSessionId: undefined,
    activeSession: undefined,
    activeRunId: undefined,
    runStatus: "idle",
    request: undefined,
    requestTimestamp: undefined,
    rawEvents: [],
    timeline: [],
    contextUsage: undefined,
    turnUsage: {},
    tools: [],
    changedFiles: [],
    changedFilesByTurn: {},
    todoItems: [],
    activeChangedFilePath: undefined,
    terminalEntries: [],
    drawer: undefined,
    dialog: undefined,
    error: undefined,
  };
}

function appendTimeline(
  state: DesktopState,
  event: AgentEvent,
  kind: DesktopTimelineKind,
  title: string,
  detail?: string,
  tone: DesktopTimelineTone = "info",
): DesktopState {
  return {
    ...state,
    timeline: [
      ...state.timeline,
      { id: event.id, kind, title, detail, tone, timestamp: event.timestamp, turnId: event.turnId },
    ],
  };
}

function appendAssistantDelta(state: DesktopState, event: AgentEvent, text: string): DesktopState {
  const last = state.timeline.at(-1);
  if (last?.kind !== "assistant" || last.turnId !== event.turnId) {
    return appendTimeline(state, event, "assistant", "Assistant", text, "muted");
  }
  return {
    ...state,
    timeline: [
      ...state.timeline.slice(0, -1),
      { ...last, detail: `${last.detail ?? ""}${text}`, timestamp: event.timestamp },
    ],
  };
}

function terminalOutput(
  event: AgentEvent,
  payload: Record<string, unknown>,
  toolCallId: string,
  tool: string,
  status: DesktopToolEvent["status"],
  summary?: string,
): DesktopTerminalEntry[] {
  const data = asRecord(payload.data);
  const streams: Array<[DesktopTerminalEntry["stream"], string | undefined]> = [
    ["stdout", stringValue(data.stdout)],
    ["stderr", stringValue(data.stderr)],
  ];
  const entries = streams.flatMap(([stream, text]) =>
    text
      ? [
          {
            id: `${event.id}-${stream}`,
            toolCallId,
            tool,
            status,
            stream,
            text,
            exitCode: numberValue(data.exitCode),
            timestamp: event.timestamp,
          },
        ]
      : [],
  );
  return entries.length || !summary
    ? entries
    : [
        {
          id: `${event.id}-summary`,
          toolCallId,
          tool,
          status,
          stream: "summary",
          text: summary,
          exitCode: numberValue(data.exitCode),
          timestamp: event.timestamp,
        },
      ];
}

function terminalEntriesFromSession(
  session: ReplayedSessionState,
  sessionId: string,
): DesktopTerminalEntry[] {
  return session.commands.map((command, index) => ({
    id: `session-${sessionId}-command-${index}`,
    toolCallId: `session-${sessionId}-command-${index}`,
    tool: typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "pwsh" : "bash",
    status: command.exitCode === undefined || command.exitCode === 0 ? "success" : "error",
    stream: "summary",
    text: command.command,
    summary: command.summary,
    exitCode: command.exitCode,
    timestamp: session.updatedAt ?? session.session?.createdAt ?? "",
  }));
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

function contextUsageFrom(
  payload: Record<string, unknown>,
  previous?: DesktopContextUsage,
): DesktopContextUsage {
  return {
    estimatedTokens: numberValue(payload.estimatedTokens) ?? previous?.estimatedTokens ?? 0,
    maxTokens: numberValue(payload.maxTokens) ?? previous?.maxTokens ?? 64_000,
    compressed: payload.compressed === true,
  };
}

function modelUsageFrom(value: unknown, estimated: boolean): DesktopTurnUsage {
  const usage = asRecord(value);
  const inputTokens = numberValue(usage.inputTokens);
  const cachedInputTokens = numberValue(usage.cachedInputTokens);
  const uncachedInputTokens = numberValue(usage.uncachedInputTokens);
  const outputTokens = numberValue(usage.outputTokens);
  return {
    inputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    outputTokens,
    totalTokens:
      numberValue(usage.totalTokens) ??
      (inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined),
    estimated,
    ...(numberValue(usage.costUsd) === undefined ? {} : { costUsd: numberValue(usage.costUsd) }),
  };
}

function mergeModelUsage(
  previous: DesktopTurnUsage | undefined,
  current: DesktopTurnUsage,
): DesktopTurnUsage {
  return {
    inputTokens: sumTokenValues(previous?.inputTokens, current.inputTokens),
    ...(sumTokenValues(previous?.cachedInputTokens, current.cachedInputTokens) === undefined
      ? {}
      : {
          cachedInputTokens: sumTokenValues(
            previous?.cachedInputTokens,
            current.cachedInputTokens,
          ),
        }),
    ...(sumTokenValues(previous?.uncachedInputTokens, current.uncachedInputTokens) === undefined
      ? {}
      : {
          uncachedInputTokens: sumTokenValues(
            previous?.uncachedInputTokens,
            current.uncachedInputTokens,
          ),
        }),
    outputTokens: sumTokenValues(previous?.outputTokens, current.outputTokens),
    totalTokens: sumTokenValues(previous?.totalTokens, current.totalTokens),
    estimated: previous?.estimated === true || current.estimated === true,
    ...(sumTokenValues(previous?.costUsd, current.costUsd) === undefined
      ? {}
      : { costUsd: sumTokenValues(previous?.costUsd, current.costUsd) }),
    ...((previous?.warnings?.length ?? 0) + (current.warnings?.length ?? 0) > 0
      ? { warnings: [...(previous?.warnings ?? []), ...(current.warnings ?? [])] }
      : {}),
  };
}

function sumTokenValues(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function previewJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 140 ? `${text.slice(0, 125)}...[truncated]` : text || undefined;
}

function normalizeToolStatus(value: string | undefined): DesktopToolEvent["status"] {
  return value === "success" || value === "error" || value === "cancelled" || value === "denied"
    ? value
    : "error";
}

function changedFileFrom(value: unknown): ChangedFile | undefined {
  const file = asRecord(value);
  const path = stringValue(file.path);
  const operation = stringValue(file.operation);
  if (!path || (operation !== "create" && operation !== "update" && operation !== "delete"))
    return undefined;
  return {
    path,
    operation,
    beforeHash: stringValue(file.beforeHash),
    afterHash: stringValue(file.afterHash),
    diff: stringValue(file.diff),
    beforeSnapshotRef: stringValue(file.beforeSnapshotRef),
    patchRef: stringValue(file.patchRef),
  };
}

function upsertTool(tools: DesktopToolEvent[], next: DesktopToolEvent): DesktopToolEvent[] {
  const index = tools.findIndex((tool) => tool.id === next.id);
  if (index === -1) return [...tools, next];
  const updated = [...tools];
  updated[index] = { ...updated[index], ...next };
  return updated;
}

function upsertChangedFile(files: ChangedFile[], next: ChangedFile): ChangedFile[] {
  const index = files.findIndex((file) => file.path === next.path);
  if (index === -1) return [...files, next];
  const updated = [...files];
  updated[index] = { ...updated[index], ...next };
  return updated;
}

function mergeChangedFiles(current: ChangedFile[], incoming: ChangedFile[]): ChangedFile[] {
  return incoming.reduce(upsertChangedFile, current);
}

function changedFilesFromSummary(summary: Record<string, unknown>): ChangedFile[] {
  if (!Array.isArray(summary.changedFiles)) return [];
  return summary.changedFiles.flatMap((file) => {
    const changedFile = changedFileFrom(file);
    return changedFile ? [changedFile] : [];
  });
}

function formatPermissionDetail(
  tool: string | undefined,
  reason: string | undefined,
): string | undefined {
  if (tool && reason) return `${tool}: ${reason}`;
  return tool ?? reason;
}

function readableEventTitle(type: AgentEvent["type"]): string {
  const text = type.replace(/[._]/g, " ");
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

function summaryMessage(payload: Record<string, unknown>): string | undefined {
  return stringValue(asRecord(payload.summary).message);
}
