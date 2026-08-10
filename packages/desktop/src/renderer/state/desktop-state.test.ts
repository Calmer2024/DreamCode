import type { AgentEvent, ChangedFile } from "@dreamcode/shared";
import type { ReplayedSessionState } from "@dreamcode/store";
import { describe, expect, it } from "vitest";
import type { DesktopBootstrap, DesktopError, StartTurnRequest } from "../../shared/contracts";
import {
  createDesktopState,
  desktopReducer,
  selectActiveChangedFile,
  selectTerminalEntries,
  selectTimeline,
  selectWorkspaceGroups,
} from "./desktop-state";

const bootstrap: DesktopBootstrap = {
  profiles: [],
  presets: [],
  sessions: [
    session("sess_1", "/projects/alpha", "Alpha work"),
    session("sess_2", "/projects/beta", "Beta work"),
    session("sess_3", "/projects/alpha", "More alpha work"),
  ],
};

const request: StartTurnRequest = {
  prompt: "Update the maths module",
  workspaceRoot: "/projects/alpha",
  mode: "yolo",
};

const toolStarted = agentEvent("tool.started", {
  toolCallId: "call_1",
  tool: "file.patch",
  input: { path: "src/math.js" },
});
const toolCompleted = agentEvent("tool.completed", {
  toolCallId: "call_1",
  tool: "file.patch",
  status: "success",
  summary: "Patched src/math.js.",
  data: { stdout: "updated 1 file" },
});
const fileChanged = agentEvent("file.changed", {
  changedFile: {
    path: "src/math.js",
    operation: "update",
    diff: "diff -- src/math.js",
  } satisfies ChangedFile,
});
const modelDelta = agentEvent("model.delta", { text: "This must be ignored." });

describe("desktop state reducer", () => {
  it("maps streamed events to the active timeline without losing raw evidence", () => {
    let state = createDesktopState(bootstrap);
    state = desktopReducer(state, { type: "run.started", runId: "run_1", request });
    state = desktopReducer(state, {
      type: "run.event",
      message: { runId: "run_1", event: toolStarted },
    });
    state = desktopReducer(state, {
      type: "run.event",
      message: { runId: "run_1", event: fileChanged },
    });

    expect(selectTimeline(state).some((entry) => entry.kind === "tool")).toBe(true);
    expect(state.rawEvents).toEqual([toolStarted, fileChanged]);
    expect(state.changedFiles[0]?.path).toBe("src/math.js");
  });

  it("ignores events from a stale run", () => {
    const state = desktopReducer(runningState("run_2"), {
      type: "run.event",
      message: { runId: "run_1", event: modelDelta },
    });

    expect(state.rawEvents).toHaveLength(0);
  });

  it("coalesces streamed assistant deltas while retaining every raw event", () => {
    let state = desktopReducer(runningState("run_1"), {
      type: "run.event",
      message: { runId: "run_1", event: agentEvent("model.delta", { text: "First " }) },
    });
    state = desktopReducer(state, {
      type: "run.event",
      message: { runId: "run_1", event: agentEvent("model.delta", { text: "second." }) },
    });

    expect(selectTimeline(state).filter((entry) => entry.kind === "assistant")).toEqual([
      expect.objectContaining({ detail: "First second." }),
    ]);
    expect(state.rawEvents).toHaveLength(2);
  });

  it("derives tool and terminal entries from completed tool events", () => {
    let state = desktopReducer(runningState("run_1"), {
      type: "run.event",
      message: { runId: "run_1", event: toolStarted },
    });
    state = desktopReducer(state, {
      type: "run.event",
      message: { runId: "run_1", event: toolCompleted },
    });

    expect(state.tools).toEqual([
      expect.objectContaining({ id: "call_1", name: "file.patch", status: "success" }),
    ]);
    expect(selectTerminalEntries(state)).toEqual([
      expect.objectContaining({ toolCallId: "call_1", text: "updated 1 file", status: "success" }),
    ]);
  });

  it("groups bootstrap sessions by workspace and selects a loaded session file", () => {
    let state = createDesktopState(bootstrap);
    state = desktopReducer(state, { type: "workspace.selected", workspaceRoot: "/projects/alpha" });
    state = desktopReducer(state, {
      type: "session.loaded",
      sessionId: "sess_1",
      session: replayedSession,
    });

    expect(selectWorkspaceGroups(state)).toEqual([
      expect.objectContaining({
        workspaceRoot: "/projects/alpha",
        sessions: [bootstrap.sessions[0], bootstrap.sessions[2]],
      }),
      expect.objectContaining({
        workspaceRoot: "/projects/beta",
        sessions: [bootstrap.sessions[1]],
      }),
    ]);
    expect(selectActiveChangedFile(state)?.path).toBe("src/replayed.ts");
  });

  it("replaces active run evidence with replayed session files and commands", () => {
    let state = desktopReducer(runningState("run_1"), {
      type: "run.event",
      message: { runId: "run_1", event: toolStarted },
    });
    state = desktopReducer(state, {
      type: "session.loaded",
      sessionId: "sess_1",
      session: replayedSession,
    });

    expect(state.activeRunId).toBeUndefined();
    expect(state.rawEvents).toEqual([]);
    expect(state.tools).toEqual([]);
    expect(selectTimeline(state)).toEqual([]);
    expect(selectTerminalEntries(state)).toEqual([
      expect.objectContaining({ tool: "shell.run", text: "pnpm test", status: "success" }),
    ]);
  });

  it("keeps UI selection, dialog state, run status, and recoverable errors in reducer state", () => {
    const error: DesktopError = { code: "run_failed", message: "Run failed.", recoverable: true };
    let state = createDesktopState(bootstrap);
    state = desktopReducer(state, { type: "run.started", runId: "run_1", request });
    state = desktopReducer(state, { type: "drawer.open", drawer: "terminal" });
    state = desktopReducer(state, { type: "dialog.set", dialog: { type: "profile" } });
    state = desktopReducer(state, { type: "error", error });
    state = desktopReducer(state, {
      type: "run.status",
      status: { runId: "run_1", status: "failed", error },
    });

    expect(state.drawer).toBe("terminal");
    expect(state.dialog).toEqual({ type: "profile" });
    expect(state.error).toEqual(error);
    expect(state.runStatus).toBe("failed");
  });
});

function runningState(runId: string) {
  return desktopReducer(createDesktopState(bootstrap), { type: "run.started", runId, request });
}

function agentEvent(type: AgentEvent["type"], payload: unknown): AgentEvent {
  return {
    id: `evt_${type}`,
    sessionId: "sess_1",
    turnId: "turn_1",
    type,
    timestamp: "2026-08-10T00:00:00.000Z",
    payload,
  };
}

function session(id: string, workspaceRoot: string, title: string) {
  return {
    id,
    workspaceRoot,
    status: "completed" as const,
    title,
    firstPrompt: title,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    changedFileCount: 0,
    commandCount: 0,
    totalCostUsd: 0,
    eventLogPath: `/sessions/${id}/events.jsonl`,
  };
}

const replayedSession: ReplayedSessionState = {
  session: {
    id: "sess_1",
    workspaceRoot: "/projects/alpha",
    sessionDir: "/sessions/sess_1",
    createdAt: "2026-08-10T00:00:00.000Z",
  },
  turns: [],
  status: "completed",
  todoItems: [],
  changedFiles: [{ path: "src/replayed.ts", operation: "update" }],
  commands: [{ command: "pnpm test", exitCode: 0, summary: "All tests passed." }],
  artifacts: [],
  approvals: [],
  costUsd: 0,
  warnings: [],
};
