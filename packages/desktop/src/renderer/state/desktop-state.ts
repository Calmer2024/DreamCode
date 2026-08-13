import type { AgentEvent, ChangedFile } from "@dreamcode/shared";
import type { ReplayedSessionState, SessionListItem } from "@dreamcode/store";
import type {
  DesktopBootstrap,
  DesktopError,
  DesktopRunEvent,
  DesktopRunStatus,
  StartTurnRequest,
} from "../../shared/contracts";

export type DesktopRunState = "idle" | DesktopRunStatus["status"];
export type DesktopDrawer = "sessions" | "files" | "terminal" | "details";
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
  activeSession?: ReplayedSessionState;
  activeRunId?: string;
  runStatus: DesktopRunState;
  request?: StartTurnRequest;
  rawEvents: AgentEvent[];
  timeline: DesktopTimelineEntry[];
  tools: DesktopToolEvent[];
  changedFiles: ChangedFile[];
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
  | { type: "session.loaded"; sessionId: string; session: ReplayedSessionState }
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
    tools: [],
    changedFiles: [],
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
        sessions: action.bootstrap.sessions,
      };
    case "conversation.new":
      return resetConversation(state);
    case "workspace.selected":
      return { ...resetConversation(state), workspaceRoot: action.workspaceRoot };
    case "session.selected":
      return { ...state, activeSessionId: action.sessionId };
    case "session.loaded":
      return {
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
        rawEvents: [],
        timeline: [],
        tools: [],
        changedFiles: action.session.changedFiles,
        activeChangedFilePath: action.session.changedFiles[0]?.path,
        terminalEntries: terminalEntriesFromSession(action.session, action.sessionId),
        error: undefined,
      };
    case "run.started":
      return {
        ...state,
        activeRunId: action.runId,
        request: action.request,
        workspaceRoot: action.request.workspaceRoot,
        runStatus: "running",
        rawEvents: [],
        timeline: [],
        tools: [],
        changedFiles: [],
        activeChangedFilePath: undefined,
        terminalEntries: [],
        error: undefined,
      };
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
  return Array.from(groups, ([workspaceRoot, sessions]) => {
    const project = state.bootstrap?.projects?.find((item) => item.workspaceRoot === workspaceRoot);
    return {
      workspaceRoot,
      name: project?.name ?? workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceRoot,
      pinned: project?.pinned === true,
      sessions: sessions.toSorted(
        (left, right) =>
          Number(pinnedSessionIds.has(right.id)) - Number(pinnedSessionIds.has(left.id)),
      ),
    };
  }).toSorted((left, right) => Number(right.pinned) - Number(left.pinned));
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
      return appendTimeline(
        { ...next, activeSessionId: sessionId, workspaceRoot },
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
      return appendTimeline(next, event, "event", "Todo updated", `${items.length} item(s)`);
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

function resetConversation(state: DesktopState, workspaceRoot = state.workspaceRoot): DesktopState {
  return {
    ...state,
    workspaceRoot,
    activeSessionId: undefined,
    activeSession: undefined,
    activeRunId: undefined,
    runStatus: "idle",
    request: undefined,
    rawEvents: [],
    timeline: [],
    tools: [],
    changedFiles: [],
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
    tool: "shell.run",
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
