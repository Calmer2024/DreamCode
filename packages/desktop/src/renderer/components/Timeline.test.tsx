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

  it("renders an inline markdown question with the compact icon submit action", () => {
    render(
      <Timeline
        state={{ ...createDesktopState(), workspaceRoot: "D:\\Projects\\DreamCode" }}
        profileUsable
        onConfigure={vi.fn()}
        onChooseWorkspace={vi.fn()}
        questionRequest={{
          runId: "run_1",
          requestId: "question_1",
          question: "Choose **one**:\n\n- Alpha\n- Beta",
        }}
        questionApi={{ respondQuestion: vi.fn() }}
        onQuestionResolved={vi.fn()}
      />,
    );

    const card = screen.getByLabelText("Agent 问题");
    expect(within(card).getByText("需要输入")).toHaveClass("request-card-kicker");
    expect(within(card).getByText("需要输入").closest("header")?.querySelector(".approval-card-icon")).not.toBeNull();
    expect(within(card).getByText("one").tagName).toBe("SPAN");
    expect(within(card).getByRole("list")).toHaveTextContent("Alpha Beta");
    expect(within(card).getByText("Ctrl+Enter 提交")).toBeVisible();
    const submit = within(card).getByRole("button", { name: "提交回答" });
    expect(submit).not.toHaveTextContent("提交回答");
    expect(submit.querySelector("svg")).not.toBeNull();
  });

  it("renders a completed tool as one collapsed inline row without duplicating the prompt", () => {
    const state: DesktopState = {
      ...createDesktopState({ profiles: [], presets: [], sessions: [] }),
      workspaceRoot: "D:\\Projects\\DreamCode",
      request: {
        prompt: "Fix the timeline",
        workspaceRoot: "D:\\Projects\\DreamCode",
        mode: "workspace-write",
      },
      timeline: [
        entry("user", "User message", "Fix the timeline"),
        entry("tool", `Running ${process.platform === "win32" ? "pwsh" : "bash"}`, "pnpm test"),
        entry("file", "update src/app.ts", "diff --git"),
        entry("assistant", "Assistant", "## All tests passed"),
        entry("status", "Turn completed", "All tests passed"),
      ],
      tools: [{
        id: "tool_1",
        turnId: "turn_1",
        name: process.platform === "win32" ? "pwsh" : "bash",
        status: "success",
        inputPreview: '{"command":"pnpm test"}',
        summary: "passed",
        startedAt: "2026-08-10T00:00:00.000Z",
        completedAt: "2026-08-10T00:00:00.000Z",
      }],
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
    const tool = screen.getByTestId("tool-call-row");
    expect(tool).not.toHaveAttribute("open");
    expect(tool).toHaveTextContent("pnpm test");
    fireEvent.click(within(tool).getByText("pnpm test"));
    expect(tool).toHaveAttribute("open");
    expect(screen.queryByText("src/app.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "All tests passed" })).toBeVisible();
    expect(screen.getByLabelText("本轮 Token 用量")).toHaveTextContent(
      "12,800 tokens · 输入 12,000 · 输出 800",
    );
    expect(screen.queryByTestId("timeline-status")).not.toBeInTheDocument();
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

  it("keeps each tool row between the assistant text fragments where it occurred", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        { ...entry("assistant", "Assistant", "先检查类型。"), id: "assistant-before" },
        { ...entry("tool", "Running pnpm", "pnpm typecheck"), id: "tool-middle" },
        { ...entry("assistant", "Assistant", "类型检查完成。"), id: "assistant-after" },
        { ...entry("status", "Turn completed", "done"), id: "status-complete" },
      ],
      tools: [{
        id: "tool-middle",
        turnId: "turn_1",
        name: "pnpm",
        status: "success",
        inputPreview: "pnpm typecheck",
        startedAt: "2026-08-10T00:00:00.000Z",
        completedAt: "2026-08-10T00:00:00.000Z",
      }],
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    const before = screen.getByText("先检查类型。").closest("article") as HTMLElement;
    const group = screen.getByTestId("tool-call-row");
    const after = screen.getByText("类型检查完成。").closest("article") as HTMLElement;
    expect(before.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group).not.toHaveAttribute("open");
    fireEvent.click(group.querySelector("summary") as HTMLElement);
    expect(group).toHaveAttribute("open");
  });

  it("renders assistant reasoning as a collapsed Think row", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [{
        ...entry("assistant", "Assistant", "最终答案。"),
        reasoning: "先读取工具结果，再给出结论。",
      }],
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    const reasoning = screen.getByTestId("assistant-reasoning");
    expect(reasoning).not.toHaveAttribute("open");
    expect(within(reasoning).getByText("Think")).toBeVisible();
    fireEvent.click(within(reasoning).getByText("Think"));
    expect(reasoning).toHaveAttribute("open");
    expect(within(reasoning).getByText("先读取工具结果，再给出结论。")).toBeVisible();
    expect(screen.getByText("最终答案。")).toBeVisible();
  });

  it("keeps only the final assistant output expanded after a turn completes", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        { ...entry("assistant", "Assistant", "先完成项目检查。"), id: "assistant-1" },
        { ...entry("tool", "Running shell", "pnpm test"), id: "tool-1", timestamp: "2026-08-10T00:00:10.000Z" },
        { ...entry("assistant", "Assistant", "测试已经通过。"), id: "assistant-2" },
        { ...entry("status", "Turn completed", "done"), id: "status-complete" },
      ],
      tools: [{
        id: "tool-1",
        turnId: "turn_1",
        name: "shell",
        status: "success",
        inputPreview: '{"command":"pnpm test"}',
        startedAt: "2026-08-10T00:00:10.000Z",
        completedAt: "2026-08-10T00:00:10.000Z",
      }],
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    const history = screen.getByTestId("turn-history");
    expect(history).not.toHaveAttribute("open");
    expect(history).toHaveTextContent("已工作");
    expect(screen.getAllByTestId("tool-call-row")).toHaveLength(1);
    expect(screen.getByText("测试已经通过。")).toBeVisible();
    expect(within(history).queryByText("先完成项目检查。")).not.toBeVisible();

    fireEvent.click(history.querySelector("summary") as HTMLElement);
    expect(history).toHaveAttribute("open");
    expect(within(history).getByText("先完成项目检查。")).toBeVisible();
    expect(within(history).getByTestId("tool-call-row")).toBeInTheDocument();
  });

  it("groups consecutive reasoning-only entries into a collapsed Think section while running", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      runStatus: "running",
      timeline: [
        { ...entry("assistant", "Assistant", ""), id: "think-1", reasoning: "先检查项目结构。" },
        { ...entry("assistant", "Assistant", ""), id: "think-2", reasoning: "再决定修改范围。" },
        { ...entry("assistant", "Assistant", "最终答案。"), id: "assistant-final" },
      ],
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    const group = screen.getByTestId("activity-group-think");
    expect(group).not.toHaveAttribute("open");
    expect(group).toHaveTextContent("Think");
    expect(group).toHaveTextContent("2 段");
    expect(within(group).queryByText("最终答案。")).not.toBeInTheDocument();

    fireEvent.click(group.querySelector("summary") as HTMLElement);
    expect(group).toHaveAttribute("open");
    expect(within(group).getAllByTestId("assistant-reasoning")).toHaveLength(2);
    const firstThink = within(group).getAllByTestId("assistant-reasoning")[0]!;
    fireEvent.click(firstThink.querySelector("summary") as HTMLElement);
    expect(within(firstThink).getByText("先检查项目结构。")).toBeVisible();
    expect(screen.getByText("最终答案。")).toBeVisible();
  });

  it("keeps active tool groups open and folds them when the turn finishes", () => {
    const firstToolTimestamp = "2026-08-10T00:00:10.000Z";
    const secondToolTimestamp = "2026-08-10T00:00:15.000Z";
    const skillTimestamp = "2026-08-10T00:00:20.000Z";
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      runStatus: "running",
      timeline: [
        { ...entry("tool", "Running shell", "pnpm test"), id: "tool-entry-1", timestamp: firstToolTimestamp },
        { ...entry("tool", "Running mcp__docs__search", "query"), id: "tool-entry-2", timestamp: secondToolTimestamp },
        { ...entry("event", "Skill loaded", "diagnose"), id: "skill-entry", timestamp: skillTimestamp },
      ],
      tools: [
        {
          id: "shell-call",
          turnId: "turn_1",
          name: "shell",
          status: "success",
          inputPreview: '{"command":"pnpm test"}',
          startedAt: firstToolTimestamp,
          completedAt: firstToolTimestamp,
        },
        {
          id: "mcp-call",
          turnId: "turn_1",
          name: "mcp__docs__search",
          status: "success",
          inputPreview: '{"query":"events"}',
          startedAt: secondToolTimestamp,
          completedAt: secondToolTimestamp,
        },
        {
          id: "skill-call",
          turnId: "turn_1",
          name: "skill",
          status: "success",
          inputPreview: '{"name":"diagnose"}',
          summary: "diagnose",
          startedAt: skillTimestamp,
          completedAt: skillTimestamp,
        },
      ],
    };

    const { rerender } = render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    const group = screen.getByTestId("activity-group-tool");
    expect(group).toHaveAttribute("open");
    expect(group).toHaveTextContent("工具调用");
    expect(group).toHaveTextContent("3 项");
    expect(screen.getAllByTestId("tool-call-row")).toHaveLength(3);

    fireEvent.click(group.querySelector("summary") as HTMLElement);
    expect(group).not.toHaveAttribute("open");

    const streamedState: DesktopState = {
      ...state,
      timeline: [
        ...state.timeline,
        {
          ...entry("tool", "Running shell", "pnpm typecheck"),
          id: "tool-entry-4",
          timestamp: "2026-08-10T00:00:25.000Z",
        },
      ],
      tools: [
        ...state.tools,
        {
          id: "typecheck-call",
          turnId: "turn_1",
          name: "shell",
          status: "running",
          inputPreview: '{"command":"pnpm typecheck"}',
          startedAt: "2026-08-10T00:00:25.000Z",
        },
      ],
    };
    rerender(
      <Timeline
        state={streamedState}
        profileUsable
        onConfigure={vi.fn()}
        onChooseWorkspace={vi.fn()}
      />,
    );

    expect(screen.getByTestId("activity-group-tool")).not.toHaveAttribute("open");
    expect(screen.getByTestId("activity-group-tool")).toHaveTextContent("4 项");
    fireEvent.click(group.querySelector("summary") as HTMLElement);
    expect(group).toHaveAttribute("open");

    const latestState: DesktopState = {
      ...streamedState,
      timeline: [
        ...streamedState.timeline,
        {
          ...entry("tool", "Running file.read", "src/renderer/App.tsx"),
          id: "tool-entry-5",
          timestamp: "2026-08-10T00:00:30.000Z",
        },
      ],
      tools: [
        ...streamedState.tools,
        {
          id: "file-read-call",
          turnId: "turn_1",
          name: "file.read",
          status: "running",
          inputPreview: '{"path":"src/renderer/App.tsx"}',
          startedAt: "2026-08-10T00:00:30.000Z",
        },
      ],
    };
    rerender(
      <Timeline
        state={latestState}
        profileUsable
        onConfigure={vi.fn()}
        onChooseWorkspace={vi.fn()}
      />,
    );

    expect(screen.getByTestId("activity-group-tool")).toHaveAttribute("open");
    expect(screen.getByTestId("activity-group-tool")).toHaveTextContent("5 项");

    rerender(
      <Timeline
        state={{
          ...latestState,
          runStatus: "completed",
          timeline: [
            ...latestState.timeline,
            { ...entry("status", "Turn completed", "done"), id: "turn-complete" },
          ],
        }}
        profileUsable
        onConfigure={vi.fn()}
        onChooseWorkspace={vi.fn()}
      />,
    );

    expect(screen.getByTestId("activity-group-tool")).not.toHaveAttribute("open");
  });

  it("shows one expandable row per visible tool and hides internal runtime events", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        { ...entry("turn", "Turn started", "workspace-write"), id: "turn-start", timestamp: "2026-08-10T00:00:00.000Z" },
        { ...entry("assistant", "Assistant", "开始检查。"), id: "assistant-before" },
        { ...entry("event", "Model started", "openai / gpt-5"), id: "model-started" },
        { ...entry("event", "Tool schedule planned", "2 calls"), id: "schedule" },
        { ...entry("event", "Permission allow", "shell"), id: "permission" },
        { ...entry("tool", "Running shell", "pnpm test"), id: "shell-start", timestamp: "2026-08-10T00:00:10.000Z" },
        { ...entry("tool", "shell success", "passed"), id: "shell-end", timestamp: "2026-08-10T00:00:15.000Z" },
        { ...entry("assistant", "Assistant", "继续加载技能。"), id: "assistant-middle" },
        { ...entry("event", "Skill loaded", "diagnose"), id: "skill-loaded" },
        { ...entry("tool", "Running mcp__docs__search", "query"), id: "mcp-start", timestamp: "2026-08-10T00:00:20.000Z" },
      ],
      tools: [
        { id: "shell-call", turnId: "turn_1", name: "shell", status: "success", inputPreview: '{"command":"pnpm test"}', summary: "passed", startedAt: "2026-08-10T00:00:10.000Z", completedAt: "2026-08-10T00:00:15.000Z" },
        { id: "mcp-call", turnId: "turn_1", name: "mcp__docs__search", status: "running", inputPreview: '{"query":"events"}', startedAt: "2026-08-10T00:00:20.000Z" },
      ],
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    expect(screen.getAllByTestId("tool-call-row")).toHaveLength(3);
    expect(screen.getByText("pnpm test")).toBeVisible();
    expect(screen.getAllByText("diagnose")[0]).toBeVisible();
    expect(screen.getAllByText("mcp__docs__search")[0]).toHaveClass("status-shimmer");
    expect(screen.queryByText("Model started")).not.toBeInTheDocument();
    expect(screen.queryByText("Tool schedule planned")).not.toBeInTheDocument();
    expect(screen.queryByText("Permission allow")).not.toBeInTheDocument();
    expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
    expect(screen.getByText(/已工作/)).toBeVisible();
  });

  it("shows a real turn prompt once when turn.started precedes user.message", () => {
    const request = {
      prompt: "Fix the timeline",
      workspaceRoot: "D:\\Projects\\DreamCode",
      mode: "workspace-write" as const,
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

  it("hides context compaction as an internal runtime event", () => {
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

    expect(screen.queryByText("上下文已压缩")).not.toBeInTheDocument();
    expect(screen.getByText("继续完成任务。")).toBeVisible();
  });

  it("shows a live elapsed timer beside the active execution status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:05.000Z"));
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        entry("turn", "Turn started", "workspace-write"),
        entry("event", "Model started", "openai / gpt-5"),
        { ...entry("assistant", "Assistant", "正在输出内容"), turnId: "turn_1" },
      ],
    };

    try {
      render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

      expect(screen.getByText("已工作 1分钟 5秒")).toBeVisible();
      expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
      expect(screen.getByTestId("timeline-assistant")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the thinking indicator only before the assistant emits output", () => {
    const baseState: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        entry("turn", "Turn started", "workspace-write"),
        entry("event", "Model started", "openai / gpt-5"),
      ],
    };
    const { rerender } = render(
      <Timeline state={baseState} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    expect(screen.getByText("正在思考")).toBeVisible();

    rerender(
      <Timeline
        state={{ ...baseState, timeline: [...baseState.timeline, entry("assistant", "Assistant", "最终输出")] }}
        profileUsable
        onConfigure={vi.fn()}
        onChooseWorkspace={vi.fn()}
      />,
    );
    expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
  });

  it("stops the live thinking state when a turn is interrupted", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      runStatus: "interrupted",
      timeline: [
        entry("event", "Model started", "openai / gpt-5"),
        entry("assistant", "Assistant", "中断前的输出"),
        entry("status", "Turn interrupted", "Stopped by user", "warning"),
      ],
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
    expect(screen.getByLabelText("运行已中断")).toHaveTextContent("Stopped by user");
  });

  it("automatically collapses long user text and lets the user expand and collapse it", () => {
    const content = "Long user content ".repeat(40);
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [entry("user", "User message", content)],
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    const message = screen.getByTestId("timeline-user");
    const text = message.querySelector(".user-bubble-content");
    expect(text).toHaveTextContent(content.trim());
    const expand = within(message).getByRole("button", { name: "展开用户消息" });
    expect(text).toHaveClass("is-collapsed");
    expect(expand).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expand);
    expect(text).not.toHaveClass("is-collapsed");
    expect(within(message).getByRole("button", { name: "折叠用户消息" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("does not render file-change bookkeeping as a tool row", () => {
    const filesForTurn = (path: string, line: string) => [{ path, operation: "update" as const, diff: `--- a/${path}\n+++ b/${path}\n-${line}\n+${line}-changed` }];
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        { ...entry("file", "update src/first.ts", ""), id: "file-1", turnId: "turn_1" },
        { ...entry("status", "Turn completed", "done"), id: "status-1", turnId: "turn_1" },
        { ...entry("turn", "Turn started", "workspace-write"), id: "turn-2", turnId: "turn_2" },
        { ...entry("assistant", "Assistant", "second turn"), id: "assistant-2", turnId: "turn_2" },
        { ...entry("file", "update src/second.ts", ""), id: "file-2", turnId: "turn_2" },
        { ...entry("status", "Turn completed", "done"), id: "status-2", turnId: "turn_2" },
      ],
      changedFilesByTurn: {
        turn_1: filesForTurn("src/first.ts", "first"),
        turn_2: filesForTurn("src/second.ts", "second"),
      },
    };

    render(<Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />);

    expect(screen.queryByText("src/first.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("src/second.ts")).not.toBeInTheDocument();
  });

  it("hides raw tool and file bookkeeping when no canonical tool call exists", () => {
    const state: DesktopState = {
      ...createDesktopState(),
      workspaceRoot: "D:\\Projects\\DreamCode",
      timeline: [
        entry("tool", `Running ${process.platform === "win32" ? "pwsh" : "bash"}`, "pnpm test"),
        entry("file", "update src/app.ts", "diff --git"),
        entry("status", "Turn completed", "All tests passed"),
        entry("turn", "Turn started", "workspace-write"),
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

    expect(screen.queryByTestId("tool-call-row")).not.toBeInTheDocument();
    expect(screen.queryByText("src/app.ts")).not.toBeInTheDocument();

    expect(screen.queryByTestId("timeline-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-turn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-session")).not.toBeInTheDocument();

    expect(screen.queryByText("Model started")).not.toBeInTheDocument();
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
