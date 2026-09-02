import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { contextOptionsForModel } from "@dreamcode/context";
import { findModelProviderPreset, listModelProviderPresets } from "@dreamcode/models";
import { ProcessSupervisor } from "@dreamcode/tools";
import type { DreamCodeConfig, DreamCodeLlmProfile } from "@dreamcode/store";
import {
  createLlmProfile,
  deleteLlmProfile,
  deleteProjectMetadata,
  deleteSessionsForWorkspace,
  deleteSession as deleteStoredSession,
  getDreamCodeHome,
  listSessions,
  loadDreamCodeConfig,
  setSessionPinned as persistSessionPinned,
  renameSession as persistSessionTitle,
  readSessionEvents,
  replaySession,
  rollbackSession,
  saveDreamCodeConfig,
  setCurrentLlmProfile,
  updateLlmProfile,
  upsertProject,
} from "@dreamcode/store";
import type {
  CreateProfileRequest,
  CredentialAction,
  DesktopBootstrap,
  ProfileConnectionResult,
  RollbackRequest,
  SkillInstallRequest,
  TestProfileRequest,
  UpdateProfileRequest,
} from "../shared/contracts";
import { createDesktopProvider } from "./provider";
import { DesktopSkillService } from "./skill-service";

export function redactProfiles(config: DreamCodeConfig): DesktopBootstrap["profiles"] {
  return Object.entries(config.profiles).map(([id, profile]) => ({
    id,
    alias: profile.alias,
    provider: profile.provider,
    model: profile.model,
    baseURL: profile.baseURL,
    credentialSource: profile.apiKey ? "inline" : profile.apiKeyEnv ? "environment" : "none",
    apiKeyEnv: profile.apiKeyEnv,
    credentialAvailable: Boolean(
      profile.apiKey || (profile.apiKeyEnv && process.env[profile.apiKeyEnv]?.trim()),
    ),
  }));
}

export class DesktopAppService {
  readonly skills: DesktopSkillService;

  constructor(
    private readonly home?: string,
    skills?: DesktopSkillService,
    private readonly processSupervisor = new ProcessSupervisor(),
  ) {
    this.skills = skills ?? new DesktopSkillService({ home });
  }

  listSkills(workspaceRoot?: string) {
    return this.skills.list(workspaceRoot);
  }

  rescanSkills(workspaceRoot?: string) {
    return this.skills.rescan(workspaceRoot);
  }

  setSkillEnabled(request: { workspaceRoot?: string; skillId: string; enabled: boolean }) {
    return this.skills.setEnabled(request);
  }

  setSkillRoots(request: { workspaceRoot?: string; roots: string[] }) {
    return this.skills.setCustomRoots(request);
  }

  installSkill(request: SkillInstallRequest) {
    return this.skills.install(request);
  }

  updateSkill(request: { workspaceRoot?: string; skillId: string; confirmations?: SkillInstallRequest["confirmations"] }) {
    return this.skills.update(request);
  }

  rollbackSkill(request: { workspaceRoot?: string; skillId: string }) {
    return this.skills.rollback(request);
  }

  uninstallSkill(request: { workspaceRoot?: string; skillId: string }) {
    return this.skills.uninstall(request);
  }

  async bootstrap(): Promise<DesktopBootstrap> {
    const config = await loadDreamCodeConfig(this.home);
    return {
      webSearch: {
        provider: "exa",
        credentialSource: config.exaApiKey
          ? "inline"
          : process.env.EXA_API_KEY?.trim()
            ? "environment"
            : "none",
        credentialAvailable: Boolean(config.exaApiKey || process.env.EXA_API_KEY?.trim()),
      },
      profiles: redactProfiles(config),
      currentProfileId: config.currentProfileId,
      presets: [
        { id: "fake", displayName: "Fake Provider", defaultModel: "fake" },
        ...listModelProviderPresets().map((preset) => ({
          id: preset.id,
          displayName: preset.displayName,
          defaultModel: preset.defaultModel,
          defaultBaseURL: preset.defaultBaseURL,
          requiresBaseURL: preset.requiresBaseURL,
          models: preset.models?.map((model) => ({
            id: model.id,
            label: model.label,
            contextWindowTokens: contextOptionsForModel(preset.id, model.id).maxContextTokens,
          })),
        })),
      ],
      sessions: await this.listSessions(),
      projects: config.projects ?? [],
      pinnedSessionIds: config.pinnedSessionIds ?? [],
    };
  }

  async saveProject(request: { workspaceRoot: string; name: string; pinned?: boolean }) {
    await upsertProject(request, this.home);
    return this.bootstrap();
  }

  async createProject(request: { name: string }) {
    const projectsRoot = path.join(this.home ?? getDreamCodeHome(), "projects");
    await mkdir(projectsRoot, { recursive: true });
    const baseName = managedFolderName(request.name);
    let workspaceRoot = path.join(projectsRoot, baseName);
    for (let suffix = 2; await pathExists(workspaceRoot); suffix += 1) {
      workspaceRoot = path.join(projectsRoot, `${baseName}-${suffix}`);
    }
    await mkdir(workspaceRoot);
    await upsertProject({ workspaceRoot, name: request.name }, this.home);
    return { bootstrap: await this.bootstrap(), workspaceRoot };
  }

  async deleteSession(sessionId: string) {
    const validated = validateSessionId(sessionId);
    await this.processSupervisor.stopSession(validated);
    await deleteStoredSession(validated, this.home);
    return this.bootstrap();
  }

  async renameSession(request: { sessionId: string; title: string }) {
    await persistSessionTitle(validateSessionId(request.sessionId), request.title, this.home);
    return this.bootstrap();
  }

  async deleteProject(workspaceRoot: string) {
    await this.processSupervisor.stopWorkspace(workspaceRoot);
    await deleteSessionsForWorkspace(workspaceRoot, this.home);
    await deleteProjectMetadata(workspaceRoot, this.home);
    return this.bootstrap();
  }

  async setSessionPinned(request: { sessionId: string; pinned: boolean }) {
    await persistSessionPinned(validateSessionId(request.sessionId), request.pinned, this.home);
    return this.bootstrap();
  }

  async createProfile(request: CreateProfileRequest): Promise<DesktopBootstrap> {
    const config = await loadDreamCodeConfig(this.home);
    validateProfileDraft(request);
    if (request.credential.mode === "preserve") throw profileError("profile_validation_failed");
    const created = translateProfileMutation(() =>
      createLlmProfile(config, {
        alias: request.alias,
        provider: request.provider,
        model: request.model,
        baseURL: request.baseURL,
        ...credentialFields(request.credential),
      }),
    );
    await saveDreamCodeConfig(created.config, this.home);
    return this.bootstrap();
  }

  async updateWebSearchCredential(request: {
    mode: "preserve" | "clear" | "inline";
    apiKey?: string;
  }): Promise<DesktopBootstrap> {
    const config = await loadDreamCodeConfig(this.home);
    const exaApiKey =
      request.mode === "preserve"
        ? config.exaApiKey
        : request.mode === "inline"
          ? request.apiKey?.trim()
          : undefined;
    await saveDreamCodeConfig({ ...config, exaApiKey }, this.home);
    return this.bootstrap();
  }

  async updateProfile(request: UpdateProfileRequest): Promise<DesktopBootstrap> {
    const config = await loadDreamCodeConfig(this.home);
    const existing = config.profiles[request.profileId];
    if (!existing) throw profileError("profile_not_found");
    validateProfileDraft(request);
    const updated = translateProfileMutation(() =>
      updateLlmProfile(config, request.profileId, {
        alias: request.alias,
        provider: existing.provider,
        model: request.model,
        baseURL: request.baseURL,
        ...credentialFields(request.credential, existing),
      }),
    );
    await saveDreamCodeConfig(updated, this.home);
    return this.bootstrap();
  }

  async deleteProfile(profileId: string): Promise<DesktopBootstrap> {
    const config = await loadDreamCodeConfig(this.home);
    await saveDreamCodeConfig(deleteLlmProfile(config, profileId), this.home);
    return this.bootstrap();
  }

  async setDefaultProfile(profileId: string): Promise<DesktopBootstrap> {
    const config = await loadDreamCodeConfig(this.home);
    await saveDreamCodeConfig(setCurrentLlmProfile(config, profileId), this.home);
    return this.bootstrap();
  }

  async testProfile(request: TestProfileRequest): Promise<ProfileConnectionResult> {
    const config = await loadDreamCodeConfig(this.home);
    const existing = request.profileId ? config.profiles[request.profileId] : undefined;
    if (request.profileId && !existing) return connectionFailure("profile_not_found");
    try {
      validateProfileDraft(request);
      const profile: DreamCodeLlmProfile = {
        provider: existing?.provider ?? request.provider,
        model: request.model,
        baseURL: request.baseURL,
        ...credentialFields(request.credential, existing),
      };
      if (profile.provider !== "fake" && !resolveCredential(profile)) {
        return connectionFailure("credential_missing");
      }
      if (profile.provider === "fake") return { ok: true, message: "连接测试成功。" };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("timeout")), 30_000);
      try {
        const { provider, model } = createDesktopProvider("Reply with OK.", profile);
        for await (const event of provider.stream({
          messages: [{ role: "user", content: "Reply with OK." }],
          tools: [],
          model: model ?? request.model,
          mode: "guided",
          workspaceRoot: this.home ?? getDreamCodeHome(),
          signal: controller.signal,
        })) {
          if (event.type === "text_delta" || event.type === "done" || event.type === "usage") {
            return { ok: true, message: "连接测试成功。" };
          }
        }
        return connectionFailure("empty_response");
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return classifyConnectionFailure(error);
    }
  }

  listSessions() {
    return listSessions({ home: this.home });
  }

  readSession(sessionId: string) {
    const validatedSessionId = validateSessionId(sessionId);
    return readSessionEvents(validatedSessionId, this.home).then((events) => ({
      ...replaySession(events),
      events,
    }));
  }

  async rollback(request: RollbackRequest) {
    const result = await rollbackSession({
      ...request,
      sessionId: validateSessionId(request.sessionId),
      home: this.home,
    });
    return { rolledBackFiles: result.rolledBackFiles, failedFiles: result.skippedFiles };
  }

  async readChangedFileDiff(sessionId: string, filePath: string): Promise<string> {
    const session = await this.readSession(sessionId);
    return session.changedFiles.find((file) => file.path === filePath)?.diff ?? "";
  }
}

function validateSessionId(sessionId: string): string {
  if (!/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("Invalid session ID.");
  }
  return sessionId;
}

function managedFolderName(name: string): string {
  const normalized = name
    .trim()
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
    .join("")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return normalized || "DreamCode-Project";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function validateProfileDraft(request: {
  provider: string;
  model: string;
  baseURL?: string;
}): void {
  if (request.provider === "fake") return;
  const preset = findModelProviderPreset(request.provider);
  if (!preset || (preset.requiresBaseURL && !request.baseURL)) {
    throw profileError("profile_validation_failed");
  }
}

function credentialFields(
  action: CredentialAction,
  existing?: DreamCodeLlmProfile,
): Pick<DreamCodeLlmProfile, "apiKey" | "apiKeyEnv"> {
  switch (action.mode) {
    case "preserve":
      return { apiKey: existing?.apiKey, apiKeyEnv: existing?.apiKeyEnv };
    case "inline":
      return { apiKey: action.apiKey, apiKeyEnv: undefined };
    case "environment":
      return { apiKey: undefined, apiKeyEnv: action.apiKeyEnv };
    case "clear":
      return { apiKey: undefined, apiKeyEnv: undefined };
  }
}

function resolveCredential(profile: DreamCodeLlmProfile): string | undefined {
  return profile.apiKeyEnv
    ? process.env[profile.apiKeyEnv]?.trim() || profile.apiKey
    : profile.apiKey;
}

function profileError(code: string) {
  return { code, recoverable: true } as const;
}

function translateProfileMutation<T>(mutation: () => T): T {
  try {
    return mutation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("alias already exists")) throw profileError("profile_alias_conflict");
    if (message.includes("does not exist")) throw profileError("profile_not_found");
    throw error;
  }
}

function connectionFailure(
  code: Exclude<ProfileConnectionResult, { ok: true }>["code"],
): ProfileConnectionResult {
  const messages: Record<typeof code, string> = {
    credential_missing: "未找到可用凭证，请检查 API Key 或环境变量。",
    credential_invalid: "凭证无效，请检查 API Key。",
    model_not_found: "模型不存在或当前账号无权访问。",
    network_error: "无法连接模型服务，请检查 Base URL 和网络。",
    timeout: "连接测试超时，请稍后重试。",
    server_error: "模型服务返回错误，请稍后重试。",
    empty_response: "模型服务未返回有效响应。",
    profile_not_found: "配置已不存在，请刷新后重试。",
  };
  return { ok: false, code, message: messages[code] };
}

function classifyConnectionFailure(error: unknown): ProfileConnectionResult {
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error);
  if (message.includes("timeout") || message.includes("abort")) return connectionFailure("timeout");
  if (message.includes("401") || message.includes("403") || message.includes("api key")) {
    return connectionFailure("credential_invalid");
  }
  if (message.includes("404") || (message.includes("model") && message.includes("not"))) {
    return connectionFailure("model_not_found");
  }
  if (message.includes("fetch") || message.includes("connect") || message.includes("network")) {
    return connectionFailure("network_error");
  }
  return connectionFailure("server_error");
}
