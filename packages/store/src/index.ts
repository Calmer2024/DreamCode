import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, ChangedFile, FinalSummary, Session, TodoItem } from "@dreamcode/shared";
import { createId, makeEvent, nowIso } from "@dreamcode/shared";

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

export interface DreamCodeMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface DreamCodeConfig {
  version: 1;
  currentProfile?: string;
  profiles: Record<string, DreamCodeLlmProfile>;
  mcpServers?: Record<string, DreamCodeMcpServerConfig>;
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
    await mkdir(path.join(this.sessionDir, "artifacts"), { recursive: true });
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
          if (payload.tool === "shell.run" && payload.data?.command) {
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

  return sessions
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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

  const mcpServers = normalizeMcpServers(input.mcpServers);
  return {
    version: 1,
    currentProfile,
    profiles,
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
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
