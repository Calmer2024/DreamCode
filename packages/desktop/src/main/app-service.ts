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
    await saveDreamCodeConfig(
      upsertLlmProfile(config, request.name, {
        provider: request.provider,
        model: request.model,
        baseURL: request.baseURL,
        apiKey: request.apiKey,
        apiKeyEnv: request.apiKeyEnv,
      }),
      this.home,
    );
    return this.bootstrap();
  }

  listSessions() {
    return listSessions({ home: this.home });
  }

  readSession(sessionId: string) {
    return readReplayedSession(sessionId, this.home);
  }

  async rollback(request: RollbackRequest) {
    const result = await rollbackSession({ ...request, home: this.home });
    return { rolledBackFiles: result.rolledBackFiles, failedFiles: result.skippedFiles };
  }

  async readChangedFileDiff(sessionId: string, filePath: string): Promise<string> {
    const session = await this.readSession(sessionId);
    return session.changedFiles.find((file) => file.path === filePath)?.diff ?? "";
  }
}
