import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, ChangedFile, FinalSummary, Session, TodoItem } from "@dreamcode/shared";
import { createId, makeEvent, nowIso } from "@dreamcode/shared";
import {
  type SkillLocator,
  type SkillStateProvider,
  skillLocatorStateKey,
} from "@dreamcode/skills";

const configWriteQueues = new Map<string, Promise<void>>();
const skillStateWriteQueues = new Map<string, Promise<void>>();

export type ManagedSkillSource =
  | { type: "directory"; location: string; subpath?: string }
  | { type: "zip"; location: string; subpath?: string }
  | { type: "git"; location: string; ref?: string; subpath?: string };

export interface ManagedSkillPreviousVersion {
  backupPath: string;
  version?: string;
  revision?: string;
  contentHash: string;
}

export interface ManagedSkillInstallation {
  skillId: string;
  name: string;
  path: string;
  scope: "user" | "project";
  source: ManagedSkillSource;
  version?: string;
  revision?: string;
  contentHash: string;
  installedAt: string;
  previous?: ManagedSkillPreviousVersion;
}

interface UserSkillStateFile {
  version: 1;
  states: Record<string, { enabled: boolean }>;
  customRoots: string[];
  installations: Record<string, ManagedSkillInstallation>;
}

interface ProjectSkillStateFile {
  version: 1;
  states: Record<string, { enabled: boolean }>;
  installations: Record<string, ManagedSkillInstallation>;
}

export class PersistedSkillState implements SkillStateProvider {
  private constructor(
    readonly home: string,
    readonly workspaceRoot: string,
    private user: UserSkillStateFile,
    private project: ProjectSkillStateFile,
  ) {}

  static async open(input: { home?: string; workspaceRoot: string }): Promise<PersistedSkillState> {
    const home = input.home ?? getDreamCodeHome();
    const workspaceRoot = path.resolve(input.workspaceRoot);
    const [user, project] = await Promise.all([
      loadUserSkillState(getSkillStatePath(home)),
      loadProjectSkillState(getProjectSkillStatePath(workspaceRoot)),
    ]);
    return new PersistedSkillState(home, workspaceRoot, user, project);
  }

  isEnabled(locator: SkillLocator): boolean | undefined {
    const key = skillLocatorStateKey(locator);
    return (locator.source === "project" ? this.project.states[key] : this.user.states[key])
      ?.enabled;
  }

  async setEnabled(locator: SkillLocator, enabled: boolean): Promise<void> {
    const key = skillLocatorStateKey(locator);
    if (locator.source === "project") {
      const filePath = getProjectSkillStatePath(this.workspaceRoot);
      this.project = await updateSkillStateFile(filePath, loadProjectSkillState, (current) => ({
        ...current,
        states: { ...current.states, [key]: { enabled } },
      }));
      return;
    }
    const filePath = getSkillStatePath(this.home);
    this.user = await updateSkillStateFile(filePath, loadUserSkillState, (current) => ({
      ...current,
      states: { ...current.states, [key]: { enabled } },
    }));
  }

  customRoots(): readonly string[] {
    return this.user.customRoots;
  }

  async setCustomRoots(roots: readonly string[]): Promise<void> {
    const filePath = getSkillStatePath(this.home);
    this.user = await updateSkillStateFile(filePath, loadUserSkillState, (current) => ({
      ...current,
      customRoots: [...new Set(roots.map((root) => path.resolve(root)))],
    }));
  }

  listInstallations(): readonly ManagedSkillInstallation[] {
    return [
      ...Object.values(this.user.installations),
      ...Object.values(this.project.installations),
    ];
  }

  getInstallation(skillId: string): ManagedSkillInstallation | undefined {
    return this.user.installations[skillId] ?? this.project.installations[skillId];
  }

  async saveInstallation(installation: ManagedSkillInstallation): Promise<void> {
    if (installation.scope === "project") {
      const filePath = getProjectSkillStatePath(this.workspaceRoot);
      this.project = await updateSkillStateFile(filePath, loadProjectSkillState, (current) => ({
        ...current,
        installations: { ...current.installations, [installation.skillId]: installation },
      }));
      return;
    }
    const filePath = getSkillStatePath(this.home);
    this.user = await updateSkillStateFile(filePath, loadUserSkillState, (current) => ({
      ...current,
      installations: { ...current.installations, [installation.skillId]: installation },
    }));
  }

  async deleteInstallation(skillId: string): Promise<void> {
    if (this.project.installations[skillId]) {
      const filePath = getProjectSkillStatePath(this.workspaceRoot);
      this.project = await updateSkillStateFile(filePath, loadProjectSkillState, (current) => {
        const installations = { ...current.installations };
        delete installations[skillId];
        return { ...current, installations };
      });
      return;
    }
    const filePath = getSkillStatePath(this.home);
    this.user = await updateSkillStateFile(filePath, loadUserSkillState, (current) => {
      const installations = { ...current.installations };
      delete installations[skillId];
      return { ...current, installations };
    });
  }
}

export function getSkillStatePath(home = getDreamCodeHome()): string {
  return path.join(home, "skills.json");
}

export function getProjectSkillStatePath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".dreamcode", "skills.local.json");
}

export function getDreamCodeHome(): string {
  return process.env.DREAMCODE_HOME ?? path.join(os.homedir(), ".dreamcode");
}

export function getSessionsRoot(home = getDreamCodeHome()): string {
  return path.join(home, "sessions");
}

export function getSessionDir(sessionId: string, home = getDreamCodeHome()): string {
  return path.join(getSessionsRoot(home), sessionId);
}

export function getIndexPath(home = getDreamCodeHome()): string {
  return path.join(home, "index.sqlite.json");
}

export interface DreamCodeLlmProfile {
  provider: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
}

export interface DreamCodeStoredLlmProfile extends DreamCodeLlmProfile {
  alias: string;
}

export interface DreamCodeMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface DreamCodeConfig {
  version: 2;
  currentProfileId?: string;
  profiles: Record<string, DreamCodeStoredLlmProfile>;
  exaApiKey?: string;
  mcpServers?: Record<string, DreamCodeMcpServerConfig>;
  projects?: DreamCodeProject[];
  pinnedSessionIds?: string[];
  sessionTitles?: Record<string, string>;
}

export interface DreamCodeProject {
  workspaceRoot: string;
  name: string;
  pinned?: boolean;
  createdAt: string;
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
  const previous = configWriteQueues.get(configPath) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      const temporaryPath = `${configPath}.${process.pid}.${createId("write")}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify(normalizeConfig(config), null, 2)}\n`,
        "utf8",
      );
      try {
        await rename(temporaryPath, configPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    });
  configWriteQueues.set(configPath, write);
  try {
    await write;
  } finally {
    if (configWriteQueues.get(configPath) === write) configWriteQueues.delete(configPath);
  }
  return configPath;
}

export function getActiveLlmProfile(config: DreamCodeConfig): DreamCodeLlmProfile | undefined {
  if (!config.currentProfileId) {
    return undefined;
  }
  return config.profiles[config.currentProfileId];
}

export function findLlmProfile(
  config: DreamCodeConfig,
  selector: string,
  provider?: string,
): { id: string; profile: DreamCodeStoredLlmProfile } | undefined {
  const direct = config.profiles[selector];
  if (direct && (!provider || direct.provider === provider))
    return { id: selector, profile: direct };
  const normalized = selector.trim().toLocaleLowerCase();
  const matches = Object.entries(config.profiles).filter(
    ([, profile]) =>
      profile.alias.toLocaleLowerCase() === normalized &&
      (!provider || profile.provider === provider),
  );
  return matches.length === 1 ? { id: matches[0]![0], profile: matches[0]![1] } : undefined;
}

export function createLlmProfile(
  config: DreamCodeConfig,
  profile: DreamCodeLlmProfile & { alias: string },
): { config: DreamCodeConfig; profileId: string } {
  assertUniqueProfileAlias(config, profile.provider, profile.alias);
  const profileId = createId("profile");
  return {
    profileId,
    config: normalizeConfig({
      ...config,
      profiles: { ...config.profiles, [profileId]: normalizeStoredProfile(profile, profile.alias) },
    }),
  };
}

export function updateLlmProfile(
  config: DreamCodeConfig,
  profileId: string,
  profile: DreamCodeLlmProfile & { alias: string },
): DreamCodeConfig {
  if (!config.profiles[profileId]) throw new Error("Model profile does not exist.");
  assertUniqueProfileAlias(config, profile.provider, profile.alias, profileId);
  return normalizeConfig({
    ...config,
    profiles: { ...config.profiles, [profileId]: normalizeStoredProfile(profile, profile.alias) },
  });
}

export function deleteLlmProfile(config: DreamCodeConfig, profileId: string): DreamCodeConfig {
  const profileIds = Object.keys(config.profiles);
  const index = profileIds.indexOf(profileId);
  if (index < 0) throw new Error("Model profile does not exist.");
  const profiles = { ...config.profiles };
  delete profiles[profileId];
  let currentProfileId = config.currentProfileId;
  if (currentProfileId === profileId) {
    currentProfileId = profileIds[index + 1] ?? profileIds[index - 1];
  }
  return normalizeConfig({ ...config, currentProfileId, profiles });
}

export function setCurrentLlmProfile(
  config: DreamCodeConfig,
  profileId: string | undefined,
): DreamCodeConfig {
  if (profileId && !config.profiles[profileId]) throw new Error("Model profile does not exist.");
  return normalizeConfig({ ...config, currentProfileId: profileId });
}

export function upsertLlmProfile(
  config: DreamCodeConfig,
  name: string,
  profile: DreamCodeLlmProfile,
): DreamCodeConfig {
  const alias = name.trim() || profile.provider;
  const existing = findLlmProfile(config, alias, profile.provider);
  if (existing) {
    return setCurrentLlmProfile(
      updateLlmProfile(config, existing.id, { ...profile, alias }),
      existing.id,
    );
  }
  const created = createLlmProfile(config, { ...profile, alias });
  return setCurrentLlmProfile(created.config, created.profileId);
}

export async function upsertProject(
  project: Pick<DreamCodeProject, "workspaceRoot" | "name"> & Partial<DreamCodeProject>,
  home = getDreamCodeHome(),
): Promise<DreamCodeConfig> {
  const config = await loadDreamCodeConfig(home);
  const workspaceRoot = path.resolve(project.workspaceRoot);
  const existing = config.projects?.find((item) => item.workspaceRoot === workspaceRoot);
  const next: DreamCodeProject = {
    workspaceRoot,
    name: project.name.trim() || path.basename(workspaceRoot),
    pinned: project.pinned ?? existing?.pinned,
    createdAt: existing?.createdAt ?? project.createdAt ?? nowIso(),
  };
  const projects = [...(config.projects ?? [])];
  const existingIndex = projects.findIndex((item) => item.workspaceRoot === workspaceRoot);
  if (existingIndex >= 0) projects[existingIndex] = next;
  else projects.push(next);
  const updated = normalizeConfig({ ...config, projects });
  await saveDreamCodeConfig(updated, home);
  return updated;
}

export async function deleteProjectMetadata(
  workspaceRoot: string,
  home = getDreamCodeHome(),
): Promise<DreamCodeConfig> {
  const config = await loadDreamCodeConfig(home);
  const resolved = path.resolve(workspaceRoot);
  const updated = normalizeConfig({
    ...config,
    projects: (config.projects ?? []).filter((item) => item.workspaceRoot !== resolved),
  });
  await saveDreamCodeConfig(updated, home);
  return updated;
}

export async function setSessionPinned(
  sessionId: string,
  pinned: boolean,
  home = getDreamCodeHome(),
): Promise<DreamCodeConfig> {
  const config = await loadDreamCodeConfig(home);
  const ids = new Set(config.pinnedSessionIds ?? []);
  if (pinned) ids.add(sessionId);
  else ids.delete(sessionId);
  const updated = normalizeConfig({ ...config, pinnedSessionIds: [...ids] });
  await saveDreamCodeConfig(updated, home);
  return updated;
}

export async function renameSession(
  sessionId: string,
  title: string,
  home = getDreamCodeHome(),
): Promise<DreamCodeConfig> {
  const config = await loadDreamCodeConfig(home);
  const cleanTitle = title.trim().slice(0, 80);
  const sessionTitles = { ...(config.sessionTitles ?? {}) };
  if (cleanTitle) sessionTitles[sessionId] = cleanTitle;
  else delete sessionTitles[sessionId];
  const updated = normalizeConfig({ ...config, sessionTitles });
  await saveDreamCodeConfig(updated, home);
  return updated;
}

export async function deleteSession(sessionId: string, home = getDreamCodeHome()): Promise<void> {
  const resolved = path.resolve(getSessionDir(sessionId, home));
  const sessionsRoot = path.resolve(getSessionsRoot(home));
  if (path.dirname(resolved) !== sessionsRoot) throw new Error("Invalid session ID.");
  await rm(resolved, { recursive: true, force: true });
  await setSessionPinned(sessionId, false, home);
  await renameSession(sessionId, "", home);
  await rebuildSessionIndex(home);
}

export async function deleteSessionsForWorkspace(
  workspaceRoot: string,
  home = getDreamCodeHome(),
): Promise<string[]> {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const sessions = await listSessions({ home, limit: Number.MAX_SAFE_INTEGER });
  const ids = sessions
    .filter((item) => path.resolve(item.workspaceRoot) === resolvedWorkspace)
    .map((item) => item.id);
  for (const id of ids) await deleteSession(id, home);
  return ids;
}

export class JsonlEventLog {
  readonly filePath: string;
  private pendingModelDelta?: AgentEvent<{ text?: string; chunkCount?: number }>;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(readonly sessionDir: string) {
    this.filePath = path.join(sessionDir, "events.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await mkdir(path.join(this.sessionDir, "outputs"), { recursive: true });
    await mkdir(path.join(this.sessionDir, "patches"), { recursive: true });
    await mkdir(path.join(this.sessionDir, "snapshots"), { recursive: true });
    await mkdir(path.join(this.sessionDir, "artifacts"), { recursive: true });
    await writeFile(this.filePath, "", { flag: "a" });
  }

  async append(event: AgentEvent): Promise<void> {
    const write = this.appendQueue.catch(() => undefined).then(() => this.appendUnsafe(event));
    this.appendQueue = write;
    await write;
  }

  private async appendUnsafe(event: AgentEvent): Promise<void> {
    if (event.type === "model.delta" && isModelDeltaPayload(event.payload)) {
      if (
        this.pendingModelDelta &&
        this.pendingModelDelta.sessionId === event.sessionId &&
        this.pendingModelDelta.turnId === event.turnId
      ) {
        const previous = this.pendingModelDelta.payload.text ?? "";
        this.pendingModelDelta = {
          ...this.pendingModelDelta,
          payload: {
            ...this.pendingModelDelta.payload,
            text: previous + event.payload.text,
            chunkCount: (this.pendingModelDelta.payload.chunkCount ?? 1) + 1,
          },
        };
        return;
      }

      await this.flushPendingModelDelta();
      this.pendingModelDelta = {
        ...event,
        payload: {
          ...event.payload,
          chunkCount: event.payload.chunkCount ?? 1,
        },
      };
      return;
    }

    await this.flushPendingModelDelta();
    await writeFile(this.filePath, `${JSON.stringify(event)}\n`, { flag: "a" });
  }

  async readAll(): Promise<AgentEvent[]> {
    await this.appendQueue;
    await this.flushPendingModelDelta();
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

  private async flushPendingModelDelta(): Promise<void> {
    if (!this.pendingModelDelta) return;
    const event = this.pendingModelDelta;
    this.pendingModelDelta = undefined;
    await writeFile(this.filePath, `${JSON.stringify(event)}\n`, { flag: "a" });
  }
}

function isModelDeltaPayload(value: unknown): value is { text: string; chunkCount?: number } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "text" in value &&
      typeof (value as { text?: unknown }).text === "string",
  );
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
  const sessionDir = getSessionDir(id, input.home);
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

export interface OpenSessionInput {
  sessionId: string;
  home?: string;
}

export async function openSession(input: OpenSessionInput): Promise<{
  session: Session;
  eventLog: JsonlEventLog;
}> {
  const sessionDir = getSessionDir(input.sessionId, input.home);
  const session = normalizeSession(
    JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8")),
  );
  const eventLog = new JsonlEventLog(sessionDir);
  await eventLog.init();
  return { session, eventLog };
}

export function getOutputsDir(sessionDir: string): string {
  return path.join(sessionDir, "outputs");
}

export function getPatchesDir(sessionDir: string): string {
  return path.join(sessionDir, "patches");
}

export function getSnapshotsDir(sessionDir: string): string {
  return path.join(sessionDir, "snapshots");
}

export function getArtifactsDir(sessionDir: string): string {
  return path.join(sessionDir, "artifacts");
}

export interface ReplayedSessionState {
  session?: Session;
  turns: Array<{
    id: string;
    prompt: string;
    mode?: string;
    status: "running" | "completed" | "failed" | "interrupted";
    startedAt?: string;
    completedAt?: string;
  }>;
  status: "running" | "interrupted" | "completed" | "failed" | "rolled_back" | "unknown";
  firstPrompt?: string;
  latestPrompt?: string;
  latestSummary?: FinalSummary;
  todoItems: TodoItem[];
  changedFiles: ChangedFile[];
  commands: FinalSummary["commands"];
  artifacts: Array<{ kind?: string; path?: string; title?: string; url?: string }>;
  approvals: Array<{ tool?: string; decision?: string; reason?: string }>;
  costUsd: number;
  warnings: string[];
  updatedAt?: string;
}

export function replaySession(events: AgentEvent[]): ReplayedSessionState {
  const state: ReplayedSessionState = {
    turns: [],
    status: "unknown",
    todoItems: [],
    changedFiles: [],
    commands: [],
    artifacts: [],
    approvals: [],
    costUsd: 0,
    warnings: [],
  };
  const turns = new Map<string, ReplayedSessionState["turns"][number]>();

  for (const event of events) {
    state.updatedAt = event.timestamp;
    try {
      switch (event.type) {
        case "session.created": {
          const payload = event.payload as { session?: Session };
          if (payload.session) {
            state.session = normalizeSession(payload.session);
          }
          state.status = "running";
          break;
        }
        case "turn.started": {
          const payload = event.payload as {
            turn?: { id: string; prompt: string; mode?: string; startedAt?: string };
          };
          if (payload.turn) {
            const turn = {
              id: payload.turn.id,
              prompt: payload.turn.prompt,
              mode: payload.turn.mode,
              status: "running" as const,
              startedAt: payload.turn.startedAt,
            };
            turns.set(turn.id, turn);
            if (!state.firstPrompt) {
              state.firstPrompt = turn.prompt;
            }
            state.latestPrompt = turn.prompt;
            state.status = "running";
          }
          break;
        }
        case "user.message": {
          const payload = event.payload as { content?: string };
          if (!state.firstPrompt && payload.content) {
            state.firstPrompt = payload.content;
          }
          if (payload.content) {
            state.latestPrompt = payload.content;
          }
          break;
        }
        case "todo.updated": {
          const payload = event.payload as { items?: TodoItem[] };
          if (Array.isArray(payload.items)) {
            state.todoItems = payload.items;
          }
          break;
        }
        case "permission.decided": {
          const payload = event.payload as {
            tool?: string;
            decision?: { decision?: string; reason?: string };
          };
          state.approvals.push({
            tool: payload.tool,
            decision: payload.decision?.decision,
            reason: payload.decision?.reason,
          });
          break;
        }
        case "tool.completed": {
          const payload = event.payload as {
            tool?: string;
            data?: { command?: string; exitCode?: number };
            summary?: string;
          };
          if ((payload.tool === "bash" || payload.tool === "pwsh") && payload.data?.command) {
            state.commands.push({
              command: payload.data.command,
              exitCode: payload.data.exitCode,
              summary: payload.summary ?? "",
            });
          }
          break;
        }
        case "file.changed": {
          const payload = event.payload as { changedFile?: ChangedFile };
          if (payload.changedFile) {
            state.changedFiles.push(payload.changedFile);
          }
          break;
        }
        case "artifact.created":
        case "web.source.saved": {
          const payload = event.payload as {
            kind?: string;
            path?: string;
            title?: string;
            url?: string;
          };
          state.artifacts.push(payload);
          break;
        }
        case "model.usage": {
          const payload = event.payload as { usage?: { costUsd?: number } };
          state.costUsd += payload.usage?.costUsd ?? 0;
          break;
        }
        case "turn.completed": {
          const payload = event.payload as { summary?: FinalSummary };
          state.latestSummary = payload.summary;
          markLatestTurn(turns, "completed", event.timestamp);
          state.status = "completed";
          if (payload.summary?.changedFiles?.length) {
            state.changedFiles = mergeChangedFiles(
              state.changedFiles,
              payload.summary.changedFiles,
            );
          }
          break;
        }
        case "turn.failed": {
          const payload = event.payload as { summary?: FinalSummary };
          state.latestSummary = payload.summary;
          markLatestTurn(turns, "failed", event.timestamp);
          state.status = "failed";
          break;
        }
        case "turn.interrupted":
          markLatestTurn(turns, "interrupted", event.timestamp);
          state.status = "interrupted";
          break;
        case "file.rollback.completed":
          state.status = "rolled_back";
          break;
        default:
          break;
      }
    } catch (error) {
      state.warnings.push(
        `Failed to replay ${event.type} (${event.id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  state.turns = Array.from(turns.values());
  return state;
}

export interface SessionListItem {
  id: string;
  workspaceRoot: string;
  status: ReplayedSessionState["status"];
  title: string;
  firstPrompt: string;
  createdAt: string;
  updatedAt: string;
  changedFileCount: number;
  commandCount: number;
  totalCostUsd: number;
  eventLogPath: string;
}

export interface ListSessionsInput {
  home?: string;
  cwd?: string;
  status?: string;
  limit?: number;
}

export async function listSessions(input: ListSessionsInput = {}): Promise<SessionListItem[]> {
  const index = existsSync(getIndexPath(input.home))
    ? await readSessionIndex(input.home)
    : await rebuildSessionIndex(input.home);
  let sessions = index.sessions;

  if (input.cwd) {
    const cwd = path.resolve(input.cwd);
    sessions = sessions.filter((session) => session.workspaceRoot === cwd);
  }
  if (input.status) {
    sessions = sessions.filter((session) => session.status === input.status);
  }

  const config = await loadDreamCodeConfig(input.home);
  return sessions
    .map((session) => ({
      ...session,
      title: config.sessionTitles?.[session.id] ?? session.title,
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, input.limit ?? 50);
}

export interface SessionIndex {
  version: 1;
  rebuiltAt: string;
  sessions: SessionListItem[];
}

export async function rebuildSessionIndex(home = getDreamCodeHome()): Promise<SessionIndex> {
  const sessionsRoot = getSessionsRoot(home);
  await mkdir(sessionsRoot, { recursive: true });
  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  const sessions: SessionListItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessionDir = path.join(sessionsRoot, entry.name);
    try {
      const session = normalizeSession(
        JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8")),
      );
      const eventLog = new JsonlEventLog(sessionDir);
      const events = await eventLog.readAll();
      sessions.push(toSessionListItem(session, replaySession(events), eventLog.filePath));
    } catch {}
  }

  const index: SessionIndex = {
    version: 1,
    rebuiltAt: nowIso(),
    sessions,
  };
  await mkdir(home, { recursive: true });
  await writeFile(getIndexPath(home), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export async function readSessionEvents(
  sessionId: string,
  home = getDreamCodeHome(),
): Promise<AgentEvent[]> {
  const eventLog = new JsonlEventLog(getSessionDir(sessionId, home));
  return eventLog.readAll();
}

export async function readReplayedSession(
  sessionId: string,
  home = getDreamCodeHome(),
): Promise<ReplayedSessionState> {
  return replaySession(await readSessionEvents(sessionId, home));
}

export interface RollbackSessionInput {
  sessionId: string;
  home?: string;
  filePath?: string;
  all?: boolean;
  force?: boolean;
}

export interface RollbackResult {
  sessionId: string;
  rolledBackFiles: string[];
  skippedFiles: Array<{ path: string; reason: string }>;
}

export async function rollbackSession(input: RollbackSessionInput): Promise<RollbackResult> {
  const { session, eventLog } = await openSession({ sessionId: input.sessionId, home: input.home });
  const events = await eventLog.readAll();
  const state = replaySession(events);
  const targets = state.changedFiles
    .filter((file) => !input.filePath || file.path === toPosixPath(input.filePath))
    .reverse();
  const result: RollbackResult = {
    sessionId: input.sessionId,
    rolledBackFiles: [],
    skippedFiles: [],
  };

  await eventLog.append(
    makeEvent("file.rollback.started", {
      sessionId: session.id,
      payload: { filePath: input.filePath, all: input.all ?? !input.filePath },
    }),
  );

  for (const changedFile of targets) {
    try {
      await rollbackChangedFile({ session, changedFile, force: input.force ?? false });
      result.rolledBackFiles.push(changedFile.path);
      await eventLog.append(
        makeEvent("file.rollback.completed", {
          sessionId: session.id,
          payload: { changedFile },
        }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.skippedFiles.push({ path: changedFile.path, reason });
      await eventLog.append(
        makeEvent("file.rollback.failed", {
          sessionId: session.id,
          payload: { changedFile, reason },
        }),
      );
    }
  }

  await rebuildSessionIndex(input.home);
  return result;
}

async function rollbackChangedFile(input: {
  session: Session;
  changedFile: ChangedFile;
  force: boolean;
}): Promise<void> {
  const resolved = resolveWorkspacePath(input.session.workspaceRoot, input.changedFile.path);
  if (!resolved.isInside) {
    throw new Error("Refused to roll back a path outside the workspace.");
  }

  if (existsSync(resolved.absolutePath) && input.changedFile.afterHash && !input.force) {
    const current = await readFile(resolved.absolutePath, "utf8");
    const currentHash = sha256(current);
    if (currentHash !== input.changedFile.afterHash) {
      throw new Error("Current file hash no longer matches the recorded agent change.");
    }
  }

  if (input.changedFile.operation === "create") {
    if (existsSync(resolved.absolutePath)) {
      await rm(resolved.absolutePath);
    }
    return;
  }

  if (!input.changedFile.beforeSnapshotRef) {
    throw new Error("No before snapshot is available for this file.");
  }
  const snapshot = await readFile(input.changedFile.beforeSnapshotRef, "utf8");
  await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await writeFile(resolved.absolutePath, snapshot, "utf8");
}

function createEmptyConfig(): DreamCodeConfig {
  return {
    version: 2,
    profiles: {},
  };
}

function normalizeConfig(raw: unknown): DreamCodeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyConfig();
  }

  const input = raw as Record<string, unknown>;
  const profiles: Record<string, DreamCodeStoredLlmProfile> = {};
  const rawProfiles = input.profiles;
  const isVersion2 = input.version === 2;
  if (rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)) {
    for (const [key, profile] of Object.entries(rawProfiles)) {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        continue;
      }
      const candidate = profile as Partial<DreamCodeStoredLlmProfile>;
      const provider = normalizeString(candidate.provider) ?? "fake";
      const requestedAlias = normalizeString(candidate.alias) ?? key;
      const alias = uniqueMigratedAlias(profiles, provider, requestedAlias);
      const profileId = isVersion2 ? key : legacyProfileId(key);
      profiles[profileId] = normalizeStoredProfile(candidate, alias);
    }
  }

  const requestedCurrentProfileId = isVersion2
    ? normalizeString(input.currentProfileId)
    : normalizeString(input.currentProfile)
      ? legacyProfileId(normalizeString(input.currentProfile)!)
      : undefined;
  const currentProfileId =
    requestedCurrentProfileId && profiles[requestedCurrentProfileId]
      ? requestedCurrentProfileId
      : undefined;

  const mcpServers = normalizeMcpServers(input.mcpServers);
  const projects = normalizeProjects(input.projects);
  const pinnedSessionIds = Array.isArray(input.pinnedSessionIds)
    ? [
        ...new Set(
          input.pinnedSessionIds.filter(
            (item): item is string => typeof item === "string" && Boolean(item.trim()),
          ),
        ),
      ]
    : [];
  const sessionTitles = normalizeStringRecord(input.sessionTitles) ?? {};
  const exaApiKey = normalizeString(input.exaApiKey);
  return {
    version: 2,
    currentProfileId,
    profiles,
    ...(exaApiKey ? { exaApiKey } : {}),
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(projects.length ? { projects } : {}),
    ...(pinnedSessionIds.length ? { pinnedSessionIds } : {}),
    ...(Object.keys(sessionTitles).length ? { sessionTitles } : {}),
  };
}

function normalizeProjects(input: unknown): DreamCodeProject[] {
  if (!Array.isArray(input)) return [];
  const projects = new Map<string, DreamCodeProject>();
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const project = value as Partial<DreamCodeProject>;
    const workspaceRoot = normalizeString(project.workspaceRoot);
    if (!workspaceRoot) continue;
    const resolved = path.resolve(workspaceRoot);
    projects.set(resolved, {
      workspaceRoot: resolved,
      name: normalizeString(project.name) ?? path.basename(resolved),
      pinned: project.pinned === true || undefined,
      createdAt: normalizeString(project.createdAt) ?? nowIso(),
    });
  }
  return [...projects.values()];
}

function normalizeStoredProfile(
  profile: Partial<DreamCodeStoredLlmProfile>,
  alias: string,
): DreamCodeStoredLlmProfile {
  const provider = normalizeString(profile.provider) ?? "fake";
  return {
    alias: normalizeString(alias) ?? provider,
    provider,
    model: normalizeString(profile.model),
    apiKey: normalizeString(profile.apiKey),
    apiKeyEnv: normalizeString(profile.apiKeyEnv),
    baseURL: normalizeString(profile.baseURL),
  };
}

function legacyProfileId(name: string): string {
  return `profile_legacy_${createHash("sha256").update(name, "utf8").digest("hex")}`;
}

function uniqueMigratedAlias(
  profiles: Record<string, DreamCodeStoredLlmProfile>,
  provider: string,
  requestedAlias: string,
): string {
  const base = requestedAlias.trim() || provider;
  let alias = base;
  for (let suffix = 2; hasProfileAlias(profiles, provider, alias); suffix += 1) {
    alias = `${base} (${suffix})`;
  }
  return alias;
}

function assertUniqueProfileAlias(
  config: DreamCodeConfig,
  provider: string,
  alias: string,
  ignoredProfileId?: string,
): void {
  const normalizedAlias = alias.trim().toLocaleLowerCase();
  if (!normalizedAlias) throw new Error("Model profile alias is required.");
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    if (profileId === ignoredProfileId || profile.provider !== provider) continue;
    if (profile.alias.toLocaleLowerCase() === normalizedAlias) {
      throw new Error("A model profile with this alias already exists for the provider.");
    }
  }
}

async function loadUserSkillState(filePath: string): Promise<UserSkillStateFile> {
  const raw = await readOptionalJson(filePath);
  if (raw === undefined) return { version: 1, states: {}, customRoots: [], installations: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) {
    throw new Error(`Failed to read DreamCode Skill state at ${filePath}: unsupported schema.`);
  }
  return {
    version: 1,
    states: normalizeEnabledStates(raw.states),
    customRoots: Array.isArray(raw.customRoots)
      ? raw.customRoots.filter(
          (root): root is string => typeof root === "string" && Boolean(root.trim()),
        )
      : [],
    installations: normalizeInstallations(raw.installations, "user"),
  };
}

async function loadProjectSkillState(filePath: string): Promise<ProjectSkillStateFile> {
  const raw = await readOptionalJson(filePath);
  if (raw === undefined) return { version: 1, states: {}, installations: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) {
    throw new Error(
      `Failed to read DreamCode project Skill state at ${filePath}: unsupported schema.`,
    );
  }
  return {
    version: 1,
    states: normalizeEnabledStates(raw.states),
    installations: normalizeInstallations(raw.installations, "project"),
  };
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new Error(
      `Failed to read Skill state at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeEnabledStates(value: unknown): Record<string, { enabled: boolean }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, { enabled: boolean }> = {};
  for (const [key, state] of Object.entries(value)) {
    if (
      state &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      typeof state.enabled === "boolean"
    ) {
      result[key] = { enabled: state.enabled };
    }
  }
  return result;
}

function normalizeInstallations(
  value: unknown,
  expectedScope?: ManagedSkillInstallation["scope"],
): Record<string, ManagedSkillInstallation> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, ManagedSkillInstallation> = {};
  for (const [key, installation] of Object.entries(value)) {
    if (!installation || typeof installation !== "object" || Array.isArray(installation)) continue;
    const candidate = installation as Partial<ManagedSkillInstallation>;
    if (
      typeof candidate.skillId !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.path !== "string" ||
      (candidate.scope !== "user" && candidate.scope !== "project") ||
      typeof candidate.contentHash !== "string" ||
      typeof candidate.installedAt !== "string" ||
      !candidate.source
    ) {
      continue;
    }
    if (expectedScope && candidate.scope !== expectedScope) continue;
    result[key] = candidate as ManagedSkillInstallation;
  }
  return result;
}

async function updateSkillStateFile<T extends UserSkillStateFile | ProjectSkillStateFile>(
  filePath: string,
  load: (filePath: string) => Promise<T>,
  update: (current: T) => T,
): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const previous = skillStateWriteQueues.get(filePath) ?? Promise.resolve();
  let result: T | undefined;
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      result = update(await load(filePath));
      const temporaryPath = `${filePath}.${process.pid}.${createId("skill_state")}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      try {
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    });
  skillStateWriteQueues.set(filePath, write);
  try {
    await write;
  } finally {
    if (skillStateWriteQueues.get(filePath) === write) skillStateWriteQueues.delete(filePath);
  }
  return result!;
}

function hasProfileAlias(
  profiles: Record<string, DreamCodeStoredLlmProfile>,
  provider: string,
  alias: string,
): boolean {
  const normalizedAlias = alias.toLocaleLowerCase();
  return Object.values(profiles).some(
    (profile) =>
      profile.provider === provider && profile.alias.toLocaleLowerCase() === normalizedAlias,
  );
}

function normalizeMcpServers(input: unknown): Record<string, DreamCodeMcpServerConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const servers: Record<string, DreamCodeMcpServerConfig> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const server = value as Partial<DreamCodeMcpServerConfig>;
    const command = normalizeString(server.command);
    if (!command) {
      continue;
    }
    servers[name] = {
      command,
      args: Array.isArray(server.args)
        ? server.args.filter((item): item is string => typeof item === "string")
        : undefined,
      env: normalizeStringRecord(server.env),
      cwd: normalizeString(server.cwd),
    };
  }
  return servers;
}

function normalizeStringRecord(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSession(raw: unknown): Session {
  const input = raw as Partial<Session>;
  if (!input.id || !input.workspaceRoot || !input.sessionDir || !input.createdAt) {
    throw new Error("Invalid DreamCode session metadata.");
  }
  return {
    id: input.id,
    workspaceRoot: input.workspaceRoot,
    sessionDir: input.sessionDir,
    createdAt: input.createdAt,
  };
}

async function readSessionIndex(home = getDreamCodeHome()): Promise<SessionIndex> {
  return JSON.parse(await readFile(getIndexPath(home), "utf8")) as SessionIndex;
}

function toSessionListItem(
  session: Session,
  state: ReplayedSessionState,
  eventLogPath: string,
): SessionListItem {
  const firstPrompt = state.firstPrompt ?? "";
  return {
    id: session.id,
    workspaceRoot: session.workspaceRoot,
    status: state.status,
    title: firstPrompt.slice(0, 80) || session.id,
    firstPrompt,
    createdAt: session.createdAt,
    updatedAt: state.updatedAt ?? session.createdAt,
    changedFileCount: uniqueCount(state.changedFiles.map((file) => file.path)),
    commandCount: state.commands.length,
    totalCostUsd: state.costUsd,
    eventLogPath,
  };
}

function uniqueCount(values: string[]): number {
  return new Set(values).size;
}

function markLatestTurn(
  turns: Map<string, ReplayedSessionState["turns"][number]>,
  status: ReplayedSessionState["turns"][number]["status"],
  completedAt: string,
): void {
  const latest = Array.from(turns.values()).at(-1);
  if (latest) {
    latest.status = status;
    latest.completedAt = completedAt;
  }
}

function mergeChangedFiles(existing: ChangedFile[], incoming: ChangedFile[]): ChangedFile[] {
  const seen = new Set(existing.map((file) => `${file.path}:${file.afterHash ?? ""}`));
  const output = [...existing];
  for (const file of incoming) {
    const key = `${file.path}:${file.afterHash ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(file);
    }
  }
  return output;
}

function resolveWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
): { absolutePath: string; relativePath: string; isInside: boolean } {
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, inputPath);
  const relativePath = path.relative(root, absolutePath);
  const isInside =
    relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  return {
    absolutePath,
    relativePath: toPosixPath(relativePath === "" ? "." : relativePath),
    isInside,
  };
}

function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
