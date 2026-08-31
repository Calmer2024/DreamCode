import type { z } from "zod";
import {
  approvalResponseSchema,
  createProfileRequestSchema,
  createProjectRequestSchema,
  type DesktopError,
  type DesktopIpcResponse,
  profileIdSchema,
  projectRequestSchema,
  questionResponseSchema,
  rollbackRequestSchema,
  runIdSchema,
  sanitizeDesktopError,
  sessionIdSchema,
  sessionPinRequestSchema,
  sessionRenameRequestSchema,
  setDefaultProfileRequestSchema,
  skillInstallRequestSchema,
  skillLifecycleRequestSchema,
  skillRootsRequestSchema,
  skillToggleRequestSchema,
  skillWorkspaceRequestSchema,
  startTurnRequestSchema,
  testProfileRequestSchema,
  updateProfileRequestSchema,
  webSearchCredentialRequestSchema,
  workspaceRootSchema,
} from "../shared/contracts";
import type { DesktopAppService } from "./app-service";
import type { DesktopRunManager } from "./run-manager";
import type { DesktopTerminalManager } from "./terminal-manager";

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
    | "bootstrap"
    | "createProfile"
    | "updateProfile"
    | "deleteProfile"
    | "setDefaultProfile"
    | "testProfile"
    | "updateWebSearchCredential"
    | "createProject"
    | "saveProject"
    | "deleteProject"
    | "deleteSession"
    | "renameSession"
    | "setSessionPinned"
    | "readSession"
    | "readChangedFileDiff"
    | "rollback"
    | "listSkills"
    | "rescanSkills"
    | "setSkillEnabled"
    | "setSkillRoots"
    | "installSkill"
    | "updateSkill"
    | "rollbackSkill"
    | "uninstallSkill"
  >;
  runManager: Pick<DesktopRunManager, "start" | "stop" | "respondApproval" | "respondQuestion">;
  terminalManager: Pick<DesktopTerminalManager, "start" | "write" | "resize" | "close">;
  getWindow: () => unknown;
  chooseWorkspace?: () => Promise<string | undefined>;
  openWorkspace: (workspaceRoot: string) => Promise<void>;
}

const handlers = {
  "desktop:bootstrap": async (_event: unknown, dependencies: DesktopIpcDependencies) =>
    dependencies.service.bootstrap(),
  "desktop:choose-workspace": async (_event: unknown, dependencies: DesktopIpcDependencies) => {
    if (dependencies.chooseWorkspace) {
      return dependencies.chooseWorkspace();
    }
    const result = await dependencies.dialog.showOpenDialog(dependencies.getWindow(), {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  },
  "desktop:open-workspace": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    workspaceRoot: unknown,
  ) => dependencies.openWorkspace(parseRequest(workspaceRootSchema, workspaceRoot)),
  "desktop:create-profile": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.createProfile(parseRequest(createProfileRequestSchema, request)),
  "desktop:update-profile": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.updateProfile(parseRequest(updateProfileRequestSchema, request)),
  "desktop:delete-profile": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    profileId: unknown,
  ) => dependencies.service.deleteProfile(parseRequest(profileIdSchema, profileId)),
  "desktop:set-default-profile": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) =>
    dependencies.service.setDefaultProfile(
      parseRequest(setDefaultProfileRequestSchema, request).profileId,
    ),
  "desktop:test-profile": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.testProfile(parseRequest(testProfileRequestSchema, request)),
  "desktop:update-web-search-credential": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) =>
    dependencies.service.updateWebSearchCredential(
      parseRequest(webSearchCredentialRequestSchema, request),
    ),
  "desktop:list-skills": async (_event: unknown, dependencies: DesktopIpcDependencies, request: unknown) =>
    dependencies.service.listSkills(parseRequest(skillWorkspaceRequestSchema, request).workspaceRoot),
  "desktop:rescan-skills": async (_event: unknown, dependencies: DesktopIpcDependencies, request: unknown) =>
    dependencies.service.rescanSkills(parseRequest(skillWorkspaceRequestSchema, request).workspaceRoot),
  "desktop:set-skill-enabled": async (_event: unknown, dependencies: DesktopIpcDependencies, request: unknown) =>
    dependencies.service.setSkillEnabled(parseRequest(skillToggleRequestSchema, request)),
  "desktop:set-skill-roots": async (_event: unknown, dependencies: DesktopIpcDependencies, request: unknown) =>
    dependencies.service.setSkillRoots(parseRequest(skillRootsRequestSchema, request)),
  "desktop:install-skill": async (_event: unknown, dependencies: DesktopIpcDependencies, request: unknown) =>
    dependencies.service.installSkill(parseRequest(skillInstallRequestSchema, request)),
  "desktop:update-skill": async (_event: unknown, dependencies: DesktopIpcDependencies, request: unknown) =>
    dependencies.service.updateSkill(parseRequest(skillLifecycleRequestSchema, request)),
  "desktop:rollback-skill": async (_event: unknown, dependencies: DesktopIpcDependencies, request: unknown) => {
    const parsed = parseRequest(skillLifecycleRequestSchema, request);
    return dependencies.service.rollbackSkill({ workspaceRoot: parsed.workspaceRoot, skillId: parsed.skillId });
  },
  "desktop:uninstall-skill": async (_event: unknown, dependencies: DesktopIpcDependencies, request: unknown) => {
    const parsed = parseRequest(skillLifecycleRequestSchema, request);
    return dependencies.service.uninstallSkill({ workspaceRoot: parsed.workspaceRoot, skillId: parsed.skillId });
  },
  "desktop:save-project": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.saveProject(parseRequest(projectRequestSchema, request)),
  "desktop:create-project": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.createProject(parseRequest(createProjectRequestSchema, request)),
  "desktop:delete-project": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.deleteProject(parseRequest(workspaceRootSchema, request)),
  "desktop:delete-session": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.deleteSession(parseRequest(sessionIdSchema, request)),
  "desktop:rename-session": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.renameSession(parseRequest(sessionRenameRequestSchema, request)),
  "desktop:set-session-pinned": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => dependencies.service.setSessionPinned(parseRequest(sessionPinRequestSchema, request)),
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
  "desktop:terminal-start": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    cwd: unknown,
  ) =>
    dependencies.terminalManager.start(parseRequest(workspaceRootSchema, cwd), (output) => {
      const window = dependencies.getWindow() as
        | { webContents?: { send?: (channel: string, payload: unknown) => void } }
        | undefined;
      window?.webContents?.send?.("desktop:terminal-output", output);
    }),
  "desktop:terminal-write": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => {
    const value = request as { terminalId?: unknown; data?: unknown };
    if (typeof value.terminalId !== "string" || typeof value.data !== "string")
      throw { code: "invalid_request", recoverable: true };
    dependencies.terminalManager.write(value.terminalId, value.data);
  },
  "desktop:terminal-resize": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    request: unknown,
  ) => {
    const value = request as { terminalId?: unknown; columns?: unknown; rows?: unknown };
    if (
      typeof value.terminalId !== "string" ||
      typeof value.columns !== "number" ||
      typeof value.rows !== "number"
    )
      throw { code: "invalid_request", recoverable: true };
    dependencies.terminalManager.resize(value.terminalId, value.columns, value.rows);
  },
  "desktop:terminal-close": async (
    _event: unknown,
    dependencies: DesktopIpcDependencies,
    terminalId: unknown,
  ) => {
    dependencies.terminalManager.close(parseRequest(sessionIdSchema, terminalId));
  },
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
