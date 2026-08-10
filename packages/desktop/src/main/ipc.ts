import type { z } from "zod";
import {
  approvalResponseSchema,
  type DesktopError,
  type DesktopIpcResponse,
  questionResponseSchema,
  rollbackRequestSchema,
  runIdSchema,
  sanitizeDesktopError,
  saveProfileRequestSchema,
  sessionIdSchema,
  startTurnRequestSchema,
} from "../shared/contracts";
import type { DesktopAppService } from "./app-service";
import type { DesktopRunManager } from "./run-manager";

type IpcHandler = (...arguments_: unknown[]) => Promise<DesktopIpcResponse<unknown>>;

interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
}

interface DialogLike {
  showOpenDialog(
    window: unknown,
    options: { properties: Array<"openDirectory" | "createDirectory"> },
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface DesktopIpcDependencies {
  ipcMain: IpcMainLike;
  dialog: DialogLike;
  service: Pick<
    DesktopAppService,
    "bootstrap" | "saveProfile" | "readSession" | "readChangedFileDiff" | "rollback"
  >;
  runManager: Pick<DesktopRunManager, "start" | "stop" | "respondApproval" | "respondQuestion">;
  getWindow: () => unknown;
}

const handlers = {
  "desktop:bootstrap": async (_event: unknown, dependencies: DesktopIpcDependencies) =>
    dependencies.service.bootstrap(),
  "desktop:choose-workspace": async (_event: unknown, dependencies: DesktopIpcDependencies) => {
    const result = await dependencies.dialog.showOpenDialog(dependencies.getWindow(), {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  },
  "desktop:save-profile": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.saveProfile(parseRequest(saveProfileRequestSchema, request)),
  "desktop:read-session": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    sessionId: unknown,
  ) => dependencies.service.readSession(parseRequest(sessionIdSchema, sessionId)),
  "desktop:read-diff": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => {
    const parsed = parseRequest(rollbackRequestSchema, request);
    return dependencies.service.readChangedFileDiff(parsed.sessionId, parsed.filePath);
  },
  "desktop:rollback": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.rollback(parseRequest(rollbackRequestSchema, request)),
  "desktop:start-turn": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => {
    const { runId } = await dependencies.runManager.start(
      parseRequest(startTurnRequestSchema, request),
    );
    return { runId };
  },
  "desktop:stop-turn": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    runId: unknown,
  ) => dependencies.runManager.stop(parseRequest(runIdSchema, runId)),
  "desktop:approval-response": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    response: unknown,
  ) => dependencies.runManager.respondApproval(parseRequest(approvalResponseSchema, response)),
  "desktop:question-response": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    response: unknown,
  ) => dependencies.runManager.respondQuestion(parseRequest(questionResponseSchema, response)),
} as const;

const channels = Object.keys(handlers) as Array<keyof typeof handlers>;

export function registerDesktopIpc(dependencies: DesktopIpcDependencies): () => void {
  for (const channel of channels) {
    dependencies.ipcMain.handle(channel, async (event, request) => {
      try {
        return { ok: true, value: await handlers[channel](event, dependencies, request) };
      } catch (error) {
        return { ok: false, error: toDesktopError(error) };
      }
    });
  }

  return () => {
    for (const channel of channels) {
      dependencies.ipcMain.removeHandler(channel);
    }
  };
}

function parseRequest<T>(schema: z.ZodType<T>, request: unknown): T {
  const result = schema.safeParse(request);
  if (!result.success) {
    throw {
      code: "invalid_request",
      message: "Request is invalid.",
      recoverable: true,
    } satisfies DesktopError;
  }
  return result.data;
}

function toDesktopError(error: unknown): DesktopError {
  return sanitizeDesktopError(error);
}
