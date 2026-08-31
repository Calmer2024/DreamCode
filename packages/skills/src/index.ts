import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SkillCatalogEntry,
  SkillLoadedContent,
  SkillResourceContent,
  SkillTurnContext,
} from "@dreamcode/shared";
import { unzipSync } from "fflate";
import { parseDocument } from "yaml";

export type SkillSource = "built_in" | "system" | "user" | "project" | "plugin";

export type SkillCapability =
  | "filesystem.read"
  | "filesystem.write"
  | "process.execute"
  | "network.access"
  | "mcp.use";

export interface SkillMetadata {
  name: string;
  description: string;
  version?: string;
  allowImplicitInvocation: boolean;
  capabilities: readonly SkillCapability[];
  display?: {
    name?: string;
    shortDescription?: string;
    iconSmall?: string;
    iconLarge?: string;
    brandColor?: string;
    defaultPrompt?: string;
  };
  extensions: Readonly<Record<string, unknown>>;
}

export interface SkillLocator {
  source: SkillSource;
  provider: string;
  path: string;
  realPath: string;
  projectRelativePath?: string;
  pluginRelativePath?: string;
  pluginId?: string;
  pluginDisplayName?: string;
  pluginVersion?: string;
  pluginManagementAction?: string;
}

export type SkillDiagnosticCode =
  | "root_unreadable"
  | "skill_unreadable"
  | "metadata_missing"
  | "metadata_invalid"
  | "instruction_too_large"
  | "duplicate_path"
  | "name_conflict";

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  message: string;
  path: string;
  detail?: string;
}

export interface SkillInstance {
  skillId: string;
  locator: SkillLocator;
  metadata?: SkillMetadata;
  nameKey?: string;
  contentHash?: string;
  enabled: boolean;
  validity: "valid" | "invalid";
  resolution: "resolved" | "overridden" | "conflicted" | "ineligible";
  priority: number;
  diagnostics: readonly SkillDiagnostic[];
}

export interface SkillRoot {
  path: string;
  source: SkillSource;
  provider: string;
  priority: number;
  projectRoot?: string;
  pluginId?: string;
  pluginDisplayName?: string;
  pluginVersion?: string;
  pluginManagementAction?: string;
}

export interface PluginSkillRoot {
  path: string;
  provider?: string;
  priority?: number;
  pluginId: string;
  displayName?: string;
  version?: string;
  managementAction?: string;
}

export interface PluginSkillSourceProvider {
  listSkillRoots(): Promise<readonly PluginSkillRoot[]>;
}

export interface SkillStateProvider {
  isEnabled(locator: SkillLocator): boolean | undefined | Promise<boolean | undefined>;
}

export interface SkillRegistryOptions {
  workspaceRoot: string;
  workingDirectory?: string;
  userHome?: string;
  dreamCodeHome?: string;
  builtInRoots?: readonly string[];
  systemRoots?: readonly string[];
  customRoots?: readonly string[];
  pluginProviders?: readonly PluginSkillSourceProvider[];
  state?: SkillStateProvider;
  watch?: boolean;
  maxSkillBytes?: number;
}

export interface SkillScanMetrics {
  candidateCount: number;
  parsedSkillCount: number;
  cacheHitCount: number;
  scanDurationMs: number;
}

interface ScannedCandidate {
  root: SkillRoot;
  path: string;
  realPath: string;
}

interface CachedSkillFile {
  mtimeMs: number;
  size: number;
  openAiMtimeMs?: number;
  openAiSize?: number;
  content: string;
  contentHash: string;
  metadata?: SkillMetadata;
  diagnostics: readonly SkillDiagnostic[];
}

export class SkillRegistryError extends Error {
  constructor(
    readonly code:
      | "skill_not_found"
      | "skill_disabled"
      | "skill_invalid"
      | "skill_conflicted"
      | "resource_outside_skill"
      | "resource_not_text"
      | "resource_too_large",
    message: string,
  ) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

export class SkillSnapshot {
  readonly catalog: readonly SkillCatalogEntry[];
  private readonly byId: ReadonlyMap<string, SkillInstance>;
  private readonly resolvedByName: ReadonlyMap<string, SkillInstance>;

  constructor(
    readonly generation: number,
    readonly instances: readonly SkillInstance[],
    readonly diagnostics: readonly SkillDiagnostic[],
    private readonly contents: ReadonlyMap<string, string>,
    readonly scanMetrics: Readonly<SkillScanMetrics> = Object.freeze({
      candidateCount: 0,
      parsedSkillCount: 0,
      cacheHitCount: 0,
      scanDurationMs: 0,
    }),
  ) {
    this.byId = new Map(instances.map((instance) => [instance.skillId, instance]));
    this.resolvedByName = new Map(
      instances
        .filter(
          (instance): instance is SkillInstance & { nameKey: string } =>
            instance.resolution === "resolved" && Boolean(instance.nameKey),
        )
        .map((instance) => [instance.nameKey, instance]),
    );
    this.catalog = Object.freeze(
      instances
        .filter(
          (instance): instance is SkillInstance & { metadata: SkillMetadata } =>
            instance.resolution === "resolved" &&
            instance.enabled &&
            instance.validity === "valid" &&
            Boolean(instance.metadata?.allowImplicitInvocation),
        )
        .sort(compareInstances)
        .map((instance) => ({
          skillId: instance.skillId,
          name: instance.metadata.name,
          description: instance.metadata.description,
          source: instance.locator.source,
          path: path.join(instance.locator.path, "SKILL.md"),
          allowImplicitInvocation: instance.metadata.allowImplicitInvocation,
        })),
    );
  }

  resolve(name: string, qualifier?: string): SkillInstance | undefined {
    const nameKey = normalizeName(name);
    if (!qualifier || qualifier === "skill") return this.resolvedByName.get(nameKey);
    const normalizedQualifier = qualifier.toLocaleLowerCase();
    return this.instances
      .filter(
        (instance) =>
          instance.nameKey === nameKey &&
          instance.validity === "valid" &&
          instance.enabled &&
          instance.resolution !== "conflicted",
      )
      .sort(compareInstances)
      .find(
        (instance) =>
          instance.locator.source === normalizeSourceQualifier(normalizedQualifier) ||
          instance.locator.pluginId?.toLocaleLowerCase() === normalizedQualifier,
      );
  }

  get(skillId: string): SkillInstance | undefined {
    return this.byId.get(skillId);
  }

  createTurnContext(): SkillTurnContext {
    const loadCache = new Map<string, SkillLoadedContent>();
    return {
      generation: this.generation,
      catalog: this.catalog,
      load: async (skillId) => {
        const cached = loadCache.get(skillId);
        if (cached) return { ...cached, cacheHit: true };
        const instance = this.callable(skillId);
        const content = this.contents.get(skillId);
        if (!content || !instance.metadata || !instance.contentHash) {
          throw new SkillRegistryError("skill_invalid", `Skill content is unavailable: ${skillId}`);
        }
        const loaded: SkillLoadedContent = {
          skillId,
          name: instance.metadata.name,
          version: instance.metadata.version,
          path: path.join(instance.locator.path, "SKILL.md"),
          content: renderSkillContent(instance, content),
          contentHash: instance.contentHash,
          cacheHit: false,
        };
        loadCache.set(skillId, loaded);
        return loaded;
      },
      readResource: async (skillId, resourcePath, maxBytes = 40_000) =>
        readSkillResource(this.callable(skillId), resourcePath, maxBytes),
    };
  }

  private callable(skillId: string): SkillInstance {
    const instance = this.byId.get(skillId);
    if (!instance) throw new SkillRegistryError("skill_not_found", `Skill not found: ${skillId}`);
    if (!instance.enabled) {
      throw new SkillRegistryError("skill_disabled", `Skill is disabled: ${skillId}`);
    }
    if (instance.validity !== "valid") {
      throw new SkillRegistryError("skill_invalid", `Skill is invalid: ${skillId}`);
    }
    if (instance.resolution === "conflicted") {
      throw new SkillRegistryError("skill_conflicted", `Skill has an unresolved conflict: ${skillId}`);
    }
    return instance;
  }
}

export class SkillRegistry {
  private generation = 0;
  private snapshot = new SkillSnapshot(0, [], [], new Map());
  private readonly cache = new Map<string, CachedSkillFile>();
  private readonly listeners = new Set<(snapshot: SkillSnapshot) => void>();
  private watchers: FSWatcher[] = [];
  private refreshPromise?: Promise<SkillSnapshot>;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: SkillRegistryOptions) {}

  async initialize(): Promise<SkillSnapshot> {
    return this.refresh();
  }

  current(): SkillSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: SkillSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<SkillSnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.scan().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  close(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.listeners.clear();
  }

  private async scan(): Promise<SkillSnapshot> {
    const startedAt = performance.now();
    const roots = await buildSkillRoots(this.options);
    const diagnostics: SkillDiagnostic[] = [];
    const candidates = await discoverCandidates(roots, diagnostics);
    const contents = new Map<string, string>();
    const instances: SkillInstance[] = [];
    const metrics = { parsedSkillCount: 0, cacheHitCount: 0 };

    for (const candidate of candidates) {
      const instance = await this.scanCandidate(candidate, metrics);
      instances.push(instance);
      const cached = this.cache.get(path.join(candidate.realPath, "SKILL.md"));
      if (instance.validity === "valid" && cached) contents.set(instance.skillId, cached.content);
    }

    await applyEnablement(instances, this.options.state);
    resolveInstances(instances, diagnostics);
    const next = new SkillSnapshot(
      ++this.generation,
      freezeInstances(instances),
      diagnostics,
      contents,
      Object.freeze({
        candidateCount: candidates.length,
        parsedSkillCount: metrics.parsedSkillCount,
        cacheHitCount: metrics.cacheHitCount,
        scanDurationMs: Math.max(0, performance.now() - startedAt),
      }),
    );
    this.snapshot = next;
    if (this.options.watch) this.resetWatchers(roots, instances);
    for (const listener of this.listeners) listener(next);
    return next;
  }

  private async scanCandidate(
    candidate: ScannedCandidate,
    metrics: { parsedSkillCount: number; cacheHitCount: number },
  ): Promise<SkillInstance> {
    const locator = makeLocator(candidate, this.options.workspaceRoot);
    const skillId = createSkillId(locator);
    const skillFile = path.join(candidate.realPath, "SKILL.md");
    try {
      const fileStat = await stat(skillFile);
      const maxBytes = this.options.maxSkillBytes ?? 256 * 1024;
      if (fileStat.size > maxBytes) {
        return invalidInstance(skillId, locator, candidate.root.priority, {
          code: "instruction_too_large",
          message: `SKILL.md exceeds the ${maxBytes} byte limit.`,
          path: skillFile,
        });
      }
      let cached = this.cache.get(skillFile);
      const openAiPath = path.join(candidate.realPath, "agents", "openai.yaml");
      const openAiStat = await stat(openAiPath).catch(() => undefined);
      if (
        !cached ||
        cached.mtimeMs !== fileStat.mtimeMs ||
        cached.size !== fileStat.size ||
        cached.openAiMtimeMs !== openAiStat?.mtimeMs ||
        cached.openAiSize !== openAiStat?.size
      ) {
        metrics.parsedSkillCount += 1;
        const content = await readFile(skillFile, "utf8");
        const parsed = await parseSkillMetadata(content, candidate.realPath);
        cached = {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          openAiMtimeMs: openAiStat?.mtimeMs,
          openAiSize: openAiStat?.size,
          content,
          contentHash: sha256(content),
          metadata: parsed.metadata,
          diagnostics: parsed.diagnostics,
        };
        this.cache.set(skillFile, cached);
      } else {
        metrics.cacheHitCount += 1;
      }
      if (!cached.metadata) {
        return invalidInstance(skillId, locator, candidate.root.priority, ...cached.diagnostics);
      }
      return {
        skillId,
        locator,
        metadata: cached.metadata,
        nameKey: normalizeName(cached.metadata.name),
        contentHash: cached.contentHash,
        enabled: true,
        validity: "valid",
        resolution: "ineligible",
        priority: candidate.root.priority,
        diagnostics: cached.diagnostics,
      };
    } catch (error) {
      return invalidInstance(skillId, locator, candidate.root.priority, {
        code: "skill_unreadable",
        message: "Skill could not be read.",
        path: skillFile,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resetWatchers(roots: readonly SkillRoot[], instances: readonly SkillInstance[]): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    const targets = new Set([
      ...roots.map((root) => root.path),
      ...instances.map((instance) => instance.locator.path),
    ]);
    for (const target of targets) {
      if (!existsSync(target)) continue;
      try {
        this.watchers.push(
          watch(target, () => {
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => void this.refresh(), 150);
          }),
        );
      } catch {
        // A root can disappear between scan and watcher registration; the next manual refresh recovers it.
      }
    }
  }
}

export interface ExplicitSkillInvocationResult {
  prompt: string;
  skillIds: readonly string[];
  errors: readonly string[];
}

export function parseExplicitSkillInvocations(
  prompt: string,
  snapshot: SkillSnapshot,
  reservedSlashCommands: ReadonlySet<string> = new Set(),
): ExplicitSkillInvocationResult {
  const skillIds = new Set<string>();
  const errors: string[] = [];
  let taskPrompt = prompt;
  const slash = /^\/([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?)\b\s*/.exec(prompt);
  if (slash?.[1]) {
    const token = slash[1];
    const [qualifier, qualifiedName] = splitQualifiedName(token);
    const commandName = qualifiedName ?? qualifier;
    if (!reservedSlashCommands.has(commandName.toLocaleLowerCase()) || qualifier === "skill") {
      const instance = resolveToken(snapshot, token);
      if (instance) {
        skillIds.add(instance.skillId);
        taskPrompt = prompt.slice(slash[0].length).trim();
      } else {
        errors.push(describeUnavailableSkill(snapshot, token));
      }
    }
  }

  const mentionPattern = /\$([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?)/g;
  for (const match of prompt.matchAll(mentionPattern)) {
    const token = match[1];
    if (!token) continue;
    const instance = resolveToken(snapshot, token);
    if (instance) skillIds.add(instance.skillId);
    else errors.push(describeUnavailableSkill(snapshot, token));
  }
  return { prompt: taskPrompt || prompt, skillIds: [...skillIds], errors };
}

export function renderSkillCatalog(
  entries: readonly SkillCatalogEntry[],
  maxChars = 8_000,
): string {
  if (!entries.length || maxChars <= 0) return "";
  const open = "<available_skills>\n";
  const close = "\n</available_skills>";
  const warning =
    "\n  <warning>Some skills were omitted to stay within the catalog budget.</warning>";
  const rendered: string[] = [];
  let omitted = false;
  for (const entry of entries) {
    let description = entry.description;
    let line = renderCatalogEntry(entry, description);
    const available = maxChars - open.length - close.length - rendered.join("\n").length - 1;
    if (line.length > available) {
      const fixedLength = line.length - description.length;
      const descriptionBudget = Math.max(0, available - fixedLength - warning.length - 1);
      if (descriptionBudget >= 24) {
        description = `${description.slice(0, Math.max(0, descriptionBudget - 1)).trimEnd()}…`;
        line = renderCatalogEntry(entry, description);
      }
    }
    const body = [...rendered, line].join("\n");
    if (open.length + body.length + close.length > maxChars) {
      omitted = true;
      break;
    }
    rendered.push(line);
  }
  if (!rendered.length) return "";
  let body = rendered.join("\n");
  if (omitted && open.length + body.length + warning.length + close.length <= maxChars) body += warning;
  return `${open}${body}${close}`;
}

export function renderSkillContent(instance: SkillInstance, content: string): string {
  if (!instance.metadata) throw new SkillRegistryError("skill_invalid", "Skill metadata is missing.");
  const attributes = [
    `id="${escapeXml(instance.skillId)}"`,
    `name="${escapeXml(instance.metadata.name)}"`,
    `source="${instance.locator.source}"`,
    `path="${escapeXml(path.join(instance.locator.path, "SKILL.md"))}"`,
    ...(instance.metadata.version ? [`version="${escapeXml(instance.metadata.version)}"`] : []),
  ].join(" ");
  const safeContent = content.replace(/<\/skill_content>/gi, "&lt;/skill_content&gt;");
  return `<skill_content ${attributes}>\n${safeContent}\n</skill_content>`;
}

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

export interface ManagedSkillInstallationStore {
  listInstallations(): readonly ManagedSkillInstallation[];
  getInstallation(skillId: string): ManagedSkillInstallation | undefined;
  saveInstallation(installation: ManagedSkillInstallation): Promise<void>;
  deleteInstallation(skillId: string): Promise<void>;
}

export interface SkillLifecycleConfirmations {
  overwrite?: boolean;
  downgrade?: boolean;
  sourceChange?: boolean;
  localChanges?: boolean;
  sameVersionContentChange?: boolean;
}

export type SkillLifecycleConflict =
  | "destination_exists"
  | "downgrade"
  | "source_changed"
  | "local_changes"
  | "same_version_content_changed";

export class SkillLifecycleError extends Error {
  constructor(
    readonly code:
      | "source_invalid"
      | "package_unsafe"
      | "package_limit_exceeded"
      | "git_failed"
      | "install_conflict"
      | "installation_not_found"
      | "rollback_unavailable"
      | "managed_path_invalid",
    message: string,
    readonly conflicts: readonly SkillLifecycleConflict[] = [],
  ) {
    super(message);
    this.name = "SkillLifecycleError";
  }
}

export interface InstallManagedSkillInput {
  source: ManagedSkillSource;
  scope: "user" | "project";
  workspaceRoot: string;
  dreamCodeHome: string;
  store: ManagedSkillInstallationStore;
  confirmations?: SkillLifecycleConfirmations;
}

export async function installManagedSkill(
  input: InstallManagedSkillInput,
): Promise<ManagedSkillInstallation> {
  return stageAndInstall(input);
}

export async function updateManagedSkill(input: {
  skillId: string;
  workspaceRoot: string;
  dreamCodeHome: string;
  store: ManagedSkillInstallationStore;
  confirmations?: SkillLifecycleConfirmations;
}): Promise<ManagedSkillInstallation> {
  const installation = input.store.getInstallation(input.skillId);
  if (!installation) {
    throw new SkillLifecycleError("installation_not_found", `Managed Skill not found: ${input.skillId}`);
  }
  return stageAndInstall(
    {
      source: installation.source,
      scope: installation.scope,
      workspaceRoot: input.workspaceRoot,
      dreamCodeHome: input.dreamCodeHome,
      store: input.store,
      confirmations: input.confirmations,
    },
    installation,
  );
}

export async function rollbackManagedSkill(input: {
  skillId: string;
  workspaceRoot: string;
  dreamCodeHome: string;
  store: ManagedSkillInstallationStore;
}): Promise<ManagedSkillInstallation> {
  const installation = input.store.getInstallation(input.skillId);
  if (!installation) {
    throw new SkillLifecycleError("installation_not_found", `Managed Skill not found: ${input.skillId}`);
  }
  const previous = installation.previous;
  if (!previous || !existsSync(previous.backupPath)) {
    throw new SkillLifecycleError("rollback_unavailable", "No previous Skill version is available.");
  }
  assertManagedPath(installation.path, installation.scope, input.workspaceRoot, input.dreamCodeHome);
  const parent = path.dirname(installation.path);
  const currentTemporary = await mkdtemp(path.join(parent, ".dreamcode-skill-rollback-"));
  const currentBackup = path.join(currentTemporary, "current");
  const rolledBackTemporary = path.join(currentTemporary, "rolled-back");
  try {
    await rename(installation.path, currentBackup);
    await rename(previous.backupPath, installation.path);
    await mkdir(path.dirname(previous.backupPath), { recursive: true });
    await rename(currentBackup, previous.backupPath);
    const next: ManagedSkillInstallation = {
      ...installation,
      version: previous.version,
      revision: previous.revision,
      contentHash: previous.contentHash,
      installedAt: new Date().toISOString(),
      previous: {
        backupPath: previous.backupPath,
        version: installation.version,
        revision: installation.revision,
        contentHash: installation.contentHash,
      },
    };
    try {
      await input.store.saveInstallation(next);
    } catch (error) {
      await rename(installation.path, rolledBackTemporary).catch(() => undefined);
      await rename(previous.backupPath, installation.path).catch(() => undefined);
      await rename(rolledBackTemporary, previous.backupPath).catch(() => undefined);
      throw error;
    }
    return next;
  } catch (error) {
    if (!existsSync(installation.path) && existsSync(currentBackup)) {
      await rename(currentBackup, installation.path).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(currentTemporary, { recursive: true, force: true });
  }
}

export async function uninstallManagedSkill(input: {
  skillId: string;
  workspaceRoot: string;
  dreamCodeHome: string;
  store: ManagedSkillInstallationStore;
}): Promise<void> {
  const installation = input.store.getInstallation(input.skillId);
  if (!installation) {
    throw new SkillLifecycleError("installation_not_found", `Managed Skill not found: ${input.skillId}`);
  }
  assertManagedPath(installation.path, installation.scope, input.workspaceRoot, input.dreamCodeHome);
  const parent = path.dirname(installation.path);
  const removalRoot = await mkdtemp(path.join(parent, ".dreamcode-skill-uninstall-"));
  const stagedInstallation = path.join(removalRoot, "installation");
  const stagedPrevious = path.join(removalRoot, "previous");
  let movedInstallation = false;
  let movedPrevious = false;
  try {
    if (existsSync(installation.path)) {
      await rename(installation.path, stagedInstallation);
      movedInstallation = true;
    }
    if (installation.previous?.backupPath && existsSync(installation.previous.backupPath)) {
      assertManagedPath(
        installation.previous.backupPath,
        installation.scope,
        input.workspaceRoot,
        input.dreamCodeHome,
      );
      await rename(installation.previous.backupPath, stagedPrevious);
      movedPrevious = true;
    }
    await input.store.deleteInstallation(input.skillId);
  } catch (error) {
    if (movedInstallation && existsSync(stagedInstallation)) {
      await rename(stagedInstallation, installation.path).catch(() => undefined);
    }
    if (movedPrevious && installation.previous && existsSync(stagedPrevious)) {
      await mkdir(path.dirname(installation.previous.backupPath), { recursive: true });
      await rename(stagedPrevious, installation.previous.backupPath).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(removalRoot, { recursive: true, force: true });
  }
}

async function stageAndInstall(
  input: InstallManagedSkillInput,
  expectedInstallation?: ManagedSkillInstallation,
): Promise<ManagedSkillInstallation> {
  const destinationRoot =
    input.scope === "user"
      ? path.join(path.resolve(input.dreamCodeHome), "skills")
      : path.join(path.resolve(input.workspaceRoot), ".dreamcode", "skills");
  await mkdir(destinationRoot, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(destinationRoot, ".dreamcode-skill-stage-"));
  try {
    const stagedSource = await materializeManagedSource(input.source, stagingRoot);
    const sourceSkillRoot = await locateSingleSkillRoot(stagedSource);
    const payload = path.join(stagingRoot, "payload");
    await cp(sourceSkillRoot, payload, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => path.basename(source) !== ".git",
    });
    const inspected = await inspectSkillPackage(payload);
    const safeName = safeSkillDirectoryName(inspected.metadata.name);
    const destination = expectedInstallation?.path ?? path.join(destinationRoot, safeName);
    assertManagedPath(destination, input.scope, input.workspaceRoot, input.dreamCodeHome);
    const existing =
      expectedInstallation ??
      input.store.listInstallations().find((installation) => samePath(installation.path, destination));
    const conflicts = await installationConflicts(
      destination,
      existing,
      input.source,
      inspected.metadata.version,
      inspected.contentHash,
    );
    assertLifecycleConfirmations(conflicts, input.confirmations);

    const backupRoot = path.join(destinationRoot, ".dreamcode-skill-backups");
    const backupPath = path.join(backupRoot, `${safeName}.previous`);
    const stagedCurrent = path.join(stagingRoot, "current-installation");
    const stagedPrevious = path.join(stagingRoot, "previous-rollback");
    let previous: ManagedSkillPreviousVersion | undefined;
    try {
      if (existsSync(destination)) {
        await mkdir(backupRoot, { recursive: true });
        const previousHash = existing?.contentHash ?? (await hashSkillDirectory(destination));
        if (existsSync(backupPath)) await rename(backupPath, stagedPrevious);
        await rename(destination, stagedCurrent);
        previous = {
          backupPath,
          version: existing?.version,
          revision: existing?.revision,
          contentHash: previousHash,
        };
      }
      await rename(payload, destination);
      if (previous) await rename(stagedCurrent, backupPath);

      const realDestination = await realpath(destination);
      const locator: SkillLocator = {
        source: input.scope,
        provider: "dreamcode",
        path: destination,
        realPath: realDestination,
        projectRelativePath:
          input.scope === "project" ? path.relative(input.workspaceRoot, destination) : undefined,
      };
      const installation: ManagedSkillInstallation = {
        skillId: createSkillId(locator),
        name: inspected.metadata.name,
        path: destination,
        scope: input.scope,
        source: input.source,
        version: inspected.metadata.version,
        revision: stagedSource.revision,
        contentHash: inspected.contentHash,
        installedAt: new Date().toISOString(),
        previous,
      };
      await input.store.saveInstallation(installation);
      if (existing && existing.skillId !== installation.skillId) {
        await input.store.deleteInstallation(existing.skillId);
      }
      return installation;
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      if (existsSync(backupPath)) await rename(backupPath, destination).catch(() => undefined);
      else if (existsSync(stagedCurrent)) await rename(stagedCurrent, destination).catch(() => undefined);
      if (existsSync(stagedPrevious)) await rename(stagedPrevious, backupPath).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function materializeManagedSource(
  source: ManagedSkillSource,
  stagingRoot: string,
): Promise<{ path: string; revision?: string }> {
  if (source.type === "directory") {
    const root = path.resolve(source.location);
    const selected = resolveSourceSubpath(root, source.subpath);
    if (!existsSync(selected)) {
      throw new SkillLifecycleError("source_invalid", `Skill source does not exist: ${selected}`);
    }
    return { path: selected };
  }
  if (source.type === "zip") {
    const archivePath = path.resolve(source.location);
    const archiveStat = await stat(archivePath).catch(() => undefined);
    if (!archiveStat?.isFile()) {
      throw new SkillLifecycleError("source_invalid", `Skill ZIP does not exist: ${archivePath}`);
    }
    if (archiveStat.size > 20 * 1024 * 1024) {
      throw new SkillLifecycleError("package_limit_exceeded", "Compressed Skill ZIP exceeds 20 MiB.");
    }
    const extractedRoot = path.join(stagingRoot, "extracted");
    await extractSafeZip(await readFile(archivePath), extractedRoot);
    return { path: resolveSourceSubpath(extractedRoot, source.subpath) };
  }

  const repository = path.join(stagingRoot, "repository");
  const cloneArgs = ["clone", "--depth", "1"];
  if (source.ref) cloneArgs.push("--branch", source.ref);
  cloneArgs.push("--", source.location, repository);
  await runGit(cloneArgs);
  const revision = (await runGit(["-C", repository, "rev-parse", "HEAD"])).trim();
  return { path: resolveSourceSubpath(repository, source.subpath), revision };
}

function resolveSourceSubpath(root: string, subpath: string | undefined): string {
  const selected = path.resolve(root, subpath ?? ".");
  if (!isInsidePath(root, selected)) {
    throw new SkillLifecycleError("source_invalid", "Skill source subpath escapes its source root.");
  }
  return selected;
}

async function locateSingleSkillRoot(sourceRoot: { path: string }): Promise<string> {
  if (existsSync(path.join(sourceRoot.path, "SKILL.md"))) return sourceRoot.path;
  const children = await childDirectories(sourceRoot.path).catch(() => []);
  const skills = children.filter((child) => existsSync(path.join(child, "SKILL.md")));
  if (skills.length !== 1) {
    throw new SkillLifecycleError(
      "source_invalid",
      "A managed source must contain one SKILL.md at its root or in exactly one direct child.",
    );
  }
  return skills[0]!;
}

async function inspectSkillPackage(
  skillRoot: string,
): Promise<{ metadata: SkillMetadata; contentHash: string }> {
  const summary = await inspectPackageTree(skillRoot);
  const content = await readFile(path.join(skillRoot, "SKILL.md"), "utf8").catch(() => undefined);
  if (content === undefined) {
    throw new SkillLifecycleError("source_invalid", "Managed Skill source has no SKILL.md.");
  }
  if (Buffer.byteLength(content) > 256 * 1024) {
    throw new SkillLifecycleError("package_limit_exceeded", "SKILL.md exceeds 256 KiB.");
  }
  const parsed = await parseSkillMetadata(content, skillRoot);
  if (!parsed.metadata) {
    throw new SkillLifecycleError(
      "source_invalid",
      parsed.diagnostics.map((diagnostic) => diagnostic.message).join(" ") || "Skill metadata is invalid.",
    );
  }
  return { metadata: parsed.metadata, contentHash: summary.contentHash };
}

async function inspectPackageTree(
  root: string,
): Promise<{ contentHash: string; fileCount: number; totalBytes: number }> {
  const hash = createHash("sha256");
  const visitedDirectories = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (current: string): Promise<void> => {
    const currentReal = await realpath(current);
    if (!isInsidePath(root, currentReal)) {
      throw new SkillLifecycleError("package_unsafe", "Skill package contains a path outside its root.");
    }
    const info = await lstat(current);
    const relative = normalizePortablePath(path.relative(root, current));
    if (info.isSymbolicLink()) {
      const target = await realpath(current);
      if (!isInsidePath(root, target)) {
        throw new SkillLifecycleError("package_unsafe", `Skill symlink escapes its root: ${relative}`);
      }
      fileCount += 1;
      hash.update(`link:${relative}:${await readlink(current)}\n`);
      return;
    }
    if (info.isDirectory()) {
      if (visitedDirectories.has(currentReal)) return;
      visitedDirectories.add(currentReal);
      const entries = await readdir(current);
      entries.sort();
      for (const entry of entries) await visit(path.join(current, entry));
      return;
    }
    if (!info.isFile()) {
      throw new SkillLifecycleError("package_unsafe", `Skill package contains a non-regular file: ${relative}`);
    }
    fileCount += 1;
    totalBytes += info.size;
    if (fileCount > 1_000 || totalBytes > 50 * 1024 * 1024 || info.size > 10 * 1024 * 1024) {
      throw new SkillLifecycleError("package_limit_exceeded", "Skill package exceeds file count or size limits.");
    }
    hash.update(`file:${relative}:${info.size}\n`);
    hash.update(await readFile(current));
  };
  await visit(root);
  return { contentHash: hash.digest("hex"), fileCount, totalBytes };
}

async function hashSkillDirectory(root: string): Promise<string> {
  return (await inspectPackageTree(root)).contentHash;
}

async function extractSafeZip(buffer: Buffer, destination: string): Promise<void> {
  const declaredEntries = inspectZipCentralDirectory(buffer);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buffer);
  } catch (error) {
    throw new SkillLifecycleError(
      "source_invalid",
      `Skill ZIP could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = Object.entries(files);
  let totalBytes = 0;
  if (
    entries.filter(([name]) => !name.endsWith("/")).length !==
    declaredEntries.filter((entry) => !entry.directory).length
  ) {
    throw new SkillLifecycleError("package_unsafe", "Skill ZIP directory metadata does not match its payload.");
  }
  await mkdir(destination, { recursive: true });
  for (const [entryName, data] of entries) {
    const normalized = entryName.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").some((segment) => segment === "..")
    ) {
      throw new SkillLifecycleError("package_unsafe", `Unsafe ZIP entry: ${entryName}`);
    }
    if (entryName.endsWith("/")) continue;
    totalBytes += data.byteLength;
    if (data.byteLength > 10 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) {
      throw new SkillLifecycleError("package_limit_exceeded", "Skill ZIP exceeds expanded size limits.");
    }
    const target = path.resolve(destination, normalized);
    if (!isInsidePath(destination, target)) {
      throw new SkillLifecycleError("package_unsafe", `Unsafe ZIP entry: ${entryName}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

interface DeclaredZipEntry {
  name: string;
  directory: boolean;
  uncompressedSize: number;
}

function inspectZipCentralDirectory(buffer: Buffer): DeclaredZipEntry[] {
  const minimumEocdSize = 22;
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + minimumEocdSize > buffer.length) {
    throw new SkillLifecycleError("source_invalid", "Skill ZIP has no valid central directory.");
  }
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entryCount === 0xffff) {
    throw new SkillLifecycleError("package_unsafe", "Multi-disk and ZIP64 Skill archives are not supported.");
  }
  if (entryCount > 1_000) {
    throw new SkillLifecycleError("package_limit_exceeded", "Skill ZIP contains more than 1000 entries.");
  }
  if (centralOffset + centralSize > eocd || centralOffset > buffer.length) {
    throw new SkillLifecycleError("package_unsafe", "Skill ZIP central directory is outside the archive.");
  }
  const entries: DeclaredZipEntry[] = [];
  let totalBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new SkillLifecycleError("package_unsafe", "Skill ZIP central directory is malformed.");
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const hostSystem = versionMadeBy >>> 8;
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > buffer.length) {
      throw new SkillLifecycleError("package_unsafe", "Skill ZIP entry metadata exceeds the archive.");
    }
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const directory = name.endsWith("/");
    if (hostSystem === 3) {
      const unixType = (externalAttributes >>> 16) & 0xf000;
      if (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) {
        throw new SkillLifecycleError("package_unsafe", `Skill ZIP contains an unsafe special entry: ${name}`);
      }
    }
    if (!directory) {
      totalBytes += uncompressedSize;
      if (uncompressedSize > 10 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) {
        throw new SkillLifecycleError("package_limit_exceeded", "Skill ZIP exceeds expanded size limits.");
      }
    }
    entries.push({ name, directory, uncompressedSize });
    offset = entryEnd;
  }
  if (offset !== centralOffset + centralSize) {
    throw new SkillLifecycleError("package_unsafe", "Skill ZIP central directory size is inconsistent.");
  }
  return entries;
}

async function installationConflicts(
  destination: string,
  existing: ManagedSkillInstallation | undefined,
  source: ManagedSkillSource,
  nextVersion: string | undefined,
  nextHash: string,
): Promise<SkillLifecycleConflict[]> {
  if (!existsSync(destination)) return [];
  const conflicts = new Set<SkillLifecycleConflict>(["destination_exists"]);
  if (!existing) return [...conflicts];
  const actualHash = await hashSkillDirectory(destination);
  if (actualHash !== existing.contentHash) conflicts.add("local_changes");
  if (JSON.stringify(existing.source) !== JSON.stringify(source)) conflicts.add("source_changed");
  if (existing.version && nextVersion) {
    const comparison = compareSemver(nextVersion, existing.version);
    if (comparison !== undefined && comparison < 0) conflicts.add("downgrade");
    if (
      (nextVersion === existing.version || comparison === 0) &&
      nextHash !== existing.contentHash
    ) {
      conflicts.add("same_version_content_changed");
    }
  }
  return [...conflicts];
}

function assertLifecycleConfirmations(
  conflicts: readonly SkillLifecycleConflict[],
  confirmations: SkillLifecycleConfirmations | undefined,
): void {
  const missing = conflicts.filter((conflict) => {
    if (conflict === "destination_exists") return !confirmations?.overwrite;
    if (conflict === "downgrade") return !confirmations?.downgrade;
    if (conflict === "source_changed") return !confirmations?.sourceChange;
    if (conflict === "local_changes") return !confirmations?.localChanges;
    return !confirmations?.sameVersionContentChange;
  });
  if (missing.length) {
    throw new SkillLifecycleError(
      "install_conflict",
      `Skill installation requires confirmation: ${missing.join(", ")}`,
      missing,
    );
  }
}

function assertManagedPath(
  target: string,
  scope: "user" | "project",
  workspaceRoot: string,
  dreamCodeHome: string,
): void {
  const expectedRoot =
    scope === "user"
      ? path.join(path.resolve(dreamCodeHome), "skills")
      : path.join(path.resolve(workspaceRoot), ".dreamcode", "skills");
  if (!isInsidePath(expectedRoot, target) || samePath(expectedRoot, target)) {
    throw new SkillLifecycleError("managed_path_invalid", "Managed Skill path is outside its owned root.");
  }
}

function safeSkillDirectoryName(name: string): string {
  const safe = name
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!safe || safe === "." || safe === "..") {
    throw new SkillLifecycleError("source_invalid", "Skill name cannot form a safe directory name.");
  }
  return safe;
}

function compareSemver(left: string, right: string): number | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! - b.core[index]!;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function parseSemver(value: string): { core: [number, number, number]; prerelease: string[] } | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

async function runGit(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(new SkillLifecycleError("git_failed", `Git could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new SkillLifecycleError("git_failed", `Git failed (${code ?? "unknown"}): ${stderr.trim()}`));
    });
  });
}

async function buildSkillRoots(options: SkillRegistryOptions): Promise<SkillRoot[]> {
  const userHome = options.userHome ?? os.homedir();
  const dreamCodeHome = options.dreamCodeHome ?? path.join(userHome, ".dreamcode");
  const roots: SkillRoot[] = [];
  for (const [index, rootPath] of (options.builtInRoots ?? []).entries()) {
    roots.push({ path: rootPath, source: "built_in", provider: "dreamcode", priority: 1_000 - index });
  }
  const systemRoots = options.systemRoots ?? defaultSystemRoots();
  for (const [index, rootPath] of systemRoots.entries()) {
    roots.push({ path: rootPath, source: "system", provider: "system", priority: 2_000 - index });
  }
  const userRoots: Array<[string, string, number]> = [
    [path.join(dreamCodeHome, "skills"), "dreamcode", 40],
    [path.join(userHome, ".agents", "skills"), "agents", 30],
    [path.join(userHome, ".claude", "skills"), "claude", 20],
    [path.join(userHome, ".codex", "skills"), "codex", 10],
  ];
  for (const [rootPath, provider, rank] of userRoots) {
    roots.push({ path: rootPath, source: "user", provider, priority: 4_000 + rank });
  }
  for (const [index, rootPath] of (options.customRoots ?? []).entries()) {
    roots.push({ path: rootPath, source: "user", provider: "custom", priority: 4_000 - index });
  }

  const workingDirectory = path.resolve(options.workingDirectory ?? options.workspaceRoot);
  const repoRoot = findRepositoryRoot(workingDirectory);
  const projectDirectories = ancestorsToRoot(workingDirectory, repoRoot);
  for (const [distance, directory] of projectDirectories.entries()) {
    const distanceRank = (projectDirectories.length - distance) * 100;
    roots.push(
      { path: path.join(directory, ".dreamcode", "skills"), source: "project", provider: "dreamcode", priority: 5_000 + distanceRank + 30, projectRoot: repoRoot },
      { path: path.join(directory, ".agents", "skills"), source: "project", provider: "agents", priority: 5_000 + distanceRank + 20, projectRoot: repoRoot },
      { path: path.join(directory, ".claude", "skills"), source: "project", provider: "claude", priority: 5_000 + distanceRank + 10, projectRoot: repoRoot },
    );
  }

  for (const provider of options.pluginProviders ?? []) {
    const pluginRoots = await provider.listSkillRoots();
    for (const [index, root] of pluginRoots.entries()) {
      roots.push({
        path: root.path,
        source: "plugin",
        provider: root.provider ?? "plugin",
        pluginId: root.pluginId,
        pluginDisplayName: root.displayName,
        pluginVersion: root.version,
        pluginManagementAction: root.managementAction,
        priority: 3_000 + (root.priority ?? -index),
      });
    }
  }
  return roots;
}

function defaultSystemRoots(): string[] {
  if (process.platform === "win32") {
    const programData = process.env.PROGRAMDATA;
    return programData ? [path.join(programData, "DreamCode", "skills")] : [];
  }
  if (process.platform === "darwin") {
    return ["/Library/Application Support/DreamCode/skills", "/etc/codex/skills"];
  }
  return ["/etc/dreamcode/skills", "/etc/codex/skills"];
}

function findRepositoryRoot(start: string): string {
  let current = start;
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function ancestorsToRoot(start: string, root: string): string[] {
  const result: string[] = [];
  let current = start;
  while (true) {
    result.push(current);
    if (samePath(current, root)) return result;
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

async function discoverCandidates(
  roots: readonly SkillRoot[],
  diagnostics: SkillDiagnostic[],
): Promise<ScannedCandidate[]> {
  const candidates = new Map<string, ScannedCandidate>();
  for (const root of [...roots].sort((left, right) => right.priority - left.priority)) {
    if (!existsSync(root.path)) continue;
    try {
      const rootStat = await stat(root.path);
      if (!rootStat.isDirectory()) continue;
      const paths = existsSync(path.join(root.path, "SKILL.md"))
        ? [root.path]
        : await childDirectories(root.path);
      for (const candidatePath of paths) {
        if (!existsSync(path.join(candidatePath, "SKILL.md"))) continue;
        const resolved = await realpath(candidatePath);
        const key = pathKey(resolved);
        if (candidates.has(key)) {
          diagnostics.push({
            code: "duplicate_path",
            message: "Skill path was discovered from more than one root; the higher-priority root won.",
            path: candidatePath,
          });
          continue;
        }
        candidates.set(key, { root, path: candidatePath, realPath: resolved });
      }
    } catch (error) {
      diagnostics.push({
        code: "root_unreadable",
        message: "Skill root could not be scanned.",
        path: root.path,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return [...candidates.values()];
}

async function childDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const directories: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) directories.push(target);
    else if (entry.isSymbolicLink()) {
      try {
        if ((await stat(target)).isDirectory()) directories.push(target);
      } catch {
        // Broken links are ignored as candidates and remain visible through root diagnostics only.
      }
    }
  }
  return directories;
}

function makeLocator(candidate: ScannedCandidate, workspaceRoot: string): SkillLocator {
  const projectRoot = candidate.root.projectRoot ?? workspaceRoot;
  return {
    source: candidate.root.source,
    provider: candidate.root.provider,
    path: path.resolve(candidate.path),
    realPath: candidate.realPath,
    projectRelativePath:
      candidate.root.source === "project" ? path.relative(projectRoot, candidate.path) : undefined,
    pluginRelativePath:
      candidate.root.source === "plugin" ? path.relative(candidate.root.path, candidate.path) : undefined,
    pluginId: candidate.root.pluginId,
    pluginDisplayName: candidate.root.pluginDisplayName,
    pluginVersion: candidate.root.pluginVersion,
    pluginManagementAction: candidate.root.pluginManagementAction,
  };
}

async function parseSkillMetadata(
  content: string,
  skillRoot: string,
): Promise<{ metadata?: SkillMetadata; diagnostics: readonly SkillDiagnostic[] }> {
  const skillFile = path.join(skillRoot, "SKILL.md");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(content);
  if (!match?.[1]) {
    return {
      diagnostics: [{ code: "metadata_missing", message: "SKILL.md must begin with YAML frontmatter containing name and description.", path: skillFile }],
    };
  }
  const parsed = parseYamlObject(match[1], skillFile);
  if (!parsed.value) return { diagnostics: parsed.diagnostics };
  const name = stringValue(parsed.value.name);
  const description = stringValue(parsed.value.description);
  const diagnostics = [...parsed.diagnostics];
  if (!name || !description) {
    diagnostics.push({ code: "metadata_missing", message: "Skill metadata requires non-empty name and description.", path: skillFile });
    return { diagnostics };
  }
  if (name.length > 64 || description.length > 1_024) {
    diagnostics.push({ code: "metadata_invalid", message: "Skill name must be at most 64 characters and description at most 1024 characters.", path: skillFile });
    return { diagnostics };
  }
  const openAi = await readOpenAiMetadata(skillRoot);
  diagnostics.push(...openAi.diagnostics);
  const capabilities = normalizeCapabilities(parsed.value.capabilities, openAi.value?.dependencies);
  const metadata: SkillMetadata = {
    name,
    description,
    version: stringValue(parsed.value.version),
    allowImplicitInvocation: openAi.value?.allowImplicitInvocation ?? booleanValue(parsed.value.allow_implicit_invocation) ?? true,
    capabilities,
    display: openAi.value?.display,
    extensions: Object.freeze({ frontmatter: parsed.value, ...(openAi.raw ? { openai: openAi.raw } : {}) }),
  };
  return { metadata, diagnostics };
}

async function readOpenAiMetadata(skillRoot: string): Promise<{
  value?: {
    allowImplicitInvocation?: boolean;
    display?: SkillMetadata["display"];
    dependencies?: unknown;
  };
  raw?: Record<string, unknown>;
  diagnostics: SkillDiagnostic[];
}> {
  const metadataPath = path.join(skillRoot, "agents", "openai.yaml");
  if (!existsSync(metadataPath)) return { diagnostics: [] };
  try {
    const parsed = parseYamlObject(await readFile(metadataPath, "utf8"), metadataPath);
    if (!parsed.value) return { diagnostics: [...parsed.diagnostics] };
    const interfaceValue = objectValue(parsed.value.interface);
    const policy = objectValue(parsed.value.policy);
    return {
      raw: parsed.value,
      diagnostics: [...parsed.diagnostics],
      value: {
        allowImplicitInvocation: booleanValue(policy?.allow_implicit_invocation),
        dependencies: parsed.value.dependencies,
        display: interfaceValue
          ? {
              name: stringValue(interfaceValue.display_name),
              shortDescription: stringValue(interfaceValue.short_description),
              iconSmall: stringValue(interfaceValue.icon_small),
              iconLarge: stringValue(interfaceValue.icon_large),
              brandColor: stringValue(interfaceValue.brand_color),
              defaultPrompt: stringValue(interfaceValue.default_prompt),
            }
          : undefined,
      },
    };
  } catch (error) {
    return {
      diagnostics: [{ code: "metadata_invalid", message: "agents/openai.yaml could not be read.", path: metadataPath, detail: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function parseYamlObject(
  source: string,
  sourcePath: string,
): { value?: Record<string, unknown>; diagnostics: SkillDiagnostic[] } {
  const document = parseDocument(source, { schema: "core", customTags: [] });
  if (document.errors.length) {
    return {
      diagnostics: document.errors.map((error) => ({ code: "metadata_invalid", message: "YAML metadata is invalid.", path: sourcePath, detail: error.message })),
    };
  }
  try {
    const value = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { diagnostics: [{ code: "metadata_invalid", message: "YAML metadata must be an object.", path: sourcePath }] };
    }
    return { value: value as Record<string, unknown>, diagnostics: [] };
  } catch (error) {
    return { diagnostics: [{ code: "metadata_invalid", message: "YAML aliases are not allowed in Skill metadata.", path: sourcePath, detail: error instanceof Error ? error.message : String(error) }] };
  }
}

function normalizeCapabilities(frontmatter: unknown, dependencies: unknown): readonly SkillCapability[] {
  const result = new Set<SkillCapability>();
  const values = Array.isArray(frontmatter) ? frontmatter : [];
  for (const value of values) {
    if (isSkillCapability(value)) result.add(value);
  }
  const dependencyObject = objectValue(dependencies);
  const tools = dependencyObject?.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const entry = objectValue(tool);
      if (entry?.type === "mcp") result.add("mcp.use");
    }
  }
  return Object.freeze([...result]);
}

function isSkillCapability(value: unknown): value is SkillCapability {
  return ["filesystem.read", "filesystem.write", "process.execute", "network.access", "mcp.use"].includes(String(value));
}

async function applyEnablement(
  instances: SkillInstance[],
  state: SkillStateProvider | undefined,
): Promise<void> {
  if (!state) return;
  for (const instance of instances) instance.enabled = (await state.isEnabled(instance.locator)) ?? true;
}

function resolveInstances(instances: SkillInstance[], diagnostics: SkillDiagnostic[]): void {
  const groups = new Map<string, SkillInstance[]>();
  for (const instance of instances) {
    if (instance.validity !== "valid" || !instance.enabled || !instance.nameKey) {
      instance.resolution = "ineligible";
      continue;
    }
    const group = groups.get(instance.nameKey) ?? [];
    group.push(instance);
    groups.set(instance.nameKey, group);
  }
  for (const group of groups.values()) {
    group.sort(compareInstances);
    const winner = group[0];
    if (!winner) continue;
    const tied = group.filter((instance) => instance.priority === winner.priority);
    if (tied.length > 1) {
      for (const instance of tied) instance.resolution = "conflicted";
      for (const instance of group.slice(tied.length)) instance.resolution = "overridden";
      diagnostics.push({ code: "name_conflict", message: `No unique Skill could be selected for ${winner.metadata?.name ?? winner.nameKey}.`, path: winner.locator.path });
      continue;
    }
    winner.resolution = "resolved";
    for (const instance of group.slice(1)) instance.resolution = "overridden";
  }
}

function freezeInstances(instances: SkillInstance[]): readonly SkillInstance[] {
  return Object.freeze(instances.map((instance) => Object.freeze({ ...instance, diagnostics: Object.freeze([...instance.diagnostics]) })));
}

function compareInstances(left: SkillInstance, right: SkillInstance): number {
  return right.priority - left.priority || left.skillId.localeCompare(right.skillId);
}

function invalidInstance(
  skillId: string,
  locator: SkillLocator,
  priority: number,
  ...diagnostics: SkillDiagnostic[]
): SkillInstance {
  return { skillId, locator, enabled: true, validity: "invalid", resolution: "ineligible", priority, diagnostics };
}

async function readSkillResource(
  instance: SkillInstance,
  resourcePath: string,
  requestedMaxBytes: number,
): Promise<SkillResourceContent> {
  const maxBytes = Math.min(Math.max(1, Math.trunc(requestedMaxBytes)), 200_000);
  const target = path.resolve(instance.locator.realPath, resourcePath);
  if (!isInsidePath(instance.locator.realPath, target)) {
    throw new SkillRegistryError("resource_outside_skill", "Refused to read outside the Skill directory.");
  }
  let targetRealPath: string;
  try {
    targetRealPath = await realpath(target);
  } catch {
    throw new SkillRegistryError("skill_not_found", `Skill resource not found: ${resourcePath}`);
  }
  if (!isInsidePath(instance.locator.realPath, targetRealPath)) {
    throw new SkillRegistryError("resource_outside_skill", "Refused to follow a resource symlink outside the Skill directory.");
  }
  const info = await lstat(targetRealPath);
  if (!info.isFile()) throw new SkillRegistryError("resource_not_text", "Skill resource is not a regular file.");
  const buffer = await readFile(targetRealPath);
  if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) {
    throw new SkillRegistryError("resource_not_text", "Skill resource is binary.");
  }
  const truncated = buffer.byteLength > maxBytes;
  const visible = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : buffer.toString("utf8");
  return { skillId: instance.skillId, resourcePath, content: visible, truncated };
}

function resolveToken(snapshot: SkillSnapshot, token: string): SkillInstance | undefined {
  const [qualifier, name] = splitQualifiedName(token);
  return name ? snapshot.resolve(name, qualifier) : snapshot.resolve(qualifier);
}

function describeUnavailableSkill(snapshot: SkillSnapshot, token: string): string {
  const [qualifier, qualifiedName] = splitQualifiedName(token);
  const name = qualifiedName ?? qualifier;
  const candidates = snapshot.instances.filter((instance) => {
    if (instance.nameKey !== normalizeName(name)) return false;
    if (!qualifiedName) return true;
    const normalizedQualifier = qualifier.toLocaleLowerCase();
    return (
      instance.locator.source === normalizeSourceQualifier(normalizedQualifier) ||
      instance.locator.pluginId?.toLocaleLowerCase() === normalizedQualifier
    );
  });
  if (!candidates.length) return `Skill "${token}" was not found in the current registry snapshot.`;
  if (candidates.every((instance) => !instance.enabled)) return `Skill "${token}" is disabled.`;
  if (candidates.every((instance) => instance.validity === "invalid")) {
    return `Skill "${token}" has invalid metadata and cannot be loaded.`;
  }
  if (candidates.some((instance) => instance.resolution === "conflicted")) {
    return `Skill "${token}" has an unresolved name conflict.`;
  }
  return `Skill "${token}" is unavailable in the current registry snapshot.`;
}

function splitQualifiedName(token: string): [string, string?] {
  const separator = token.indexOf(":");
  return separator < 0 ? [token] : [token.slice(0, separator), token.slice(separator + 1)];
}

function normalizeSourceQualifier(value: string): SkillSource | undefined {
  if (value === "builtin" || value === "built-in") return "built_in";
  if (["system", "user", "project", "plugin"].includes(value)) return value as SkillSource;
  return undefined;
}

function renderCatalogEntry(entry: SkillCatalogEntry, description: string): string {
  return `  <skill id="${escapeXml(entry.skillId)}" name="${escapeXml(entry.name)}" source="${entry.source}" path="${escapeXml(entry.path)}">${escapeXml(description)}</skill>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function createSkillId(locator: SkillLocator): string {
  const identity = locator.source === "project"
    ? `${locator.source}:${locator.provider}:${locator.projectRelativePath}`
    : locator.source === "plugin"
      ? `${locator.source}:${locator.pluginId}:${normalizePortablePath(locator.pluginRelativePath ?? locator.path)}`
      : `${locator.source}:${locator.provider}:${pathKey(locator.path)}`;
  return `skill_${sha256(identity).slice(0, 20)}`;
}

export function skillLocatorStateKey(locator: SkillLocator): string {
  if (locator.source === "project") {
    return `${locator.provider}:${normalizePortablePath(locator.projectRelativePath ?? locator.path)}`;
  }
  if (locator.source === "plugin") {
    return `${locator.pluginId ?? locator.provider}:${normalizePortablePath(locator.path)}`;
  }
  if (locator.source === "built_in") return `built_in:${locator.provider}:${path.basename(locator.path)}`;
  return `${locator.source}:${locator.provider}:${pathKey(locator.path)}`;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function normalizePortablePath(value: string): string {
  return value.replace(/\\/g, "/").normalize("NFKC");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
