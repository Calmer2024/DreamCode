import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SkillLocator } from "@dreamcode/skills";
import { describe, expect, it } from "vitest";
import {
  getProjectSkillStatePath,
  getSkillStatePath,
  type ManagedSkillInstallation,
  PersistedSkillState,
} from "./index";

async function createState(): Promise<{
  state: PersistedSkillState;
  home: string;
  workspaceRoot: string;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "dreamcode-skill-state-"));
  const home = path.join(base, "home");
  const workspaceRoot = path.join(base, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    state: await PersistedSkillState.open({ home, workspaceRoot }),
    home,
    workspaceRoot,
  };
}

function locator(
  source: SkillLocator["source"],
  root: string,
  relative = "demo",
): SkillLocator {
  const skillPath = path.join(root, relative);
  return {
    source,
    provider: "dreamcode",
    path: skillPath,
    realPath: skillPath,
    projectRelativePath: source === "project" ? relative : undefined,
  };
}

describe("PersistedSkillState", () => {
  it("stores global and Project Skill enablement in separate files", async () => {
    const { state, home, workspaceRoot } = await createState();
    const user = locator("user", home);
    const project = locator("project", workspaceRoot);

    await state.setEnabled(user, false);
    await state.setEnabled(project, false);

    expect(JSON.parse(await readFile(getSkillStatePath(home), "utf8")).states).not.toEqual({});
    expect(
      JSON.parse(await readFile(getProjectSkillStatePath(workspaceRoot), "utf8")).states,
    ).not.toEqual({});
    const reopened = await PersistedSkillState.open({ home, workspaceRoot });
    expect(reopened.isEnabled(user)).toBe(false);
    expect(reopened.isEnabled(project)).toBe(false);
  });

  it("persists custom roots without duplicates", async () => {
    const { state, home, workspaceRoot } = await createState();
    const custom = path.join(workspaceRoot, "custom");

    await state.setCustomRoots([custom, custom]);

    const reopened = await PersistedSkillState.open({ home, workspaceRoot });
    expect(reopened.customRoots()).toEqual([path.resolve(custom)]);
  });

  it("persists and removes managed installation records", async () => {
    const { state, home, workspaceRoot } = await createState();
    const installation: ManagedSkillInstallation = {
      skillId: "skill_demo",
      name: "demo",
      path: path.join(home, "skills", "demo"),
      scope: "user",
      source: { type: "directory", location: path.join(workspaceRoot, "source") },
      contentHash: "abc",
      installedAt: "2026-08-28T00:00:00.000Z",
    };

    await state.saveInstallation(installation);
    expect(state.getInstallation("skill_demo")).toEqual(installation);
    await state.deleteInstallation("skill_demo");

    const reopened = await PersistedSkillState.open({ home, workspaceRoot });
    expect(reopened.getInstallation("skill_demo")).toBeUndefined();
  });

  it("merges concurrent user-state writes from different workspace instances", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "dreamcode-skill-state-concurrent-"));
    const home = path.join(base, "home");
    const workspaceA = path.join(base, "a");
    const workspaceB = path.join(base, "b");
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
    const [stateA, stateB] = await Promise.all([
      PersistedSkillState.open({ home, workspaceRoot: workspaceA }),
      PersistedSkillState.open({ home, workspaceRoot: workspaceB }),
    ]);
    const first = locator("user", home, "first");
    const second = locator("user", home, "second");

    await Promise.all([stateA.setEnabled(first, false), stateB.setEnabled(second, false)]);

    const reopened = await PersistedSkillState.open({ home, workspaceRoot: workspaceA });
    expect(reopened.isEnabled(first)).toBe(false);
    expect(reopened.isEnabled(second)).toBe(false);
    expect((await readdir(home)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("reports corrupt state files without silently resetting them", async () => {
    const { home, workspaceRoot } = await createState();
    await mkdir(home, { recursive: true });
    await writeFile(getSkillStatePath(home), "{not-json", "utf8");

    await expect(PersistedSkillState.open({ home, workspaceRoot })).rejects.toThrow(
      /Failed to read Skill state/,
    );
  });
});
