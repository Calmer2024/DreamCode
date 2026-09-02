import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessSupervisor } from "@dreamcode/tools";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { DesktopAppService } from "./app-service";
import { registerDesktopIpc } from "./ipc";
import { DesktopRunManager } from "./run-manager";
import { DesktopTerminalManager } from "./terminal-manager";
import { type BrowserWindowConstructor, createMainWindow, type DesktopWindow } from "./window";

interface CloseRunManager {
  readonly activeRunId: string | undefined;
  stop(runId: string): Promise<void>;
}

interface CloseDialog {
  showMessageBox(
    window: unknown,
    options: {
      type: "warning";
      title: string;
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
      noLink: boolean;
    },
  ): Promise<{ response: number }>;
}

export function createActiveRunCloseConfirmation(input: {
  runManager: CloseRunManager;
  dialog: CloseDialog;
}): (window: unknown) => Promise<boolean> {
  return async (window) => {
    const runId = input.runManager.activeRunId;
    if (!runId) {
      return true;
    }
    const result = await input.dialog.showMessageBox(window, {
      type: "warning",
      title: "停止当前任务？",
      message: "当前任务仍在运行。",
      detail: "关闭窗口将停止当前任务，并等待运行记录完成保存。",
      buttons: ["停止并关闭", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) {
      return false;
    }
    await input.runManager.stop(runId);
    return true;
  };
}

interface ApplicationLifecycleInput {
  app: {
    on(event: string, listener: (...arguments_: never[]) => unknown): void;
    quit(): void;
  };
  platform: NodeJS.Platform;
  getWindow(): DesktopWindow | undefined;
  createWindow(): unknown;
  dispose(): Promise<void> | void;
}

interface QuitEvent {
  preventDefault(): void;
}

export function registerApplicationLifecycle(input: ApplicationLifecycleInput): void {
  let disposalStarted = false;
  let disposalComplete = false;
  input.app.on("activate", async () => {
    const window = input.getWindow();
    if (!window || window.isDestroyed()) {
      await input.createWindow();
    }
  });
  input.app.on("window-all-closed", () => {
    if (input.platform !== "darwin") {
      input.app.quit();
    }
  });
  input.app.on("will-quit", (event: QuitEvent) => {
    if (disposalComplete) {
      return;
    }
    event.preventDefault();
    if (disposalStarted) {
      return;
    }
    disposalStarted = true;
    void Promise.resolve()
      .then(() => input.dispose())
      .catch(() => undefined)
      .finally(() => {
        disposalComplete = true;
        input.app.quit();
      });
  });
}

export async function startDesktopApplication(): Promise<void> {
  await app.whenReady();

  let mainWindow: DesktopWindow | undefined;
  const processSupervisor = new ProcessSupervisor();
  const service = new DesktopAppService(undefined, undefined, processSupervisor);
  const send = (channel: string, payload: unknown) => {
    const window = mainWindow;
    if (window && !window.isDestroyed()) {
      window.webContents.send?.(channel, payload);
    }
  };
  const runManager = new DesktopRunManager({
    processSupervisor,
    getSkillRegistry: (workspaceRoot) => service.skills.registryFor(workspaceRoot),
    emitEvent: (message) => send("desktop:run-event", message),
    emitApproval: (request) => send("desktop:approval-request", request),
    emitQuestion: (request) => send("desktop:question-request", request),
    emitStatus: (status) => send("desktop:run-status", status),
  });
  const terminalManager = new DesktopTerminalManager();
  const disposeIpc = registerDesktopIpc({
    ipcMain,
    dialog,
    service,
    runManager,
    terminalManager,
    getWindow: () => mainWindow,
    openWorkspace: async (workspaceRoot) => {
      const error = await shell.openPath(workspaceRoot);
      if (error) throw new Error(error);
    },
    chooseWorkspace:
      process.env.DREAMCODE_E2E === "1" && process.env.DREAMCODE_E2E_WORKSPACE?.trim()
        ? async () => process.env.DREAMCODE_E2E_WORKSPACE?.trim()
        : undefined,
  });
  const confirmClose = createActiveRunCloseConfirmation({ runManager, dialog });
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

  const openWindow = () => {
    const window = createMainWindow({
      BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
      shell,
      preloadPath: path.join(moduleDirectory, "../preload/index.cjs"),
      rendererIndexPath: path.join(moduleDirectory, "../../dist-renderer/index.html"),
      rendererUrl: app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL,
      confirmClose,
    });
    mainWindow = window;
    window.on("closed", () => {
      if (mainWindow === window) {
        mainWindow = undefined;
      }
    });
    return window;
  };

  openWindow();
  registerApplicationLifecycle({
    app,
    platform: process.platform,
    getWindow: () => mainWindow,
    createWindow: openWindow,
    dispose: async () => {
      disposeIpc();
      terminalManager.dispose();
      await runManager.dispose();
      service.skills.close();
    },
  });
}

if (!process.env.VITEST) {
  void startDesktopApplication().catch(() => {
    console.error("DreamCode desktop failed to start.");
    app.quit();
  });
}
