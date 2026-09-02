// @vitest-environment jsdom

import type { AgentEvent } from "@dreamcode/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import type { DesktopState, DesktopTimelineKind } from "../state/desktop-state";
import { createDesktopState, desktopReducer } from "../state/desktop-state";
import { Timeline } from "./Timeline";

describe("Timeline", () => {
  it("shows a project-scoped new conversation landing page with working suggestions", () => {
    const onPromptSuggestion = vi.fn();
    render(
      <Timeline
        state={{
          ...createDesktopState(),
          workspaceRoot: "D:\\Projects\\DreamCode",
        }}
        workspaceName="DreamCode"
        profileUsable
        onConfigure={vi.fn()}
        onChooseWorkspace={vi.fn()}
        onPromptSuggestion={onPromptSuggestion}
      />,
    );

    expect(screen.getByRole("heading", { name: "要在 DreamCode 内开发什么？" })).toBeVisible();
    expect(document.querySelector<HTMLImageElement>(".welcome-mark")?.src).toContain(
      "dreamcode-welcome-icon.png",
    );
    fireEvent.click(screen.getByRole("button", { name: "修复问题和失败" }));
    expect(onPromptSuggestion).toHaveBeenCalledWith("修复问题和失败");
  });

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
        entry("assistant", "Assistant", "## All tests passed"),
        entry("status", "Turn completed", "All tests passed"),
      ],
      changedFiles: [{ path: "src/app.ts", operation: "update", diff: "--- a\n+++ b\n-old\n+new" }],
      changedFilesByTurn: {
        turn_1: [{ path: "src/app.ts", operation: "update", diff: "--- a\n+++ b\n-old\n+new" }],
      },
      turnUsage: {
        turn_1: { inputTokens: 12_000, outputTokens: 800, totalTokens: 12_800 },
      },
    };

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    expect(screen.getAllByText("Fix the timeline")).toHaveLength(1);
    expect(screen.getByTestId("timeline-user")).toBeVisible();
    expect(screen.getByTestId("timeline-tool")).toHaveTextContent("pnpm test");
    expect(screen.getByLabelText("已编辑 1 个文件")).toHaveTextContent("src/app.ts");
    expect(screen.getByLabelText("已编辑 1 个文件")).toHaveTextContent("+1 -1");
    expect(screen.getByRole("heading", { level: 2, name: "All tests passed" })).toBeVisible();
    expect(screen.getByLabelText("本轮 Token 用量")).toHaveTextContent(
      "12,800 tokens · 输入 12,000 · 输出 800",
    );
    expect(screen.queryByTestId("timeline-status")).not.toBeInTheDocument();
    expect(screen.getByText(/已完成 · 耗时/).closest("details")).not.toHaveAttribute("open");
  });

  it("shows the user message time and copies the message from its hover actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [entry("user", "User message", "Copy this message")],
    };

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    const message = screen.getByTestId("timeline-user");
    expect(within(message).getByText(/^\d{1,2}:\d{2}$/)).toBeVisible();
    fireEvent.click(within(message).getByRole("button", { name: "复制用户消息" }));
    expect(writeText).toHaveBeenCalledWith("Copy this message");
    const copiedButton = within(message).getByRole("button", { name: "已复制用户消息" });
    expect(copiedButton).not.toHaveTextContent("已复制");
    expect(copiedButton.querySelector("svg")).toBeTruthy();
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
    expect(screen.queryByTestId("timeline-turn")).not.toBeInTheDocument();
    expect(screen.getByTestId("timeline-user")).toHaveTextContent(request.prompt);
  });

  it("keeps context compaction visible outside the collapsed execution details", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        entry("event", "Context built", "52,000 / 64,000 tokens"),
        entry("event", "上下文已压缩", "较早消息已压缩为结构化检查点。", "warning"),
        entry("assistant", "Assistant", "继续完成任务。"),
        entry("status", "Turn completed", ""),
      ],
    };

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    const notice = screen
      .getByRole("heading", { level: 3, name: "上下文已压缩" })
      .closest("article");
    expect(notice).toBeVisible();
    expect(notice?.closest("details")).toBeNull();
  });

  it("shows the active status at the bottom without an elapsed timer", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        entry("turn", "Turn started", "guided"),
        entry("event", "Model started", "openai / gpt-5"),
        { ...entry("assistant", "Assistant", "正在输出内容"), turnId: "turn_1" },
      ],
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    expect(screen.getByText("执行中")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("正在思考");
    expect(screen.queryByText(/处理中|分钟|秒/)).toBeNull();
    expect(screen.getByTestId("timeline-assistant").compareDocumentPosition(screen.getByRole("status")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders only the diff belonging to each turn", () => {
    const filesForTurn = (path: string, line: string) => [{ path, operation: "update" as const, diff: `--- a/${path}\n+++ b/${path}\n-${line}\n+${line}-changed` }];
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        { ...entry("status", "Turn completed", "done"), turnId: "turn_1" },
        { ...entry("turn", "Turn started", "guided"), id: "turn-2", turnId: "turn_2" },
        { ...entry("assistant", "Assistant", "second turn"), id: "assistant-2", turnId: "turn_2" },
        { ...entry("status", "Turn completed", "done"), id: "status-2", turnId: "turn_2" },
      ],
      changedFilesByTurn: {
        turn_1: filesForTurn("src/first.ts", "first"),
        turn_2: filesForTurn("src/second.ts", "second"),
      },
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    const cards = screen.getAllByLabelText("已编辑 1 个文件");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("src/first.ts");
    expect(cards[1]).toHaveTextContent("src/second.ts");
    expect(cards[0]).not.toHaveTextContent("src/second.ts");
    expect(cards[1]).not.toHaveTextContent("src/first.ts");
  });

  it("composes process evidence and aggregates file changes into a review card", () => {
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
      changedFiles: [
        { path: "src/app.ts", operation: "update", diff: "--- a\n+++ b\n-before\n+after" },
      ],
      changedFilesByTurn: {
        turn_1: [{ path: "src/app.ts", operation: "update", diff: "--- a\n+++ b\n-before\n+after" }],
      },
    };

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    const tool = screen.getByLabelText("工具调用");
    expect(tool).toHaveClass("compact-card", "tool-entry");
    expect(within(tool).getByRole("heading", { level: 3 })).toHaveTextContent("shell.run");
    expect(within(tool).getByTestId("timeline-tool-icon")).toHaveAttribute("data-lucide", "wrench");

    const changes = screen.getByLabelText("已编辑 1 个文件");
    expect(changes).toHaveTextContent("src/app.ts");
    fireEvent.click(within(changes).getByRole("button", { name: "审核" }));
    expect(changes).toHaveTextContent("-before");

    expect(screen.queryByTestId("timeline-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-turn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-session")).not.toBeInTheDocument();

    const evidence = screen.getByLabelText("事件证据");
    expect(evidence).toHaveClass("evidence-entry", "event-entry");
    expect(within(evidence).getByRole("heading", { level: 3 })).toHaveTextContent("Model started");
  });

  it.each([
    { title: "Turn failed", tone: "danger" as const, label: "运行失败", icon: "circle-x" },
    {
      title: "Turn interrupted",
      tone: "warning" as const,
      label: "运行已中断",
      icon: "circle-stop",
    },
  ])("maps $title to its semantic status icon and label", ({ title, tone, label, icon }) => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [entry("status", title, "Outcome detail", tone)],
    };

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    const status = screen.getByLabelText(label);
    expect(status).toHaveClass(`tone-${tone}`);
    expect(within(status).getByTestId("timeline-status-icon")).toHaveAttribute("data-lucide", icon);
  });
});

function entry(
  kind: DesktopTimelineKind,
  title: string,
  detail: string,
  tone: "muted" | "success" | "danger" | "warning" = "muted",
) {
  return {
    id: `entry-${kind}`,
    kind,
    title,
    detail,
    tone,
    timestamp: "2026-08-10T00:00:00.000Z",
    turnId: "turn_1",
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
