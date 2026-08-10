import { contextBridge, ipcRenderer } from "electron";
import type {
  ApprovalResponse,
  DesktopApi,
  DesktopBootstrap,
  DesktopRunStatus,
  QuestionResponse,
  RollbackRequest,
  SaveProfileRequest,
  StartTurnRequest,
} from "../shared/contracts";

interface IpcRendererLike {
  invoke(channel: string, ...arguments_: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, message: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, message: unknown) => void): void;
}

export function createDesktopApi(renderer: IpcRendererLike): DesktopApi {
  return {
    bootstrap: () => invoke<DesktopBootstrap>(renderer, "desktop:bootstrap"),
    chooseWorkspace: () => invoke<string | undefined>(renderer, "desktop:choose-workspace"),
    saveProfile: (request: SaveProfileRequest) =>
      invoke<DesktopBootstrap>(renderer, "desktop:save-profile", request),
    startTurn: (request: StartTurnRequest) =>
      invoke<{ runId: string }>(renderer, "desktop:start-turn", request),
    stopTurn: (runId: string) => invoke<void>(renderer, "desktop:stop-turn", runId),
    readSession: (sessionId: string) => invoke(renderer, "desktop:read-session", sessionId),
    readDiff: (request: RollbackRequest) => invoke<string>(renderer, "desktop:read-diff", request),
    rollback: (request: RollbackRequest) => invoke(renderer, "desktop:rollback", request),
    respondApproval: (response: ApprovalResponse) =>
      invoke<void>(renderer, "desktop:approval-response", response),
    respondQuestion: (response: QuestionResponse) =>
      invoke<void>(renderer, "desktop:question-response", response),
    onRunEvent: (listener) => subscribe(renderer, "desktop:run-event", listener),
    onApprovalRequest: (listener) => subscribe(renderer, "desktop:approval-request", listener),
    onQuestionRequest: (listener) => subscribe(renderer, "desktop:question-request", listener),
    onRunStatus: (listener) =>
      subscribe<DesktopRunStatus>(renderer, "desktop:run-status", listener),
  } satisfies DesktopApi;
}

function invoke<T>(
  renderer: IpcRendererLike,
  channel: string,
  ...arguments_: unknown[]
): Promise<T> {
  return renderer.invoke(channel, ...arguments_) as Promise<T>;
}

function subscribe<T>(
  renderer: IpcRendererLike,
  channel: string,
  listener: (message: T) => void,
): () => void {
  const wrapped = (_event: unknown, message: unknown) => listener(message as T);
  renderer.on(channel, wrapped);
  return () => renderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("dreamcode", createDesktopApi(ipcRenderer));
