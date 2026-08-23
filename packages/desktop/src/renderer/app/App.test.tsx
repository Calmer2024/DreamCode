// @vitest-environment jsdom

import type { AgentEvent } from "@dreamcode/shared";
import type { ReplayedSessionState } from "@dreamcode/store";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  DesktopBootstrap,
  DesktopRunEvent,
  DesktopSessionDetail,
} from "../../shared/contracts";
import "../../test/setup";
import { App } from "./App";

vi.mock("../components/TerminalView", () => ({
  TerminalView: () => <div role="application" aria-label="系统终端" />,
}));

afterEach(() => {
  window.localStorage.removeItem("dreamcode:pinned-workspaces");
  window.localStorage.removeItem("dreamcode:removed-workspaces");
});

const bootstrap: DesktopBootstrap = {
  profiles: [
    {
      id: "work",
      alias: "work",
      provider: "openai-compatible",
      model: "gpt-5.6",
      credentialSource: "inline",
      credentialAvailable: true,
    },
  ],
  currentProfileId: "work",
  presets: [
    {
      id: "openai-compatible",
      displayName: "GPT",
      defaultModel: "gpt-5.6",
      models: [
        { id: "gpt-5.6", label: "GPT-5.6" },
        { id: "gpt-5.5", label: "GPT-5.5" },
      ],
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
    expect(screen.queryByText("会话历史")).not.toBeInTheDocument();
    expect(screen.queryByText("模型与配置")).not.toBeInTheDocument();
    expect(screen.getByText("设置")).toBeVisible();
    expect(screen.queryByText("拉取请求")).not.toBeInTheDocument();
    expect(screen.getByTestId("run-mode-icon")).toHaveAttribute("data-lucide", "shield-check");
    expect(screen.queryByRole("button", { name: "添加附件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "通知" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();
  });

  it("persists project pin, explorer, and destructive chat removal through the desktop API", async () => {
    const openWorkspace = vi.fn().mockResolvedValue(undefined);
    const saveProject = vi.fn().mockResolvedValue({
      ...bootstrap,
      projects: [
        {
          workspaceRoot: "D:\\Projects\\DreamCode",
          name: "DreamCode",
          pinned: true,
          createdAt: "2026-08-10T00:00:00.000Z",
        },
      ],
    });
    const deleteProject = vi.fn().mockResolvedValue({
      ...bootstrap,
      sessions: [],
      projects: [],
    });
    render(<App api={fakeDesktopApi({ bootstrap, openWorkspace, saveProject, deleteProject })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    const more = screen.getByRole("button", { name: "项目更多操作" });
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: "置顶项目" }));
    expect(saveProject).toHaveBeenCalledWith({
      workspaceRoot: "D:\\Projects\\DreamCode",
      name: "DreamCode",
      pinned: true,
    });

    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: "在资源管理器中打开" }));
    expect(openWorkspace).toHaveBeenCalledWith("D:\\Projects\\DreamCode");

    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: "移除" }));
    expect(screen.getByRole("dialog", { name: "移除 DreamCode?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "移除项目" }));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("D:\\Projects\\DreamCode"));
    expect(screen.queryByRole("button", { name: "项目更多操作" })).not.toBeInTheDocument();
    expect(screen.getByText("尚未添加项目")).toBeVisible();
  });

  it("opens the active workspace and project menu from the task header", async () => {
    const openWorkspace = vi.fn().mockResolvedValue(undefined);
    const saveProject = vi.fn().mockResolvedValue(bootstrap);
    render(<App api={fakeDesktopApi({ bootstrap, openWorkspace, saveProject })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(screen.getByRole("button", { name: "在资源管理器中打开：DreamCode" }));
    expect(openWorkspace).toHaveBeenCalledWith("D:\\Projects\\DreamCode");

    fireEvent.click(screen.getByRole("button", { name: "当前项目更多操作" }));
    expect(await screen.findByRole("menu", { name: "DreamCode 项目操作" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶项目" }));
    expect(saveProject).toHaveBeenCalledWith({
      workspaceRoot: "D:\\Projects\\DreamCode",
      name: "DreamCode",
      pinned: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "当前项目更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑项目" }));
    expect(await screen.findByRole("textbox", { name: "项目名称" })).toHaveValue("DreamCode");
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
      profileId: "work",
      model: "gpt-5.6",
    });
  });

  it("selects a model from the current provider without switching profiles", async () => {
    const startTurn = vi.fn().mockResolvedValue({ runId: "run_model" });
    render(<App api={fakeDesktopApi({ bootstrap, startTurn })} />);

    await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "gpt-5.5" } });
    fireEvent.change(screen.getByRole("textbox", { name: "给 DreamCode 发送消息" }), {
      target: { value: "Use the selected model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "work", model: "gpt-5.5" }),
      ),
    );
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

  it("continues the selected Session instead of creating a new one", async () => {
    const startTurn = vi.fn().mockResolvedValue({ runId: "run_resume" });
    const readSession = vi
      .fn()
      .mockResolvedValue(replayedSession("sess_1", "D:\\Projects\\DreamCode"));
    render(<App api={fakeDesktopApi({ bootstrap, readSession, startTurn })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(screen.getByRole("button", { name: "Desktop shell" }));
    await waitFor(() => expect(readSession).toHaveBeenCalledWith("sess_1"));
    const prompt = screen.getByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Continue this Session" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess_1", prompt: "Continue this Session" }),
      ),
    );
  });

  it("renders the complete stored conversation when a Session is opened", async () => {
    const firstUser = agentEvent("user.message", { content: "First stored question" });
    const firstAnswer = agentEvent("model.delta", { text: "First stored answer" });
    const secondUser = {
      ...agentEvent("user.message", { content: "Second stored question" }),
      turnId: "turn_2",
    };
    const secondAnswer = {
      ...agentEvent("model.delta", { text: "Second stored answer" }),
      turnId: "turn_2",
    };
    const readSession = vi.fn().mockResolvedValue({
      ...replayedSession("sess_1", "D:\\Projects\\DreamCode"),
      events: [firstUser, firstAnswer, secondUser, secondAnswer],
    });
    render(<App api={fakeDesktopApi({ bootstrap, readSession })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(screen.getByRole("button", { name: "Desktop shell" }));

    expect(await screen.findByText("First stored question")).toBeVisible();
    expect(screen.getByText("First stored answer")).toBeVisible();
    expect(screen.getByText("Second stored question")).toBeVisible();
    expect(screen.getByText("Second stored answer")).toBeVisible();
  });

  it("keeps workspace and session navigation disabled while a run is active", async () => {
    render(<App api={fakeDesktopApi({ bootstrap })} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Keep this run attached" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "停止" });

    expect(screen.getByRole("button", { name: "在资源管理器中打开：DreamCode" })).toBeEnabled();
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
          bootstrap: { ...bootstrap, currentProfileId: "removed" },
          startTurn,
        })}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    fireEvent.change(prompt, { target: { value: "Use a real profile" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ profileId: "work" })),
    );
  });

  it("disables sending when the selected profile has no configured API key", async () => {
    render(
      <App
        api={fakeDesktopApi({
          bootstrap: {
            ...bootstrap,
            profiles: [{ ...bootstrap.profiles[0]!, credentialAvailable: false }],
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

  it("gives each run mode its semantic color and icon", async () => {
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
    expect(screen.getByRole("button", { name: "运行模式选项" }).parentElement).toHaveAttribute(
      "data-accent",
      "yolo",
    );
    expect(screen.getByTestId("run-mode-icon")).toHaveAttribute("data-lucide", "zap");
    fireEvent.change(screen.getByLabelText("运行模式"), { target: { value: "plan" } });
    expect(screen.getByRole("button", { name: "运行模式选项" }).parentElement).toHaveAttribute(
      "data-accent",
      "plan",
    );
    expect(screen.getByTestId("run-mode-icon")).toHaveAttribute("data-lucide", "clipboard-list");
    fireEvent.change(screen.getByLabelText("运行模式"), { target: { value: "full" } });
    expect(screen.getByRole("button", { name: "运行模式选项" }).parentElement).toHaveAttribute(
      "data-accent",
      "full",
    );
    expect(screen.getByTestId("run-mode-icon")).toHaveAttribute("data-lucide", "shield-alert");
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
    const bootstrapWithNextWorkspace = {
      ...bootstrap,
      projects: [
        ...(bootstrap.projects ?? []),
        {
          workspaceRoot: "D:\\Projects\\NextWorkspace",
          name: "NextWorkspace",
          createdAt: "2026-08-11T00:00:00.000Z",
        },
      ],
    };
    render(
      <App
        api={fakeDesktopApi({
          bootstrap: bootstrapWithNextWorkspace,
          readSession: vi.fn(() => pending.promise),
        })}
      />,
    );

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(await screen.findByRole("button", { name: "Desktop shell" }));
    fireEvent.click(screen.getByRole("button", { name: "在 NextWorkspace 中新对话" }));
    await act(async () => {
      pending.resolve(replayedSession("sess_1", "D:\\Projects\\DreamCode"));
      await pending.promise;
    });

    expect(screen.getAllByText("NextWorkspace")[0]).toBeVisible();
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
      id: "fake",
      alias: "fake",
      provider: "fake",
      credentialSource: "none" as const,
      credentialAvailable: false,
    };
    render(
      <App
        api={fakeDesktopApi({
          bootstrap: { ...bootstrap, profiles: [fakeProfile], currentProfileId: "fake" },
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
            profiles: [{ ...bootstrap.profiles[0]!, credentialAvailable: false }],
          },
        })}
      />,
    );

    expect(await screen.findByText("先配置模型，再开始对话")).toBeVisible();
    expect(screen.getByRole("button", { name: "打开模型与配置" })).toBeVisible();
  });

  it("auto-follows streaming only while the reader remains near the bottom", async () => {
    let deliverRunEvent: ((message: DesktopRunEvent) => void) | undefined;
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
    expect(scroll.scrollTop).toBe(1000);

    setScrollMetrics(scroll, { scrollHeight: 1400, clientHeight: 600, scrollTop: 100 });
    fireEvent.scroll(scroll);
    deliverRunEvent?.({
      runId: "run_scroll",
      event: agentEvent("model.delta", { text: " without jumping" }),
    });
    await screen.findByText("Following without jumping");
    expect(scroll.scrollTop).toBe(100);
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

  it("keeps the persisted session title while replaying its session-created event", async () => {
    const replay = replayedSession("sess_1", bootstrap.sessions[0]!.workspaceRoot);
    replay.events = [
      agentEvent("session.created", {
        session: {
          id: "sess_1",
          workspaceRoot: bootstrap.sessions[0]!.workspaceRoot,
          sessionDir: "D:\\sessions\\sess_1",
          createdAt: "2026-08-10T00:00:00.000Z",
        },
      }),
    ];
    render(
      <App api={fakeDesktopApi({ bootstrap, readSession: vi.fn().mockResolvedValue(replay) })} />,
    );

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(await screen.findByRole("button", { name: "Desktop shell" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Desktop shell" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Desktop shell" })).toHaveAttribute(
      "aria-current",
      "page",
    );
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
    expect(screen.getByRole("dialog", { name: "底部面板" })).toBeVisible();
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

  it("toggles the project terminal with Ctrl+backtick", async () => {
    render(<App api={fakeDesktopApi({ bootstrap })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "底部面板" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "终端" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "底部面板" })).not.toBeInTheDocument();
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

  it("opens model configuration from settings and applies the saved bootstrap", async () => {
    const updated = {
      ...bootstrap,
      profiles: [{ ...bootstrap.profiles[0]!, model: "gpt-new" }],
    };
    const updateProfile = vi.fn().mockResolvedValue(updated);
    render(<App api={fakeDesktopApi({ bootstrap, updateProfile })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("main", { name: "设置" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "__custom__" } });
    fireEvent.change(screen.getByLabelText("自定义模型 ID"), {
      target: { value: "gpt-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(screen.getByRole("main", { name: "设置" })).toBeVisible();
    expect(screen.getByLabelText("自定义模型 ID")).toHaveValue("gpt-new");
  });

  it("applies the profile selected in settings to the next run", async () => {
    const startTurn = vi.fn().mockResolvedValue({ runId: "run_applied_profile" });
    const deepseekProfile = {
      id: "deepseek-personal",
      alias: "personal",
      provider: "deepseek",
      model: "deepseek-chat",
      credentialSource: "inline" as const,
      credentialAvailable: true,
    };
    const withTwoProfiles: DesktopBootstrap = {
      ...bootstrap,
      profiles: [...bootstrap.profiles, deepseekProfile],
      presets: [
        ...bootstrap.presets,
        {
          id: "deepseek",
          displayName: "DeepSeek",
          defaultModel: "deepseek-chat",
          models: [{ id: "deepseek-chat", label: "DeepSeek Chat" }],
        },
      ],
    };
    render(<App api={fakeDesktopApi({ bootstrap: withTwoProfiles, startTurn })} />);

    await screen.findByRole("heading", { level: 2, name: "新对话" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek · personal/ }));
    fireEvent.click(screen.getByRole("button", { name: "返回应用" }));

    expect(screen.getByLabelText("模型")).toHaveValue("deepseek-chat");
    fireEvent.change(screen.getByRole("textbox", { name: "给 DreamCode 发送消息" }), {
      target: { value: "Use the applied profile" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "deepseek-personal",
          model: "deepseek-chat",
        }),
      ),
    );
  });

  it("submits with Enter, keeps Shift+Enter for a newline, and blocks an invalid prompt", async () => {
    const startTurn = vi.fn().mockResolvedValue({ runId: "run_1" });
    render(<App api={fakeDesktopApi({ bootstrap, startTurn })} />);

    const prompt = await screen.findByRole("textbox", { name: "给 DreamCode 发送消息" });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    fireEvent.change(prompt, { target: { value: "  Review this code  " } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter", shiftKey: true });
    expect(startTurn).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

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
          bootstrap: { ...bootstrap, profiles: [], currentProfileId: undefined },
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
    openWorkspace: vi.fn().mockResolvedValue(undefined),
    createProfile: vi.fn().mockResolvedValue(bootstrapValue),
    updateProfile: vi.fn().mockResolvedValue(bootstrapValue),
    deleteProfile: vi.fn().mockResolvedValue(bootstrapValue),
    setDefaultProfile: vi.fn().mockResolvedValue(bootstrapValue),
    testProfile: vi.fn().mockResolvedValue({ ok: true, message: "连接测试成功。" }),
    updateWebSearchCredential: vi.fn().mockResolvedValue(bootstrapValue),
    saveProject: vi.fn().mockResolvedValue(bootstrapValue),
    createProject: vi
      .fn()
      .mockResolvedValue({ bootstrap: bootstrapValue, workspaceRoot: "D:\\Projects\\New" }),
    deleteProject: vi.fn().mockResolvedValue(bootstrapValue),
    deleteSession: vi.fn().mockResolvedValue(bootstrapValue),
    renameSession: vi.fn().mockResolvedValue(bootstrapValue),
    setSessionPinned: vi.fn().mockResolvedValue(bootstrapValue),
    startTurn: vi.fn().mockResolvedValue({ runId: "run_1" }),
    stopTurn: vi.fn().mockResolvedValue(undefined),
    startTerminal: vi.fn().mockResolvedValue({ terminalId: "terminal_test" }),
    writeTerminal: vi.fn().mockResolvedValue(undefined),
    resizeTerminal: vi.fn().mockResolvedValue(undefined),
    closeTerminal: vi.fn().mockResolvedValue(undefined),
    readSession: vi.fn(),
    readDiff: vi.fn(),
    rollback: vi.fn(),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    respondQuestion: vi.fn().mockResolvedValue(undefined),
    onRunEvent: vi.fn().mockReturnValue(() => undefined),
    onApprovalRequest: vi.fn().mockReturnValue(() => undefined),
    onQuestionRequest: vi.fn().mockReturnValue(() => undefined),
    onRunStatus: vi.fn().mockReturnValue(() => undefined),
    onTerminalOutput: vi.fn().mockReturnValue(() => undefined),
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

function replayedSession(id: string, workspaceRoot: string): DesktopSessionDetail {
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
