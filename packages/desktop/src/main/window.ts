export interface BrowserWindowOptionsLike {
  autoHideMenuBar: boolean;
  useContentSize: boolean;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  backgroundColor: string;
  show: boolean;
  webPreferences: {
    preload: string;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
  };
}

interface WindowEvent {
  preventDefault(): void;
}

export interface DesktopWindow {
  webContents: {
    on(event: string, listener: (...arguments_: never[]) => void): void;
    setWindowOpenHandler(listener: (details: { url: string }) => { action: "deny" }): void;
    send?(channel: string, payload: unknown): void;
  };
  once(event: string, listener: (...arguments_: never[]) => void): void;
  on(event: string, listener: (...arguments_: never[]) => void): void;
  loadURL(url: string): unknown;
  loadFile(filePath: string): unknown;
  show(): void;
  reload(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export type BrowserWindowConstructor = new (options: BrowserWindowOptionsLike) => DesktopWindow;

export interface CreateMainWindowInput {
  BrowserWindow: BrowserWindowConstructor;
  shell: { openExternal(url: string): Promise<unknown> };
  preloadPath: string;
  rendererIndexPath: string;
  rendererUrl?: string;
  confirmClose?: (window: DesktopWindow) => Promise<boolean>;
}

export function createMainWindow(input: CreateMainWindowInput): DesktopWindow {
  const window = new input.BrowserWindow({
    autoHideMenuBar: true,
    useContentSize: true,
    title: "DreamCode",
    width: 1280,
    height: 800,
    // Keep the sidebar, header, composer and footer controls visible at all times.
    minWidth: 1100,
    minHeight: 780,
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  installNavigationPolicy(window, input.shell);
  installRendererRecovery(window);
  if (input.confirmClose) {
    installCloseConfirmation(window, input.confirmClose);
  }

  if (input.rendererUrl) {
    void window.loadURL(input.rendererUrl);
  } else {
    void window.loadFile(input.rendererIndexPath);
  }
  return window;
}

function installNavigationPolicy(
  window: DesktopWindow,
  shell: CreateMainWindowInput["shell"],
): void {
  const openExternal = (url: string) => {
    if (!isSafeExternalUrl(url)) {
      return;
    }
    void shell.openExternal(url).catch(() => undefined);
  };

  window.webContents.on("will-navigate", (event: WindowEvent, url: string) => {
    event.preventDefault();
    openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
}

function installRendererRecovery(window: DesktopWindow): void {
  window.webContents.on("render-process-gone", () => {
    if (!window.isDestroyed()) {
      window.reload();
    }
  });
}

function installCloseConfirmation(
  window: DesktopWindow,
  confirmClose: NonNullable<CreateMainWindowInput["confirmClose"]>,
): void {
  let closePending = false;
  let destructionApproved = false;

  window.on("close", (event: WindowEvent) => {
    if (destructionApproved) {
      return;
    }
    event.preventDefault();
    if (closePending) {
      return;
    }
    closePending = true;
    void confirmClose(window)
      .then((confirmed) => {
        if (confirmed && !window.isDestroyed()) {
          destructionApproved = true;
          window.destroy();
        }
      })
      .finally(() => {
        closePending = false;
      });
  });
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
