import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@dreamcode/shared";
import { createId, nowIso, type Session } from "@dreamcode/shared";

export function getDreamCodeHome(): string {
  return process.env.DREAMCODE_HOME ?? path.join(os.homedir(), ".dreamcode");
}

export function getSessionsRoot(home = getDreamCodeHome()): string {
  return path.join(home, "sessions");
}

export interface DreamCodeLlmProfile {
  provider: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
}

export interface DreamCodeConfig {
  version: 1;
  currentProfile?: string;
  profiles: Record<string, DreamCodeLlmProfile>;
}

export function getConfigPath(home = getDreamCodeHome()): string {
  return path.join(home, "config.json");
}

export async function loadDreamCodeConfig(home = getDreamCodeHome()): Promise<DreamCodeConfig> {
  const configPath = getConfigPath(home);

  try {
    const content = await readFile(configPath, "utf8");
    return normalizeConfig(JSON.parse(content));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return createEmptyConfig();
    }
    throw new Error(
      `Failed to read DreamCode config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function saveDreamCodeConfig(
  config: DreamCodeConfig,
  home = getDreamCodeHome(),
): Promise<string> {
  await mkdir(home, { recursive: true });
  const configPath = getConfigPath(home);
  await writeFile(configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
  return configPath;
}

export function getActiveLlmProfile(config: DreamCodeConfig): DreamCodeLlmProfile | undefined {
  if (!config.currentProfile) {
    return undefined;
  }
  return config.profiles[config.currentProfile];
}

export function upsertLlmProfile(
  config: DreamCodeConfig,
  name: string,
  profile: DreamCodeLlmProfile,
): DreamCodeConfig {
  const normalizedName = name.trim() || profile.provider;
  return normalizeConfig({
    ...config,
    currentProfile: normalizedName,
    profiles: {
      ...config.profiles,
      [normalizedName]: normalizeProfile(profile),
    },
  });
}

export class JsonlEventLog {
  readonly filePath: string;

  constructor(readonly sessionDir: string) {
    this.filePath = path.join(sessionDir, "events.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await mkdir(path.join(this.sessionDir, "outputs"), { recursive: true });
    await mkdir(path.join(this.sessionDir, "patches"), { recursive: true });
    await mkdir(path.join(this.sessionDir, "snapshots"), { recursive: true });
    await writeFile(this.filePath, "", { flag: "a" });
  }

  async append(event: AgentEvent): Promise<void> {
    await writeFile(this.filePath, `${JSON.stringify(event)}\n`, { flag: "a" });
  }

  async readAll(): Promise<AgentEvent[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentEvent);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

export interface CreateSessionInput {
  workspaceRoot: string;
  home?: string;
}

export async function createSession(input: CreateSessionInput): Promise<{
  session: Session;
  eventLog: JsonlEventLog;
}> {
  const id = createId("sess");
  const sessionDir = path.join(getSessionsRoot(input.home), id);
  const session: Session = {
    id,
    workspaceRoot: path.resolve(input.workspaceRoot),
    sessionDir,
    createdAt: nowIso(),
  };
  const eventLog = new JsonlEventLog(sessionDir);
  await eventLog.init();
  await writeFile(path.join(sessionDir, "session.json"), JSON.stringify(session, null, 2));
  return { session, eventLog };
}

export function getOutputsDir(sessionDir: string): string {
  return path.join(sessionDir, "outputs");
}

export function getPatchesDir(sessionDir: string): string {
  return path.join(sessionDir, "patches");
}

function createEmptyConfig(): DreamCodeConfig {
  return {
    version: 1,
    profiles: {},
  };
}

function normalizeConfig(raw: unknown): DreamCodeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyConfig();
  }

  const input = raw as Partial<DreamCodeConfig>;
  const profiles: Record<string, DreamCodeLlmProfile> = {};
  if (input.profiles && typeof input.profiles === "object" && !Array.isArray(input.profiles)) {
    for (const [name, profile] of Object.entries(input.profiles)) {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        continue;
      }
      const normalized = normalizeProfile(profile as Partial<DreamCodeLlmProfile>);
      if (normalized.provider) {
        profiles[name] = normalized;
      }
    }
  }

  const currentProfile =
    typeof input.currentProfile === "string" && profiles[input.currentProfile]
      ? input.currentProfile
      : Object.keys(profiles)[0];

  return {
    version: 1,
    currentProfile,
    profiles,
  };
}

function normalizeProfile(profile: Partial<DreamCodeLlmProfile>): DreamCodeLlmProfile {
  const provider = normalizeString(profile.provider) ?? "fake";
  return {
    provider,
    model: normalizeString(profile.model),
    apiKey: normalizeString(profile.apiKey),
    apiKeyEnv: normalizeString(profile.apiKeyEnv),
    baseURL: normalizeString(profile.baseURL),
  };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
