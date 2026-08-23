import { describe, expect, it, vi } from "vitest";
import { createMainWindow } from "./window";

describe("createMainWindow", () => {
  it("creates a context-isolated sandboxed window and reveals it when ready", () => {
    const fixture = createWindowFixture({ rendererUrl: "http://127.0.0.1:5173" });

    expect(fixture.options).toMatchObject({
      autoHideMenuBar: true,
      title: "DreamCode",
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 620,
      backgroundColor: "#ffffff",
      show: false,
      webPreferences: {
        preload: "D:/app/preload.js",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(fixture.window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:5173");
    fixture.emitWindow("ready-to-show");
    expect(fixture.window.show).toHaveBeenCalledOnce();
  });

  it("loads the packaged Renderer file when no development URL is supplied", () => {
    const fixture = createWindowFixture();

    expect(fixture.window.loadFile).toHaveBeenCalledWith("D:/app/index.html");
    expect(fixture.window.loadURL).not.toHaveBeenCalled();
  });

  it("denies navigation and opens only validated web URLs externally", async () => {
    const fixture = createWindowFixture();
    const navigationEvent = { preventDefault: vi.fn() };

    fixture.emitWebContents("will-navigate", navigationEvent, "https://example.com/review");
    fixture.emitWebContents("will-navigate", navigationEvent, "file:///C:/secret.txt");
    const openHandler = fixture.openHandler();

    expect(openHandler({ url: "http://example.com/docs" })).toEqual({ action: "deny" });
    expect(openHandler({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    await Promise.resolve();

    expect(navigationEvent.preventDefault).toHaveBeenCalledTimes(2);
    expect(fixture.shell.openExternal.mock.calls).toEqual([
      ["https://example.com/review"],
      ["http://example.com/docs"],
    ]);
  });

  it("reloads after an unexpected Renderer exit", () => {
    const fixture = createWindowFixture();

    fixture.emitWebContents("render-process-gone", {}, { reason: "crashed" });

    expect(fixture.window.reload).toHaveBeenCalledOnce();
  });

  it("destroys only after an asynchronous close request is confirmed", async () => {
    const confirmation = deferred<boolean>();
    const fixture = createWindowFixture({ confirmClose: () => confirmation.promise });
    const closeEvent = { preventDefault: vi.fn() };

    fixture.emitWindow("close", closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.window.destroy).not.toHaveBeenCalled();

    confirmation.resolve(true);
    await confirmation.promise;
    await Promise.resolve();

    expect(fixture.window.destroy).toHaveBeenCalledOnce();
  });
});

function createWindowFixture(
  overrides: { rendererUrl?: string; confirmClose?: () => Promise<boolean> } = {},
) {
  let options: Record<string, unknown> = {};
  const windowHandlers = new Map<string, (...arguments_: unknown[]) => void>();
  const webContentsHandlers = new Map<string, (...arguments_: unknown[]) => void>();
  let registeredOpenHandler: ((details: { url: string }) => { action: "deny" }) | undefined;
  const window = {
    webContents: {
      on: vi.fn((event: string, handler: (...arguments_: unknown[]) => void) => {
        webContentsHandlers.set(event, handler);
      }),
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: "deny" }) => {
        registeredOpenHandler = handler;
      }),
    },
    once: vi.fn((event: string, handler: (...arguments_: unknown[]) => void) => {
      windowHandlers.set(event, handler);
    }),
    on: vi.fn((event: string, handler: (...arguments_: unknown[]) => void) => {
      windowHandlers.set(event, handler);
    }),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    show: vi.fn(),
    reload: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
  const BrowserWindow = function BrowserWindow(input: Record<string, unknown>) {
    options = input;
    return window;
  } as never;
  const shell = { openExternal: vi.fn().mockResolvedValue(undefined) };

  createMainWindow({
    BrowserWindow,
    shell,
    preloadPath: "D:/app/preload.js",
    rendererIndexPath: "D:/app/index.html",
    ...overrides,
  });

  return {
    options,
    window,
    shell,
    emitWindow(event: string, ...arguments_: unknown[]) {
      windowHandlers.get(event)?.(...arguments_);
    },
    emitWebContents(event: string, ...arguments_: unknown[]) {
      webContentsHandlers.get(event)?.(...arguments_);
    },
    openHandler() {
      if (!registeredOpenHandler) throw new Error("Open handler was not registered.");
      return registeredOpenHandler;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
