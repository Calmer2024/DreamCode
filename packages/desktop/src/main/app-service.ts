import { listModelProviderPresets } from "@dreamcode/models";
import {
  listSessions,
  loadDreamCodeConfig,
  readReplayedSession,
  rollbackSession,
  saveDreamCodeConfig,
  upsertLlmProfile,
} from "@dreamcode/store";
import type { DreamCodeConfig } from "@dreamcode/store";
import type {
  DesktopBootstrap,
  RollbackRequest,
  SaveProfileRequest,
} from "../shared/contracts";

export function redactProfiles(config: DreamCodeConfig): DesktopBootstrap["profiles"] {
  return Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    provider: profile.provider,
    model: profile.model,
    baseURL: profile.baseURL,
    apiKeyConfigured: Boolean(
      profile.apiKey || (profile.apiKeyEnv && process.env[profile.apiKeyEnv]),
    ),
  }));
}

export class DesktopAppService {
  constructor(private readonly home?: string) {}

  async bootstrap(): Promise<DesktopBootstrap> {
    const config = await loadDreamCodeConfig(this.home);
    return {
      profiles: redactProfiles(config),
      currentProfile: config.currentProfile,
      presets: listModelProviderPresets().map((preset) => ({
        id: preset.id,
        displayName: preset.displayName,
        defaultModel: preset.defaultModel,
        models: preset.models?.map((model) => ({ id: model.id, label: model.label })),
      })),
      sessions: await this.listSessions(),
    };
  }

  async saveProfile(request: SaveProfileRequest): Promise<DesktopBootstrap> {
    const config = await loadDreamCodeConfig(this.home);
    const existingProfile = config.profiles[request.name.trim()];
    const apiKey = request.apiKey ?? (request.apiKeyEnv ? undefined : existingProfile?.apiKey);
    const apiKeyEnv = request.apiKey
      ? undefined
      : (request.apiKeyEnv ?? existingProfile?.apiKeyEnv);
    await saveDreamCodeConfig(
      upsertLlmProfile(config, request.name, {
        provider: request.provider,
        model: request.model,
        baseURL: request.baseURL,
        // Renderer bootstrap deliberately redacts these values. Retain both only when
        // neither is replaced; the plaintext key takes precedence if both are supplied.
        apiKey,
        apiKeyEnv,
      }),
      this.home,
    );
    return this.bootstrap();
  }

  listSessions() {
    return listSessions({ home: this.home });
  }

  readSession(sessionId: string) {
    return readReplayedSession(validateSessionId(sessionId), this.home);
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
