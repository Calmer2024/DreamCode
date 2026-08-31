import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  installManagedSkill,
  type ManagedSkillInstallation,
  type ManagedSkillInstallationStore,
  rollbackManagedSkill,
  SkillLifecycleError,
  uninstallManagedSkill,
  updateManagedSkill,
} from "./index";

const execFileAsync = promisify(execFile);

class MemoryInstallationStore implements ManagedSkillInstallationStore {
  private readonly records = new Map<string, ManagedSkillInstallation>();

  listInstallations(): readonly ManagedSkillInstallation[] {
    return [...this.records.values()];
  }

  getInstallation(skillId: string): ManagedSkillInstallation | undefined {
    return this.records.get(skillId);
  }

  async saveInstallation(installation: ManagedSkillInstallation): Promise<void> {
    this.records.set(installation.skillId, installation);
  }

  async deleteInstallation(skillId: string): Promise<void> {
    this.records.delete(skillId);
  }
}

async function environment(): Promise<{
  base: string;
  workspaceRoot: string;
  dreamCodeHome: string;
  store: MemoryInstallationStore;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "dreamcode-skill-lifecycle-"));
  const workspaceRoot = path.join(base, "workspace");
  const dreamCodeHome = path.join(base, "home", ".dreamcode");
  await mkdir(workspaceRoot, { recursive: true });
  return { base, workspaceRoot, dreamCodeHome, store: new MemoryInstallationStore() };
}

async function writeSkill(root: string, version: string, body: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "SKILL.md"),
    [
      "---",
      "name: managed-demo",
      "description: Managed lifecycle fixture.",
      `version: ${version}`,
      "---",
      "",
      body,
    ].join("\n"),
    "utf8",
  );
}

describe("managed Skill lifecycle", () => {
  it("installs a local directory without modifying its source", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0", "Source body.");

    const installation = await installManagedSkill({
      source: { type: "directory", location: source },
      scope: "user",
      ...env,
    });

    expect(installation.path).toBe(path.join(env.dreamCodeHome, "skills", "managed-demo"));
    await expect(readFile(path.join(installation.path, "SKILL.md"), "utf8")).resolves.toContain(
      "Source body.",
    );
    await writeFile(path.join(installation.path, "local.txt"), "destination only", "utf8");
    await expect(readFile(path.join(source, "local.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires confirmation for overwrite and local changes", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0", "First body.");
    const first = await installManagedSkill({
      source: { type: "directory", location: source },
      scope: "user",
      ...env,
    });
    await writeFile(path.join(first.path, "local-change.txt"), "changed", "utf8");
    await writeSkill(source, "2.0.0", "Second body.");

    await expect(
      updateManagedSkill({ skillId: first.skillId, ...env }),
    ).rejects.toMatchObject({
      code: "install_conflict",
      conflicts: expect.arrayContaining(["destination_exists", "local_changes"]),
    });
  });

  it("updates atomically and swaps the retained version on rollback", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0", "Version one.");
    const first = await installManagedSkill({
      source: { type: "directory", location: source },
      scope: "project",
      ...env,
    });
    await writeSkill(source, "2.0.0", "Version two.");

    const updated = await updateManagedSkill({
      skillId: first.skillId,
      ...env,
      confirmations: { overwrite: true },
    });
    expect(updated.version).toBe("2.0.0");
    await expect(readFile(path.join(updated.path, "SKILL.md"), "utf8")).resolves.toContain(
      "Version two.",
    );

    const rolledBack = await rollbackManagedSkill({ skillId: updated.skillId, ...env });
    expect(rolledBack.version).toBe("1.0.0");
    expect(rolledBack.previous?.version).toBe("2.0.0");
    await expect(readFile(path.join(rolledBack.path, "SKILL.md"), "utf8")).resolves.toContain(
      "Version one.",
    );
  });

  it("restores the previous payload when update state persistence fails", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0", "Version one.");
    const first = await installManagedSkill({
      source: { type: "directory", location: source },
      scope: "user",
      ...env,
    });
    await writeSkill(source, "2.0.0", "Version two.");
    const failingStore: ManagedSkillInstallationStore = {
      ...env.store,
      listInstallations: () => env.store.listInstallations(),
      getInstallation: (skillId) => env.store.getInstallation(skillId),
      deleteInstallation: (skillId) => env.store.deleteInstallation(skillId),
      saveInstallation: async () => {
        throw new Error("state write failed");
      },
    };

    await expect(
      updateManagedSkill({
        skillId: first.skillId,
        workspaceRoot: env.workspaceRoot,
        dreamCodeHome: env.dreamCodeHome,
        store: failingStore,
        confirmations: { overwrite: true },
      }),
    ).rejects.toThrow("state write failed");
    await expect(readFile(path.join(first.path, "SKILL.md"), "utf8")).resolves.toContain(
      "Version one.",
    );
  });

  it("preserves the existing rollback snapshot when a later update fails", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0", "Version one.");
    const first = await installManagedSkill({ source: { type: "directory", location: source }, scope: "user", ...env });
    await writeSkill(source, "2.0.0", "Version two.");
    const second = await updateManagedSkill({ skillId: first.skillId, ...env, confirmations: { overwrite: true } });
    await writeSkill(source, "3.0.0", "Version three.");
    const failingStore: ManagedSkillInstallationStore = {
      listInstallations: () => env.store.listInstallations(),
      getInstallation: (skillId) => env.store.getInstallation(skillId),
      deleteInstallation: (skillId) => env.store.deleteInstallation(skillId),
      saveInstallation: async () => { throw new Error("state write failed"); },
    };

    await expect(updateManagedSkill({
      skillId: second.skillId,
      workspaceRoot: env.workspaceRoot,
      dreamCodeHome: env.dreamCodeHome,
      store: failingStore,
      confirmations: { overwrite: true },
    })).rejects.toThrow("state write failed");
    await expect(readFile(path.join(second.path, "SKILL.md"), "utf8")).resolves.toContain("Version two.");
    const rolledBack = await rollbackManagedSkill({ skillId: second.skillId, ...env });
    expect(rolledBack.version).toBe("1.0.0");
  });

  it("compares SemVer prerelease identifiers numerically", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0-beta.10", "Beta ten.");
    const first = await installManagedSkill({ source: { type: "directory", location: source }, scope: "user", ...env });
    await writeSkill(source, "1.0.0-beta.2", "Beta two.");

    await expect(updateManagedSkill({ skillId: first.skillId, ...env, confirmations: { overwrite: true } }))
      .rejects.toMatchObject({ code: "install_conflict", conflicts: expect.arrayContaining(["downgrade"]) });
  });

  it("requires confirmation for same-version content and source changes", async () => {
    const env = await environment();
    const firstSource = path.join(env.base, "source-one");
    const secondSource = path.join(env.base, "source-two");
    await writeSkill(firstSource, "1.0.0", "First source.");
    await writeSkill(secondSource, "1.0.0", "Second source.");
    await installManagedSkill({ source: { type: "directory", location: firstSource }, scope: "user", ...env });

    await expect(installManagedSkill({
      source: { type: "directory", location: secondSource },
      scope: "user",
      ...env,
      confirmations: { overwrite: true },
    })).rejects.toMatchObject({
      code: "install_conflict",
      conflicts: expect.arrayContaining(["source_changed", "same_version_content_changed"]),
    });
  });

  it("installs Skills without a declared version", async () => {
    const env = await environment();
    const source = path.join(env.base, "unversioned");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: managed-demo\ndescription: No version fixture.\n---\nBody.\n", "utf8");

    const installation = await installManagedSkill({ source: { type: "directory", location: source }, scope: "user", ...env });
    expect(installation.version).toBeUndefined();
    expect(installation.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("restores files when uninstall state persistence fails", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0", "Keep me.");
    const installation = await installManagedSkill({ source: { type: "directory", location: source }, scope: "user", ...env });
    const failingStore: ManagedSkillInstallationStore = {
      listInstallations: () => env.store.listInstallations(),
      getInstallation: (skillId) => env.store.getInstallation(skillId),
      saveInstallation: (next) => env.store.saveInstallation(next),
      deleteInstallation: async () => { throw new Error("state delete failed"); },
    };

    await expect(uninstallManagedSkill({
      skillId: installation.skillId,
      workspaceRoot: env.workspaceRoot,
      dreamCodeHome: env.dreamCodeHome,
      store: failingStore,
    })).rejects.toThrow("state delete failed");
    await expect(readFile(path.join(installation.path, "SKILL.md"), "utf8")).resolves.toContain("Keep me.");
  });

  it("installs a safe ZIP and rejects traversal entries", async () => {
    const env = await environment();
    const safeZip = path.join(env.base, "safe.zip");
    await writeFile(
      safeZip,
      zipSync({
        "managed-demo/SKILL.md": strToU8(
          "---\nname: managed-demo\ndescription: ZIP fixture.\nversion: 1.0.0\n---\nZIP body.\n",
        ),
      }),
    );

    const installed = await installManagedSkill({
      source: { type: "zip", location: safeZip },
      scope: "user",
      ...env,
    });
    expect(installed.version).toBe("1.0.0");

    const unsafeEnv = await environment();
    const unsafeZip = path.join(unsafeEnv.base, "unsafe.zip");
    await writeFile(unsafeZip, zipSync({ "../escape.txt": strToU8("escape") }));
    await expect(
      installManagedSkill({
        source: { type: "zip", location: unsafeZip },
        scope: "user",
        ...unsafeEnv,
      }),
    ).rejects.toBeInstanceOf(SkillLifecycleError);
  });

  it("rejects ZIP symlinks and oversized declarations before extraction", async () => {
    const symlinkEnv = await environment();
    const symlinkZip = path.join(symlinkEnv.base, "symlink.zip");
    const symlinkArchive = Buffer.from(zipSync({
      "SKILL.md": strToU8("---\nname: managed-demo\ndescription: Unsafe link fixture.\n---\ntarget\n"),
    }));
    const symlinkCentral = symlinkArchive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    symlinkArchive.writeUInt16LE(3 << 8, symlinkCentral + 4);
    symlinkArchive.writeUInt32LE((0o120777 << 16) >>> 0, symlinkCentral + 38);
    await writeFile(symlinkZip, symlinkArchive);
    await expect(installManagedSkill({
      source: { type: "zip", location: symlinkZip },
      scope: "user",
      ...symlinkEnv,
    })).rejects.toMatchObject({ code: "package_unsafe" });

    const oversizedEnv = await environment();
    const oversizedZip = path.join(oversizedEnv.base, "oversized.zip");
    const oversizedArchive = Buffer.from(zipSync({
      "SKILL.md": strToU8("---\nname: managed-demo\ndescription: Oversized fixture.\n---\nBody\n"),
    }));
    const oversizedCentral = oversizedArchive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    oversizedArchive.writeUInt32LE(11 * 1024 * 1024, oversizedCentral + 24);
    await writeFile(oversizedZip, oversizedArchive);
    await expect(installManagedSkill({
      source: { type: "zip", location: oversizedZip },
      scope: "user",
      ...oversizedEnv,
    })).rejects.toMatchObject({ code: "package_limit_exceeded" });
  });

  it("installs from a local Git repository and records its revision", async () => {
    const env = await environment();
    const repository = path.join(env.base, "repository");
    await writeSkill(repository, "1.0.0", "Git body.");
    await execFileAsync("git", ["init"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "DreamCode Test"], { cwd: repository });
    await execFileAsync("git", ["add", "SKILL.md"], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "skill fixture"], { cwd: repository });

    const installation = await installManagedSkill({
      source: { type: "git", location: repository },
      scope: "user",
      ...env,
    });

    expect(installation.revision).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(path.join(installation.path, "SKILL.md"), "utf8")).resolves.toContain(
      "Git body.",
    );
  });

  it("installs a Git ref from a repository subpath", async () => {
    const env = await environment();
    const repository = path.join(env.base, "versioned-repository");
    const skillRoot = path.join(repository, "skills", "demo");
    await writeSkill(skillRoot, "1.0.0", "Tagged body.");
    await execFileAsync("git", ["init"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "DreamCode Test"], { cwd: repository });
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "tagged skill"], { cwd: repository });
    await execFileAsync("git", ["tag", "skill-v1"], { cwd: repository });
    await writeSkill(skillRoot, "2.0.0", "Later body.");
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "later skill"], { cwd: repository });

    const installation = await installManagedSkill({
      source: { type: "git", location: repository, ref: "skill-v1", subpath: "skills/demo" },
      scope: "user",
      ...env,
    });
    expect(installation.version).toBe("1.0.0");
    await expect(readFile(path.join(installation.path, "SKILL.md"), "utf8")).resolves.toContain("Tagged body.");
  });

  it("restores the pre-rollback layout when state persistence fails", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0", "Version one.");
    const first = await installManagedSkill({ source: { type: "directory", location: source }, scope: "user", ...env });
    await writeSkill(source, "2.0.0", "Version two.");
    const second = await updateManagedSkill({ skillId: first.skillId, ...env, confirmations: { overwrite: true } });
    const failingStore: ManagedSkillInstallationStore = {
      listInstallations: () => env.store.listInstallations(),
      getInstallation: (skillId) => env.store.getInstallation(skillId),
      deleteInstallation: (skillId) => env.store.deleteInstallation(skillId),
      saveInstallation: async () => { throw new Error("state write failed"); },
    };

    await expect(rollbackManagedSkill({
      skillId: second.skillId,
      workspaceRoot: env.workspaceRoot,
      dreamCodeHome: env.dreamCodeHome,
      store: failingStore,
    })).rejects.toThrow("state write failed");
    await expect(readFile(path.join(second.path, "SKILL.md"), "utf8")).resolves.toContain("Version two.");
    await expect(readFile(path.join(second.previous!.backupPath, "SKILL.md"), "utf8")).resolves.toContain("Version one.");
  });

  it("uninstalls only the managed destination and removes its record", async () => {
    const env = await environment();
    const source = path.join(env.base, "source");
    await writeSkill(source, "1.0.0", "Uninstall body.");
    const installation = await installManagedSkill({
      source: { type: "directory", location: source },
      scope: "user",
      ...env,
    });

    await uninstallManagedSkill({ skillId: installation.skillId, ...env });

    expect(env.store.getInstallation(installation.skillId)).toBeUndefined();
    await expect(readFile(path.join(installation.path, "SKILL.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(source, "SKILL.md"), "utf8")).resolves.toContain(
      "Uninstall body.",
    );
  });
});
