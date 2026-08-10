// @vitest-environment jsdom

import type { AgentEvent } from "@dreamcode/shared";
import type { ReplayedSessionState } from "@dreamcode/store";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi, DesktopBootstrap, DesktopRunEvent } from "../../shared/contracts";
import "../../test/setup";
import { App } from "./App";

const bootstrap: DesktopBootstrap = {
  profiles: [
    {
      name: "work",
      provider: "openai-compatible",
      model: "gpt-5.6",
      apiKeyConfigured: true,
    },
  ],
  currentProfile: "work",
  presets: [
    {
      id: "gpt",
      displayName: "GPT",
      defaultModel: "gpt-5.6",
      models: [{ id: "gpt-5.6", label: "GPT-5.6" }],
    },
  ],
  sessions: [
    {
      id: "sess_1",
      workspaceRoot: "D:\\Projects\\DreamCode",
      status: "completed",
      title: "Desktop shell",
      firstPrompt: "Build the desktop shell",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      changedFileCount: 2,
      commandCount: 3,
      totalCostUsd: 0.18,
      eventLogPath: "D:\\sessions\\sess_1\\events.jsonl",
    },
  ],
};

describe("DreamCode desktop shell", () => {
  it("renders only supported navigation and semantic icons", async () => {
    render(<App api={fakeDesktopApi({ bootstrap })} />);

    expect(await screen.findByRole("heading", { level: 2, name: "新对话" })).toBeVisible();
    expect(screen.getByText("会话历史")).toBeVisible();
    expect(screen.getByText("模型与配置")).toBeVisible();
    expect(screen.queryByText("拉取请求")).not.toBeInTheDocument();
    expect(screen.getByTestId("model-config-icon")).toHaveAttribute("data-lucide", "bot");
    expect(screen.getByTestId("run-mode-icon")).toHaveAttribute("data-lucide", "shield-check");
    expect(screen.queryByRole("button", { name: "添加附件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "通知" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();
  });

  it("switches send to stop while a run is active", async () => {
    const startTurn = vi.fn().mockResolvedValue({ runId: "run_1" });
    const api = fakeDesktopApi({ bootstrap, startTurn });
    render(<App api={api} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Fix tests" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("button", { name: "停止" })).toBeVisible();
    expect(startTurn).toHaveBeenCalledWith({
      prompt: "Fix tests",
      workspaceRoot: "D:\\Projects\\DreamCode",
      mode: "guided",
      profileName: "work",
    });
  });

  it("requests a stop for the active run", async () => {
    const stopTurn = vi.fn().mockResolvedValue(undefined);
    const api = fakeDesktopApi({
      bootstrap,
      startTurn: vi.fn().mockResolvedValue({ runId: "run_7" }),
      stopTurn,
    });
    render(<App api={api} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Stop this safely" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(await screen.findByRole("button", { name: "停止" }));

    await waitFor(() => expect(stopTurn).toHaveBeenCalledWith("run_7"));
  });

  it("keeps workspace and session navigation disabled while a run is active", async () => {
    render(<App api={fakeDesktopApi({ bootstrap })} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Keep this run attached" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "停止" });

    expect(screen.getByRole("button", { name: "选择工作区：DreamCode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Desktop shell" })).toBeDisabled();
  });

  it("replays events and terminal status delivered before start resolves", async () => {
    let deliverRunEvent: Parameters<DesktopApi["onRunEvent"]>[0] | undefined;
    let deliverRunStatus: Parameters<DesktopApi["onRunStatus"]>[0] | undefined;
    const startTurn = vi.fn(async () => {
      deliverRunEvent?.({
        runId: "run_early",
        event: agentEvent("model.delta", { text: "Early reply" }),
      });
      deliverRunStatus?.({ runId: "run_early", status: "completed" });
      return { runId: "run_early" };
    });
    const api = fakeDesktopApi({
      bootstrap,
      startTurn,
      onRunEvent: (listener) => {
        deliverRunEvent = listener;
        return () => undefined;
      },
      onRunStatus: (listener) => {
        deliverRunStatus = listener;
        return () => undefined;
      },
    });
    render(<App api={api} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Capture every event" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("Early reply")).toBeVisible();
    expect(await screen.findByText("已完成")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeVisible();
  });

  it("uses an available configured profile instead of a stale current profile", async () => {
    const startTurn = vi.fn().mockResolvedValue({ runId: "run_1" });
    render(
      <App
        api={fakeDesktopApi({
          bootstrap: { ...bootstrap, currentProfile: "removed" },
          startTurn,
        })}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Use a real profile" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ profileName: "work" })),
    );
  });

  it("disables sending when the selected profile has no configured API key", async () => {
    render(
      <App
        api={fakeDesktopApi({
          bootstrap: {
            ...bootstrap,
            profiles: [{ ...bootstrap.profiles[0]!, apiKeyConfigured: false }],
          },
        })}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Do not send this" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("keeps the newest session when reads resolve out of order", async () => {
    const first = deferred<ReplayedSessionState>();
    const second = deferred<ReplayedSessionState>();
    const sessions = [
      bootstrap.sessions[0]!,
      {
        ...bootstrap.sessions[0]!,
        id: "sess_2",
        workspaceRoot: "D:\\Projects\\Second",
        title: "Second session",
      },
    ];
    const readSession = vi.fn((sessionId: string) =>
      sessionId === "sess_1" ? first.promise : second.promise,
    );
    render(<App api={fakeDesktopApi({ bootstrap: { ...bootstrap, sessions }, readSession })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(await screen.findByRole("button", { name: "Desktop shell" }));
    fireEvent.click(screen.getByRole("button", { name: "Second session" }));
    await act(async () => {
      second.resolve(replayedSession("sess_2", "D:\\Projects\\Second"));
      await second.promise;
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Second session" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    await act(async () => {
      first.resolve(replayedSession("sess_1", "D:\\Projects\\DreamCode"));
      await first.promise;
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Second session" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
  });

  it("marks the selected session purple and elevated run modes orange", async () => {
    render(
      <App
        api={fakeDesktopApi({
          bootstrap,
          readSession: vi
            .fn()
            .mockResolvedValue(replayedSession("sess_1", bootstrap.sessions[0]!.workspaceRoot)),
        })}
      />,
    );

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    const sessionButton = screen.getByRole("button", { name: "Desktop shell" });
    fireEvent.click(sessionButton);
    await waitFor(() => expect(sessionButton).toHaveAttribute("data-accent", "purple"));
    fireEvent.change(screen.getByLabelText("运行模式"), { target: { value: "yolo" } });
    expect(screen.getByLabelText("运行模式")).toHaveAttribute("data-accent", "orange");
  });

  it("ignores an error from a stale session read", async () => {
    const stale = deferred<ReplayedSessionState>();
    const current = deferred<ReplayedSessionState>();
    const sessions = [
      bootstrap.sessions[0]!,
      {
        ...bootstrap.sessions[0]!,
        id: "sess_2",
        workspaceRoot: "D:\\Projects\\Second",
        title: "Second session",
      },
    ];
    const readSession = vi.fn((sessionId: string) =>
      sessionId === "sess_1" ? stale.promise : current.promise,
    );
    render(<App api={fakeDesktopApi({ bootstrap: { ...bootstrap, sessions }, readSession })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(await screen.findByRole("button", { name: "Desktop shell" }));
    fireEvent.click(screen.getByRole("button", { name: "Second session" }));
    await act(async () => {
      current.resolve(replayedSession("sess_2", "D:\\Projects\\Second"));
      await current.promise;
    });
    await act(async () => {
      stale.reject(new Error("stale read failed"));
      await stale.promise.catch(() => undefined);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prevents a pending session read from restoring history after new conversation", async () => {
    const pending = deferred<ReplayedSessionState>();
    render(<App api={fakeDesktopApi({ bootstrap, readSession: vi.fn(() => pending.promise) })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(await screen.findByRole("button", { name: "Desktop shell" }));
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await act(async () => {
      pending.resolve(replayedSession("sess_1", "D:\\Projects\\DreamCode"));
      await pending.promise;
    });

    expect(screen.getByRole("button", { name: "Desktop shell" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("prevents a pending session read from restoring history after workspace change", async () => {
    const pending = deferred<ReplayedSessionState>();
    render(
      <App
        api={fakeDesktopApi({
          bootstrap,
          readSession: vi.fn(() => pending.promise),
          chooseWorkspace: vi.fn().mockResolvedValue("D:\\Projects\\NextWorkspace"),
        })}
      />,
    );

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(await screen.findByRole("button", { name: "Desktop shell" }));
    fireEvent.click(screen.getByRole("button", { name: /DreamCode|选择工作区/ }));
    await act(async () => {
      pending.resolve(replayedSession("sess_1", "D:\\Projects\\DreamCode"));
      await pending.promise;
    });

    expect(screen.getByText("NextWorkspace")).toBeVisible();
    expect(screen.getByRole("button", { name: "Desktop shell" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("preserves edits made while startTurn is pending", async () => {
    const pending = deferred<{ runId: string }>();
    render(<App api={fakeDesktopApi({ bootstrap, startTurn: vi.fn(() => pending.promise) })} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Submitted prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.change(prompt, { target: { value: "New draft while starting" } });
    await act(async () => {
      pending.resolve({ runId: "run_pending" });
      await pending.promise;
    });

    expect(prompt).toHaveValue("New draft while starting");
  });

  it("allows a fake profile without an API key", async () => {
    const startTurn = vi.fn().mockResolvedValue({ runId: "run_fake" });
    const fakeProfile = {
      ...bootstrap.profiles[0]!,
      name: "fake",
      provider: "fake",
      apiKeyConfigured: false,
    };
    render(
      <App
        api={fakeDesktopApi({
          bootstrap: { ...bootstrap, profiles: [fakeProfile], currentProfile: "fake" },
          startTurn,
        })}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Run the fake model" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
  });

  it("shows an actionable configuration state for an unusable selected profile", async () => {
    render(
      <App
        api={fakeDesktopApi({
          bootstrap: {
            ...bootstrap,
            profiles: [{ ...bootstrap.profiles[0]!, apiKeyConfigured: false }],
          },
        })}
      />,
    );

    expect(await screen.findByText("先配置模型，再开始对话")).toBeVisible();
    expect(screen.getByRole("button", { name: "打开模型与配置" })).toBeVisible();
  });

  it("auto-follows streaming only while the reader remains near the bottom", async () => {
    let deliverRunEvent: ((message: DesktopRunEvent) => void) | undefined;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    render(
      <App
        api={fakeDesktopApi({
          bootstrap,
          startTurn: vi.fn().mockResolvedValue({ runId: "run_scroll" }),
          onRunEvent: (listener) => {
            deliverRunEvent = listener;
            return () => undefined;
          },
        })}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Stream a response" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "停止" });
    const scroll = document.querySelector<HTMLElement>(".conversation-scroll")!;
    setScrollMetrics(scroll, { scrollHeight: 1000, clientHeight: 600, scrollTop: 360 });
    fireEvent.scroll(scroll);
    deliverRunEvent?.({
      runId: "run_scroll",
      event: agentEvent("model.delta", { text: "Following" }),
    });
    await screen.findByText("Following");
    expect(scrollIntoView).toHaveBeenCalled();

    scrollIntoView.mockClear();
    setScrollMetrics(scroll, { scrollHeight: 1400, clientHeight: 600, scrollTop: 100 });
    fireEvent.scroll(scroll);
    deliverRunEvent?.({
      runId: "run_scroll",
      event: agentEvent("model.delta", { text: " without jumping" }),
    });
    await screen.findByText("Following without jumping");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("shows the submitted prompt as task title with workspace secondary", async () => {
    render(<App api={fakeDesktopApi({ bootstrap })} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    expect(screen.getByRole("heading", { level: 2, name: "新对话" })).toBeVisible();
    fireEvent.change(prompt, { target: { value: "Name this task" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Name this task" })).toBeVisible();
    expect(screen.getAllByText("DreamCode").length).toBeGreaterThan(0);
  });

  it("shows the active session title as the task title", async () => {
    render(
      <App
        api={fakeDesktopApi({
          bootstrap,
          readSession: vi
            .fn()
            .mockResolvedValue(replayedSession("sess_1", bootstrap.sessions[0]!.workspaceRoot)),
        })}
      />,
    );

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(await screen.findByRole("button", { name: "Desktop shell" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Desktop shell" })).toBeVisible();
  });

  it("opens functional detail controls and handles approval and question requests", async () => {
    let deliverApproval: Parameters<DesktopApi["onApprovalRequest"]>[0] | undefined;
    let deliverQuestion: Parameters<DesktopApi["onQuestionRequest"]>[0] | undefined;
    const respondApproval = vi.fn().mockResolvedValue(undefined);
    const respondQuestion = vi.fn().mockResolvedValue(undefined);
    const api = fakeDesktopApi({
      bootstrap,
      readSession: vi
        .fn()
        .mockResolvedValue(replayedSession("sess_1", bootstrap.sessions[0]!.workspaceRoot)),
      readDiff: vi.fn().mockResolvedValue("diff evidence"),
      respondApproval,
      respondQuestion,
      onApprovalRequest: (listener) => {
        deliverApproval = listener;
        return () => undefined;
      },
      onQuestionRequest: (listener) => {
        deliverQuestion = listener;
        return () => undefined;
      },
    });
    render(<App api={api} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(screen.getByRole("button", { name: "Desktop shell" }));
    await screen.findByRole("heading", { level: 2, name: "Desktop shell" });
    fireEvent.click(screen.getByRole("button", { name: "终端" }));
    expect(screen.getByRole("dialog", { name: "任务证据" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "终端" })).toHaveAttribute("aria-selected", "true");

    act(() =>
      deliverApproval?.({
        runId: "run_1",
        requestId: "approval_1",
        tool: "shell_command",
        input: { command: "pnpm test" },
        reason: "Needs review",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "允许" }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenCalledWith({
        runId: "run_1",
        requestId: "approval_1",
        approved: true,
      }),
    );

    act(() =>
      deliverQuestion?.({
        runId: "run_1",
        requestId: "question_1",
        question: "Which file?",
      }),
    );
    fireEvent.change(await screen.findByLabelText("回答"), { target: { value: "README.md" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() =>
      expect(respondQuestion).toHaveBeenCalledWith({
        runId: "run_1",
        requestId: "question_1",
        answer: "README.md",
      }),
    );
  });

  it("cleans up every renderer event subscription on unmount", async () => {
    const unsubscribeRunEvent = vi.fn();
    const unsubscribeRunStatus = vi.fn();
    const unsubscribeApproval = vi.fn();
    const unsubscribeQuestion = vi.fn();
    const { unmount } = render(
      <App
        api={fakeDesktopApi({
          bootstrap,
          onRunEvent: vi.fn().mockReturnValue(unsubscribeRunEvent),
          onRunStatus: vi.fn().mockReturnValue(unsubscribeRunStatus),
          onApprovalRequest: vi.fn().mockReturnValue(unsubscribeApproval),
          onQuestionRequest: vi.fn().mockReturnValue(unsubscribeQuestion),
        })}
      />,
    );

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    unmount();

    expect(unsubscribeRunEvent).toHaveBeenCalledOnce();
    expect(unsubscribeRunStatus).toHaveBeenCalledOnce();
    expect(unsubscribeApproval).toHaveBeenCalledOnce();
    expect(unsubscribeQuestion).toHaveBeenCalledOnce();
  });

  it("opens configuration from the sidebar and applies the saved bootstrap", async () => {
    const updated = {
      ...bootstrap,
      profiles: [{ ...bootstrap.profiles[0]!, model: "gpt-new" }],
    };
    const saveProfile = vi.fn().mockResolvedValue(updated);
    render(<App api={fakeDesktopApi({ bootstrap, saveProfile })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(screen.getByRole("button", { name: "模型与配置" }));
    expect(screen.getByRole("dialog", { name: "模型与配置" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "__custom__" } });
    fireEvent.change(screen.getByLabelText("自定义模型 ID"), {
      target: { value: "gpt-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(saveProfile).toHaveBeenCalled());
    expect(await screen.findByRole("option", { name: "gpt-new" })).toBeInTheDocument();
  });

  it("submits with Ctrl+Enter and blocks an invalid prompt", async () => {
    const startTurn = vi.fn().mockResolvedValue({ runId: "run_1" });
    render(<App api={fakeDesktopApi({ bootstrap, startTurn })} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    fireEvent.change(prompt, { target: { value: "  Review this code  " } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter", ctrlKey: true });

    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Review this code" }));
  });

  it("renders assistant deltas received for the active run", async () => {
    let deliverRunEvent: ((message: DesktopRunEvent) => void) | undefined;
    const api = fakeDesktopApi({
      bootstrap,
      startTurn: vi.fn().mockResolvedValue({ runId: "run_1" }),
      onRunEvent: (listener) => {
        deliverRunEvent = listener;
        return () => undefined;
      },
    });
    render(<App api={api} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Explain the change" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "停止" });

    deliverRunEvent?.({ runId: "run_1", event: agentEvent("model.delta", { text: "First " }) });
    deliverRunEvent?.({ runId: "run_1", event: agentEvent("model.delta", { text: "reply" }) });

    expect(await screen.findByText("First reply")).toBeVisible();
  });

  it("shows a recoverable configuration state when bootstrap fails", async () => {
    const api = fakeDesktopApi();
    api.bootstrap = vi.fn().mockRejectedValue({
      code: "config_load_failed",
      message: "Failed to load DreamCode configuration.",
      recoverable: true,
    });

    render(<App api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to load DreamCode configuration.",
    );
    expect(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
  });

  it("explains missing model configuration and disables sending", async () => {
    render(
      <App
        api={fakeDesktopApi({
          bootstrap: { ...bootstrap, profiles: [], currentProfile: undefined },
        })}
      />,
    );

    expect(await screen.findByText("先配置模型，再开始对话")).toBeVisible();
    const prompt = screen.getByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Try to send" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});

function fakeDesktopApi(
  overrides: Omit<Partial<DesktopApi>, "bootstrap"> & { bootstrap?: DesktopBootstrap } = {},
) {
  const { bootstrap: bootstrapOverride, ...apiOverrides } = overrides;
  const bootstrapValue = bootstrapOverride ?? {
    profiles: [],
    presets: [],
    sessions: [],
  };
  const api: DesktopApi = {
    bootstrap: vi.fn().mockResolvedValue(bootstrapValue),
    chooseWorkspace: vi.fn().mockResolvedValue(undefined),
    saveProfile: vi.fn().mockResolvedValue(bootstrapValue),
    startTurn: vi.fn().mockResolvedValue({ runId: "run_1" }),
    stopTurn: vi.fn().mockResolvedValue(undefined),
    readSession: vi.fn(),
    readDiff: vi.fn(),
    rollback: vi.fn(),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    respondQuestion: vi.fn().mockResolvedValue(undefined),
    onRunEvent: vi.fn().mockReturnValue(() => undefined),
    onApprovalRequest: vi.fn().mockReturnValue(() => undefined),
    onQuestionRequest: vi.fn().mockReturnValue(() => undefined),
    onRunStatus: vi.fn().mockReturnValue(() => undefined),
    ...apiOverrides,
  };
  return api;
}

function agentEvent(type: AgentEvent["type"], payload: unknown): AgentEvent {
  return {
    id: `evt_${Math.random()}`,
    sessionId: "sess_1",
    turnId: "turn_1",
    type,
    timestamp: "2026-08-10T00:00:00.000Z",
    payload,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function replayedSession(id: string, workspaceRoot: string): ReplayedSessionState {
  return {
    session: {
      id,
      workspaceRoot,
      sessionDir: `D:\\sessions\\${id}`,
      createdAt: "2026-08-10T00:00:00.000Z",
    },
    turns: [],
    status: "completed",
    todoItems: [],
    changedFiles: [],
    commands: [],
    artifacts: [],
    approvals: [],
    costUsd: 0,
    warnings: [],
  };
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop },
  });
}
