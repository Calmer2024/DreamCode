import { contextBridge, ipcRenderer } from "electron";
import type {
  ApprovalResponse,
  DesktopApi,
  DesktopBootstrap,
  DesktopIpcResponse,
  DesktopRunStatus,
  QuestionResponse,
  RollbackRequest,
  SaveProfileRequest,
  StartTurnRequest,
} from "../shared/contracts";
import { sanitizeDesktopError } from "../shared/contracts";

interface IpcRendererLike {
  invoke(channel: string, ...arguments_: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, message: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, message: unknown) => void): void;
}

export function createDesktopApi(renderer: IpcRendererLike): DesktopApi {
  return {
    bootstrap: () => invoke<DesktopBootstrap>(renderer, "desktop:bootstrap"),
    chooseWorkspace: () => invoke<string | undefined>(renderer, "desktop:choose-workspace"),
    openWorkspace: (workspaceRoot: string) =>
      invoke<void>(renderer, "desktop:open-workspace", workspaceRoot),
    saveProfile: (request: SaveProfileRequest) =>
      invoke<DesktopBootstrap>(renderer, "desktop:save-profile", request),
    saveProject: (request) => invoke<DesktopBootstrap>(renderer, "desktop:save-project", request),
    deleteProject: (workspaceRoot) =>
      invoke<DesktopBootstrap>(renderer, "desktop:delete-project", workspaceRoot),
    deleteSession: (sessionId) =>
      invoke<DesktopBootstrap>(renderer, "desktop:delete-session", sessionId),
    setSessionPinned: (request) =>
      invoke<DesktopBootstrap>(renderer, "desktop:set-session-pinned", request),
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
  return renderer.invoke(channel, ...arguments_).then((response) => unwrapResponse<T>(response));
}

function unwrapResponse<T>(response: unknown): T {
  if (isSuccessfulResponse(response)) {
    return response.value as T;
  }
  if (isFailedResponse(response)) {
    throw sanitizeDesktopError(response.error);
  }
  throw sanitizeDesktopError(undefined);
}

function isSuccessfulResponse(
  response: unknown,
): response is DesktopIpcResponse<unknown> & { ok: true } {
  return Boolean(
    response && typeof response === "object" && "ok" in response && response.ok === true,
  );
}

function isFailedResponse(
  response: unknown,
): response is DesktopIpcResponse<unknown> & { ok: false } {
  return Boolean(
    response &&
      typeof response === "object" &&
      "ok" in response &&
      response.ok === false &&
      "error" in response,
  );
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
