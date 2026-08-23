import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

vi.mock("electron", () => electron);

import { createDesktopApi } from "../preload";
import { registerDesktopIpc } from "./ipc";

describe("registerDesktopIpc", () => {
  it("registers only declared channels and removes handlers during disposal", () => {
    const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
    const dialog = { showOpenDialog: vi.fn() };
    const service = {
      bootstrap: vi.fn(),
      createProject: vi.fn(),
      createProfile: vi.fn(),
      updateProfile: vi.fn(),
      deleteProfile: vi.fn(),
      setDefaultProfile: vi.fn(),
      testProfile: vi.fn(),
      updateWebSearchCredential: vi.fn(),
      saveProject: vi.fn(),
      deleteProject: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      setSessionPinned: vi.fn(),
      readSession: vi.fn(),
      readChangedFileDiff: vi.fn(),
      rollback: vi.fn(),
    };
    const runManager = {
      start: vi.fn(),
      stop: vi.fn(),
      respondApproval: vi.fn(),
      respondQuestion: vi.fn(),
    };
    const terminalManager = {
      start: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    };

    const dispose = registerDesktopIpc({
      ipcMain,
      dialog,
      service,
      runManager,
      terminalManager,
      getWindow: () => undefined,
      openWorkspace: vi.fn(),
    });

    expect(ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop:bootstrap",
      "desktop:choose-workspace",
      "desktop:open-workspace",
      "desktop:create-profile",
      "desktop:update-profile",
      "desktop:delete-profile",
      "desktop:set-default-profile",
      "desktop:test-profile",
      "desktop:update-web-search-credential",
      "desktop:save-project",
      "desktop:create-project",
      "desktop:delete-project",
      "desktop:delete-session",
      "desktop:rename-session",
      "desktop:set-session-pinned",
      "desktop:read-session",
      "desktop:read-diff",
      "desktop:rollback",
      "desktop:start-turn",
      "desktop:stop-turn",
      "desktop:approval-response",
      "desktop:question-response",
      "desktop:terminal-start",
      "desktop:terminal-write",
      "desktop:terminal-resize",
      "desktop:terminal-close",
    ]);

    dispose();

    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(26);
  });

  it("serializes invalid object requests before calling a service", async () => {
    const { handlers, register, runManager, service } = createIpcFixture();
    register();

    const invalidRequests = [
      ["desktop:create-profile", { alias: "", provider: "openai" }],
      ["desktop:save-project", { workspaceRoot: "", name: "Project" }],
      ["desktop:delete-project", ""],
      ["desktop:delete-session", ""],
      ["desktop:rename-session", { sessionId: "sess_1", title: "" }],
      ["desktop:set-session-pinned", { sessionId: "", pinned: true }],
      ["desktop:open-workspace", ""],
      ["desktop:read-diff", { sessionId: "", filePath: "src/index.ts" }],
      ["desktop:rollback", { sessionId: "", filePath: "src/index.ts" }],
      ["desktop:start-turn", { prompt: "", workspaceRoot: "D:/repo", mode: "yolo" }],
      ["desktop:approval-response", { runId: "", requestId: "request", approved: true }],
      ["desktop:question-response", { runId: "run", requestId: "", answer: "yes" }],
    ] as const;

    for (const [channel, request] of invalidRequests) {
      await expect(handlers.get(channel)?.({}, request)).resolves.toEqual({
        ok: false,
        error: {
          code: "invalid_request",
          message: "Request is invalid.",
          recoverable: true,
        },
      });
    }

    expect(service.createProfile).not.toHaveBeenCalled();
    expect(service.readChangedFileDiff).not.toHaveBeenCalled();
    expect(service.rollback).not.toHaveBeenCalled();
    expect(runManager.start).not.toHaveBeenCalled();
    expect(runManager.respondApproval).not.toHaveBeenCalled();
    expect(runManager.respondQuestion).not.toHaveBeenCalled();
  });

  it("serializes successful handler results", async () => {
    const { handlers, register, service } = createIpcFixture();
    service.bootstrap.mockResolvedValueOnce({ profiles: [], presets: [], sessions: [] });
    register();

    await expect(handlers.get("desktop:bootstrap")?.({})).resolves.toEqual({
      ok: true,
      value: { profiles: [], presets: [], sessions: [] },
    });
  });

  it("uses an injected workspace chooser without opening a native dialog", async () => {
    const chooseWorkspace = vi.fn().mockResolvedValue("D:/isolated-fixture");
    const { dialog, handlers, register } = createIpcFixture({ chooseWorkspace });
    register();

    await expect(handlers.get("desktop:choose-workspace")?.({})).resolves.toEqual({
      ok: true,
      value: "D:/isolated-fixture",
    });
    expect(chooseWorkspace).toHaveBeenCalledOnce();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it("serializes sanitized structured errors from handlers", async () => {
    const { handlers, register, service } = createIpcFixture();
    service.createProfile.mockRejectedValueOnce(
      Object.assign(new Error("Configuration contains private-token."), { stack: "private stack" }),
    );
    register();

    const response = await handlers.get("desktop:create-profile")?.(
      {},
      {
        alias: "personal",
        provider: "openai",
        model: "gpt-5.5",
        credential: { mode: "clear" },
      },
    );

    expect(response).toEqual({
      ok: false,
      error: { code: "internal_error", message: "Request failed.", recoverable: true },
    });
    expect(JSON.stringify(response)).not.toContain("private-token");
    expect(JSON.stringify(response)).not.toContain("private stack");
  });

  it("does not serialize secret messages from structurally matching errors", async () => {
    const secret = "secret-in-structured-error";
    const { handlers, register, service } = createIpcFixture();
    service.createProfile.mockRejectedValueOnce({
      code: "stale_run",
      message: secret,
      recoverable: true,
    });
    register();

    const response = await handlers.get("desktop:create-profile")?.(
      {},
      {
        alias: "personal",
        provider: "openai",
        model: "gpt-5.5",
        credential: { mode: "clear" },
      },
    );

    expect(response).toEqual({
      ok: false,
      error: { code: "stale_run", message: "Run is no longer active.", recoverable: true },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
  });
});

describe("createDesktopApi", () => {
  it("exposes only the declared methods and removes exact event listeners", async () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createDesktopApi(ipcRenderer);
    const listener = vi.fn();

    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "dreamcode",
      expect.any(Object),
    );

    expect(Object.keys(api).sort()).toEqual([
      "bootstrap",
      "chooseWorkspace",
      "closeTerminal",
      "createProfile",
      "createProject",
      "deleteProfile",
      "deleteProject",
      "deleteSession",
      "onApprovalRequest",
      "onQuestionRequest",
      "onRunEvent",
      "onRunStatus",
      "onTerminalOutput",
      "openWorkspace",
      "readDiff",
      "readSession",
      "renameSession",
      "resizeTerminal",
      "respondApproval",
      "respondQuestion",
      "rollback",
      "saveProject",
      "setDefaultProfile",
      "setSessionPinned",
      "startTerminal",
      "startTurn",
      "stopTurn",
      "testProfile",
      "updateProfile",
      "updateWebSearchCredential",
      "writeTerminal",
    ]);

    api.onRunEvent(listener)();
    const registration = ipcRenderer.on.mock.calls[0];
    expect(registration).toBeDefined();
    const wrapped = registration?.[1] as (event: unknown, message: unknown) => void;
    wrapped({}, { runId: "run_1", event: { type: "turn.completed", payload: {} } });

    expect(listener).toHaveBeenCalledWith({
      runId: "run_1",
      event: { type: "turn.completed", payload: {} },
    });
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith("desktop:run-event", wrapped);

    ipcRenderer.invoke.mockResolvedValue({ ok: true, value: { runId: "run_1" } });

    await expect(
      api.startTurn({ prompt: "Inspect", workspaceRoot: "D:/repo", mode: "yolo" }),
    ).resolves.toEqual({ runId: "run_1" });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("desktop:start-turn", {
      prompt: "Inspect",
      workspaceRoot: "D:/repo",
      mode: "yolo",
    });
  });

  it("unwraps serialized failures without exposing secret messages", async () => {
    const secret = "secret-in-main-error-envelope";
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "stale_run", message: secret, recoverable: true },
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createDesktopApi(ipcRenderer);

    const error = await api.stopTurn("run_1").catch((reason: unknown) => reason);

    expect(error).toEqual({
      code: "stale_run",
      message: "Run is no longer active.",
      recoverable: true,
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("routes every invoke method through the response unwrapping boundary", async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createDesktopApi(ipcRenderer);

    await Promise.all([
      api.bootstrap(),
      api.chooseWorkspace(),
      api.openWorkspace("D:/repo"),
      api.createProfile({
        alias: "personal",
        provider: "openai",
        model: "gpt-5.5",
        credential: { mode: "clear" },
      }),
      api.saveProject({ workspaceRoot: "D:/repo", name: "repo" }),
      api.deleteProject("D:/repo"),
      api.deleteSession("sess_1"),
      api.renameSession({ sessionId: "sess_1", title: "Renamed conversation" }),
      api.setSessionPinned({ sessionId: "sess_1", pinned: true }),
      api.startTurn({ prompt: "Inspect", workspaceRoot: "D:/repo", mode: "yolo" }),
      api.stopTurn("run_1"),
      api.readSession("sess_1"),
      api.readDiff({ sessionId: "sess_1", filePath: "src/index.ts" }),
      api.rollback({ sessionId: "sess_1", filePath: "src/index.ts" }),
      api.resizeTerminal("terminal_1", 120, 40),
      api.respondApproval({ runId: "run_1", requestId: "approval_1", approved: true }),
      api.respondQuestion({ runId: "run_1", requestId: "question_1", answer: "yes" }),
    ]);

    expect(ipcRenderer.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop:bootstrap",
      "desktop:choose-workspace",
      "desktop:open-workspace",
      "desktop:create-profile",
      "desktop:save-project",
      "desktop:delete-project",
      "desktop:delete-session",
      "desktop:rename-session",
      "desktop:set-session-pinned",
      "desktop:start-turn",
      "desktop:stop-turn",
      "desktop:read-session",
      "desktop:read-diff",
      "desktop:rollback",
      "desktop:terminal-resize",
      "desktop:approval-response",
      "desktop:question-response",
    ]);
  });
});

function createIpcFixture(options: { chooseWorkspace?: () => Promise<string | undefined> } = {}) {
  const handlers = new Map<string, (...arguments_: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...arguments_: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  };
  const dialog = { showOpenDialog: vi.fn() };
  const service = {
    bootstrap: vi.fn(),
    createProject: vi.fn(),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    setDefaultProfile: vi.fn(),
    testProfile: vi.fn(),
    saveProject: vi.fn(),
    deleteProject: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    setSessionPinned: vi.fn(),
    readSession: vi.fn(),
    readChangedFileDiff: vi.fn(),
    rollback: vi.fn(),
  };
  const runManager = {
    start: vi.fn(),
    stop: vi.fn(),
    respondApproval: vi.fn(),
    respondQuestion: vi.fn(),
  };
  const terminalManager = {
    start: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  };
  const openWorkspace = vi.fn();

  return {
    dialog,
    handlers,
    service,
    runManager,
    register: () =>
      registerDesktopIpc({
        ipcMain,
        dialog,
        service,
        runManager,
        terminalManager,
        getWindow: () => undefined,
        openWorkspace,
        ...options,
      } as never),
  };
}
