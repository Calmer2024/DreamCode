// @vitest-environment jsdom

import type { AgentEvent } from "@dreamcode/shared";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import type { DesktopState, DesktopTimelineKind } from "../state/desktop-state";
import { createDesktopState, desktopReducer } from "../state/desktop-state";
import { Timeline } from "./Timeline";

describe("Timeline", () => {
  it("renders semantic user, tool, file, and status entries without duplicating the prompt", () => {
    const state: DesktopState = {
      ...createDesktopState({ profiles: [], presets: [], sessions: [] }),
      workspaceRoot: "D:\\Projects\\DreamCode",
      request: {
        prompt: "Fix the timeline",
        workspaceRoot: "D:\\Projects\\DreamCode",
        mode: "guided",
      },
      timeline: [
        entry("user", "User message", "Fix the timeline"),
        entry("tool", "Running shell.run", "pnpm test"),
        entry("file", "update src/app.ts", "diff --git"),
        entry("status", "Turn completed", "All tests passed"),
      ],
    };

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    expect(screen.getAllByText("Fix the timeline")).toHaveLength(1);
    expect(screen.getByTestId("timeline-user")).toBeVisible();
    expect(screen.getByTestId("timeline-tool")).toHaveTextContent("pnpm test");
    expect(screen.getByTestId("timeline-file")).toHaveTextContent("src/app.ts");
    expect(screen.getByTestId("timeline-status")).toHaveTextContent("All tests passed");
  });

  it("shows a real turn prompt once when turn.started precedes user.message", () => {
    const request = {
      prompt: "Fix the timeline",
      workspaceRoot: "D:\\Projects\\DreamCode",
      mode: "guided" as const,
    };
    let state = desktopReducer(
      { ...createDesktopState(), workspaceRoot: request.workspaceRoot },
      { type: "run.started", runId: "run_1", request },
    );
    for (const event of [
      agentEvent("turn.started", { turn: { prompt: request.prompt } }),
      agentEvent("user.message", { content: request.prompt }),
    ]) {
      state = desktopReducer(state, { type: "run.event", message: { runId: "run_1", event } });
    }

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    expect(screen.getAllByText(request.prompt)).toHaveLength(1);
    expect(within(screen.getByLabelText("轮次状态")).queryByText(request.prompt)).toBeNull();
    expect(screen.getByTestId("timeline-user")).toHaveTextContent(request.prompt);
  });

  it("composes each non-message timeline kind with distinct semantic markup", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        entry("tool", "Running shell.run", "pnpm test"),
        entry("file", "update src/app.ts", "diff --git"),
        entry("status", "Turn completed", "All tests passed"),
        entry("turn", "Turn started", "guided"),
        entry("session", "Session created", "sess_1"),
        entry("event", "Model started", "openai / gpt-5"),
      ],
    };

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    const tool = screen.getByLabelText("工具调用");
    expect(tool).toHaveClass("compact-card", "tool-entry");
    expect(within(tool).getByRole("heading", { level: 3 })).toHaveTextContent("shell.run");
    expect(within(tool).getByTestId("timeline-tool-icon")).toHaveAttribute("data-lucide", "wrench");

    const file = screen.getByLabelText("文件变更");
    expect(file).toHaveClass("compact-card", "file-entry");
    expect(within(file).getByRole("heading", { level: 3 })).toHaveTextContent("src/app.ts");
    expect(within(file).getByTestId("timeline-file-icon")).toHaveAttribute(
      "data-lucide",
      "file-code-2",
    );

    for (const [label, testId] of [
      ["运行状态", "timeline-status"],
      ["轮次状态", "timeline-turn"],
      ["会话状态", "timeline-session"],
    ] as const) {
      expect(screen.getByLabelText(label)).toHaveClass("lifecycle-entry");
      expect(screen.getByTestId(testId)).toContainElement(
        within(screen.getByLabelText(label)).getByRole("heading", { level: 3 }),
      );
    }

    const evidence = screen.getByLabelText("事件证据");
    expect(evidence).toHaveClass("evidence-entry", "event-entry");
    expect(within(evidence).getByRole("heading", { level: 3 })).toHaveTextContent("Model started");
  });
});

function entry(kind: DesktopTimelineKind, title: string, detail: string) {
  return {
    id: `entry-${kind}`,
    kind,
    title,
    detail,
    tone: "muted" as const,
    timestamp: "2026-08-10T00:00:00.000Z",
  };
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
