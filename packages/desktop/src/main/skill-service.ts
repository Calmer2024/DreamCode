import os from "node:os";
import path from "node:path";
import {
  installManagedSkill,
  rollbackManagedSkill,
  SkillRegistry,
  type SkillSnapshot,
  uninstallManagedSkill,
  updateManagedSkill,
} from "@dreamcode/skills";
import { getDreamCodeHome, PersistedSkillState } from "@dreamcode/store";
import type {
  DesktopSkillItem,
  DesktopSkillSnapshot,
  SkillInstallRequest,
} from "../shared/contracts";

interface RegistryEntry {
  registry: SkillRegistry;
  state: PersistedSkillState;
}

export class DesktopSkillService {
  readonly #entries = new Map<string, Promise<RegistryEntry>>();

  constructor(
    private readonly options: { home?: string; userHome?: string; builtInRoots?: readonly string[] } = {},
  ) {}

  async registryFor(workspaceRoot?: string): Promise<SkillRegistry> {
    return (await this.entryFor(workspaceRoot)).registry;
  }

  async list(workspaceRoot?: string): Promise<DesktopSkillSnapshot> {
    const entry = await this.entryFor(workspaceRoot);
    return this.toDesktopSnapshot(entry.registry.current(), entry.state);
  }

  async rescan(workspaceRoot?: string): Promise<DesktopSkillSnapshot> {
    const entry = await this.entryFor(workspaceRoot);
    return this.toDesktopSnapshot(await entry.registry.refresh(), entry.state);
  }

  async setEnabled(request: {
    workspaceRoot?: string;
    skillId: string;
    enabled: boolean;
  }): Promise<DesktopSkillSnapshot> {
    const entry = await this.entryFor(request.workspaceRoot);
    const instance = entry.registry.current().get(request.skillId);
    if (!instance) throw skillError("skill_not_found");
    await entry.state.setEnabled(instance.locator, request.enabled);
    if (instance.locator.source !== "project") {
      this.disposeEntries();
      return this.list(request.workspaceRoot);
    }
    return this.toDesktopSnapshot(await entry.registry.refresh(), entry.state);
  }

  async setCustomRoots(request: {
    workspaceRoot?: string;
    roots: readonly string[];
  }): Promise<DesktopSkillSnapshot> {
    const entry = await this.entryFor(request.workspaceRoot);
    await entry.state.setCustomRoots(request.roots);
    this.disposeEntries();
    return this.list(request.workspaceRoot);
  }

  async install(request: SkillInstallRequest): Promise<DesktopSkillSnapshot> {
    const workspaceRoot = this.resolveWorkspace(request.workspaceRoot);
    if (request.scope === "project" && !request.workspaceRoot) throw skillError("skill_workspace_required");
    const entry = await this.entryFor(workspaceRoot);
    await installManagedSkill({
      source: request.source,
      scope: request.scope,
      workspaceRoot,
      dreamCodeHome: this.dreamCodeHome,
      store: entry.state,
      confirmations: request.confirmations,
    });
    if (request.scope === "user") {
      this.disposeEntries();
      return this.list(workspaceRoot);
    }
    return this.toDesktopSnapshot(await entry.registry.refresh(), entry.state);
  }

  async update(request: {
    workspaceRoot?: string;
    skillId: string;
    confirmations?: SkillInstallRequest["confirmations"];
  }): Promise<DesktopSkillSnapshot> {
    const workspaceRoot = this.resolveWorkspace(request.workspaceRoot);
    const entry = await this.entryFor(workspaceRoot);
    const scope = entry.state.getInstallation(request.skillId)?.scope;
    await updateManagedSkill({
      skillId: request.skillId,
      workspaceRoot,
      dreamCodeHome: this.dreamCodeHome,
      store: entry.state,
      confirmations: request.confirmations,
    });
    if (scope === "user") {
      this.disposeEntries();
      return this.list(workspaceRoot);
    }
    return this.toDesktopSnapshot(await entry.registry.refresh(), entry.state);
  }

  async rollback(request: { workspaceRoot?: string; skillId: string }): Promise<DesktopSkillSnapshot> {
    const workspaceRoot = this.resolveWorkspace(request.workspaceRoot);
    const entry = await this.entryFor(workspaceRoot);
    const scope = entry.state.getInstallation(request.skillId)?.scope;
    await rollbackManagedSkill({
      skillId: request.skillId,
      workspaceRoot,
      dreamCodeHome: this.dreamCodeHome,
      store: entry.state,
    });
    if (scope === "user") {
      this.disposeEntries();
      return this.list(workspaceRoot);
    }
    return this.toDesktopSnapshot(await entry.registry.refresh(), entry.state);
  }

  async uninstall(request: { workspaceRoot?: string; skillId: string }): Promise<DesktopSkillSnapshot> {
    const workspaceRoot = this.resolveWorkspace(request.workspaceRoot);
    const entry = await this.entryFor(workspaceRoot);
    const scope = entry.state.getInstallation(request.skillId)?.scope;
    await uninstallManagedSkill({
      skillId: request.skillId,
      workspaceRoot,
      dreamCodeHome: this.dreamCodeHome,
      store: entry.state,
    });
    if (scope === "user") {
      this.disposeEntries();
      return this.list(workspaceRoot);
    }
    return this.toDesktopSnapshot(await entry.registry.refresh(), entry.state);
  }

  close(): void {
    this.disposeEntries();
  }

  private async entryFor(workspaceRoot?: string): Promise<RegistryEntry> {
    const resolvedWorkspace = this.resolveWorkspace(workspaceRoot);
    let pending = this.#entries.get(resolvedWorkspace);
    if (!pending) {
      pending = this.createEntry(resolvedWorkspace);
      this.#entries.set(resolvedWorkspace, pending);
    }
    return pending;
  }

  private async createEntry(workspaceRoot: string): Promise<RegistryEntry> {
    const state = await PersistedSkillState.open({ home: this.options.home, workspaceRoot });
    const registry = new SkillRegistry({
      workspaceRoot,
      workingDirectory: workspaceRoot,
      userHome: this.options.userHome ?? os.homedir(),
      dreamCodeHome: this.dreamCodeHome,
      builtInRoots: this.options.builtInRoots,
      customRoots: state.customRoots(),
      state,
      watch: true,
    });
    await registry.initialize();
    return { registry, state };
  }

  private toDesktopSnapshot(snapshot: SkillSnapshot, state: PersistedSkillState): DesktopSkillSnapshot {
    const installations = new Map(state.listInstallations().map((item) => [item.skillId, item]));
    const skills: DesktopSkillItem[] = snapshot.instances
      .map((instance) => {
        const installation = installations.get(instance.skillId);
        return {
          skillId: instance.skillId,
          name: instance.metadata?.display?.name ?? instance.metadata?.name ?? path.basename(instance.locator.path),
          invocationName: instance.metadata?.name,
          description: instance.metadata?.display?.shortDescription ?? instance.metadata?.description ?? "Skill metadata is invalid.",
          version: instance.metadata?.version,
          source: instance.locator.source,
          provider: instance.locator.provider,
          capabilities: [...(instance.metadata?.capabilities ?? [])],
          allowImplicitInvocation: instance.metadata?.allowImplicitInvocation ?? false,
          pluginDisplayName: instance.locator.pluginDisplayName,
          pluginVersion: instance.locator.pluginVersion,
          pluginManagementAction: instance.locator.pluginManagementAction,
          path: instance.locator.path,
          enabled: instance.enabled,
          valid: instance.validity === "valid",
          resolution: instance.resolution,
          managed: Boolean(installation),
          canUninstall: Boolean(installation),
          canUpdate: Boolean(installation),
          canRollback: Boolean(installation?.previous),
          diagnostics: instance.diagnostics.map((item) => item.message),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      generation: snapshot.generation,
      skills,
      customRoots: [...state.customRoots()],
      diagnostics: snapshot.diagnostics.map(({ code, message, path: diagnosticPath }) => ({
        code,
        message,
        path: diagnosticPath,
      })),
    };
  }

  private get dreamCodeHome(): string {
    return this.options.home ?? getDreamCodeHome();
  }

  private resolveWorkspace(workspaceRoot?: string): string {
    return path.resolve(workspaceRoot ?? process.cwd());
  }

  private disposeEntries(): void {
    for (const pending of this.#entries.values()) void pending.then(({ registry }) => registry.close());
    this.#entries.clear();
  }
}

function skillError(code: "skill_not_found" | "skill_workspace_required") {
  return { code, recoverable: true };
}
