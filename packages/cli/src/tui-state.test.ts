import type { AgentEvent, FinalSummary } from "@dreamcode/shared";
import { describe, expect, it } from "vitest";
import { createInitialTuiState, reduceTuiEvent } from "./tui-state";

describe("TUI event reducer", () => {
  it("replays core agent events into visible TUI panels", () => {
    let state = createInitialTuiState({
      version: "0.1.0",
      workspaceRoot: "/repo",
      mode: "yolo",
      provider: "fake",
      model: "default",
      home: "/home/.dreamcode",
    });
    const summary: FinalSummary = {
      status: "completed",
      message: "Done.",
      changedFiles: [],
      commands: [],
      risks: [],
      eventLogPath: "/home/.dreamcode/sessions/sess/events.jsonl",
    };

    for (const event of [
      agentEvent("session.created", {
        session: {
          id: "sess_123456789",
          workspaceRoot: "/repo",
          sessionDir: "/home/.dreamcode/sessions/sess_123456789",
          createdAt: "2026-07-09T00:00:00.000Z",
        },
      }),
      agentEvent("turn.started", {
        turn: {
          id: "turn_1",
          sessionId: "sess_123456789",
          prompt: "Fix tests",
          mode: "yolo",
          status: "running",
          startedAt: "2026-07-09T00:00:01.000Z",
        },
      }),
      agentEvent("model.started", { provider: "fake", model: "default", toolCount: 3 }),
      agentEvent("model.delta", { text: "I will inspect the repo.\n" }),
      agentEvent("todo.updated", {
        items: [{ content: "Patch implementation", status: "in_progress" }],
      }),
      agentEvent("tool.started", {
        toolCallId: "call_1",
        tool: "file.patch",
        input: { path: "src/math.js" },
      }),
      agentEvent("tool.completed", {
        toolCallId: "call_1",
        tool: "file.patch",
        status: "success",
        summary: "Patched src/math.js.",
      }),
      agentEvent("file.changed", {
        changedFile: {
          path: "src/math.js",
          operation: "update",
          diff: "diff -- src/math.js",
        },
      }),
      agentEvent("model.usage", {
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 },
      }),
      agentEvent("turn.completed", { summary }),
    ]) {
      state = reduceTuiEvent(state, event);
    }

    expect(state.status).toBe("completed");
    expect(state.sessionId).toBe("sess_123456789");
    expect(state.assistantText).toContain("inspect the repo");
    expect(state.assistantMessages).toHaveLength(1);
    expect(state.assistantMessages[0]?.text).toContain("inspect the repo");
    expect(state.todos[0]?.content).toBe("Patch implementation");
    expect(state.tools[0]).toMatchObject({ name: "file.patch", status: "success" });
    expect(state.changedFiles[0]).toMatchObject({ path: "src/math.js", operation: "update" });
    expect(state.usage.totalTokens).toBe(15);
    expect(state.latestSummary?.message).toBe("Done.");
  });

  it("keeps complete assistant history across multiple turns", () => {
    let state = createInitialTuiState({
      version: "0.1.0",
      workspaceRoot: "/repo",
      mode: "yolo",
      provider: "fake",
      model: "default",
      home: "/home/.dreamcode",
    });

    for (const event of [
      agentEvent(
        "turn.started",
        {
          turn: {
            id: "turn_1",
            sessionId: "sess_123456789",
            prompt: "first question",
            mode: "yolo",
            status: "running",
            startedAt: "2026-07-09T00:00:01.000Z",
          },
        },
        "turn_1",
      ),
      agentEvent("model.delta", { text: "first full answer" }, "turn_1"),
      agentEvent("turn.completed", { summary: summary("first full answer") }, "turn_1"),
      agentEvent(
        "turn.started",
        {
          turn: {
            id: "turn_2",
            sessionId: "sess_123456789",
            prompt: "second question",
            mode: "yolo",
            status: "running",
            startedAt: "2026-07-09T00:00:02.000Z",
          },
        },
        "turn_2",
      ),
      agentEvent("model.delta", { text: "second full answer" }, "turn_2"),
      agentEvent("turn.completed", { summary: summary("second full answer") }, "turn_2"),
    ]) {
      state = reduceTuiEvent(state, event);
    }

    expect(state.assistantMessages.map((message) => message.text)).toEqual([
      "first full answer",
      "second full answer",
    ]);
    expect(state.timeline.filter((entry) => entry.title === "Turn completed")).toHaveLength(2);
  });
});

function summary(message: string): FinalSummary {
  return {
    status: "completed",
    message,
    changedFiles: [],
    commands: [],
    risks: [],
    eventLogPath: "/home/.dreamcode/sessions/sess/events.jsonl",
  };
}

function agentEvent(type: AgentEvent["type"], payload: unknown, turnId = "turn_1"): AgentEvent {
  return {
    id: `evt_${type}`,
    sessionId: "sess_123456789",
    turnId,
    type,
    timestamp: "2026-07-09T00:00:00.000Z",
    payload,
  };
}
