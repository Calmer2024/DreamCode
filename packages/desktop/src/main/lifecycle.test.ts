import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  ipcMain: {},
  shell: {},
}));

import { createActiveRunCloseConfirmation, registerApplicationLifecycle } from "./index";

describe("desktop application lifecycle", () => {
  it("waits for the active run to stop after native confirmation", async () => {
    const stopped = deferred<void>();
    const runManager = {
      activeRunId: "run_1" as string | undefined,
      stop: vi.fn(() => stopped.promise),
    };
    const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) };
    const confirmClose = createActiveRunCloseConfirmation({ runManager, dialog });

    let settled = false;
    const result = confirmClose({}).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(runManager.stop).toHaveBeenCalledWith("run_1");
    expect(settled).toBe(false);
    stopped.resolve();
    await expect(result).resolves.toBe(true);
  });

  it("keeps the window open when active-run closure is canceled", async () => {
    const runManager = { activeRunId: "run_1" as string | undefined, stop: vi.fn() };
    const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) };

    await expect(createActiveRunCloseConfirmation({ runManager, dialog })({})).resolves.toBe(false);
    expect(runManager.stop).not.toHaveBeenCalled();
  });

  it("recreates a missing window and quits on Windows", async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const app = {
      on: vi.fn((event: string, handler: (...arguments_: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
      quit: vi.fn(),
    };
    const createWindow = vi.fn();
    const dispose = vi.fn().mockResolvedValue(undefined);

    registerApplicationLifecycle({
      app,
      platform: "win32",
      getWindow: () => undefined,
      createWindow,
      dispose,
    });

    await handlers.get("activate")?.();
    handlers.get("window-all-closed")?.();
    expect(createWindow).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("prevents shutdown until asynchronous disposal finishes", async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const app = {
      on: vi.fn((event: string, handler: (...arguments_: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
      quit: vi.fn(),
    };
    const disposal = deferred<void>();
    const dispose = vi.fn(() => disposal.promise);
    registerApplicationLifecycle({
      app,
      platform: "win32",
      getWindow: () => undefined,
      createWindow: vi.fn(),
      dispose,
    });

    const firstEvent = { preventDefault: vi.fn() };
    handlers.get("will-quit")?.(firstEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    disposal.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    const resumedEvent = { preventDefault: vi.fn() };
    handlers.get("will-quit")?.(resumedEvent);
    expect(resumedEvent.preventDefault).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
