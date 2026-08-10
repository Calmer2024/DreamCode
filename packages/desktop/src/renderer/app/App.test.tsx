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

    expect(await screen.findByText("新对话")).toBeVisible();
    expect(screen.getByText("会话历史")).toBeVisible();
    expect(screen.getByText("模型与配置")).toBeVisible();
    expect(screen.queryByText("拉取请求")).not.toBeInTheDocument();
    expect(screen.getByTestId("model-config-icon")).toHaveAttribute("data-lucide", "bot");
    expect(screen.getByTestId("run-mode-icon")).toHaveAttribute("data-lucide", "shield-check");
    expect(screen.queryByRole("button", { name: "添加附件" })).not.toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: "DreamCode" })).toBeDisabled();
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

    await screen.findByText("新对话");
    fireEvent.click(screen.getByRole("button", { name: "Desktop shell" }));
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

    await screen.findByText("新对话");
    fireEvent.click(screen.getByRole("button", { name: "Desktop shell" }));
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
