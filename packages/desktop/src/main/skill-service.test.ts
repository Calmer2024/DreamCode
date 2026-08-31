import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSkillService } from "./skill-service";

const services: DesktopSkillService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

describe("DesktopSkillService", () => {
  it("lists convention skills and persists user enablement globally", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-skills-"));
    const home = path.join(root, ".dreamcode");
    const userHome = path.join(root, "user");
    const workspaceA = path.join(root, "project-a");
    const workspaceB = path.join(root, "project-b");
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
    await writeSkill(path.join(userHome, ".agents", "skills", "review"), "review");
    const service = new DesktopSkillService({ home, userHome });
    services.push(service);

    const listed = await service.list(workspaceA);
    expect(listed.skills).toEqual([
      expect.objectContaining({ name: "review", source: "user", enabled: true }),
    ]);
    const skillId = listed.skills[0]!.skillId;
    await service.setEnabled({ workspaceRoot: workspaceA, skillId, enabled: false });

    expect((await service.list(workspaceB)).skills[0]).toEqual(
      expect.objectContaining({ skillId, enabled: false }),
    );
  });

  it("keeps project installation metadata inside the project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-install-"));
    const home = path.join(root, ".dreamcode");
    const userHome = path.join(root, "user");
    const workspace = path.join(root, "project");
    const source = path.join(root, "source");
    await Promise.all([mkdir(workspace), writeSkill(source, "local-tool")]);
    const service = new DesktopSkillService({ home, userHome });
    services.push(service);

    const installed = await service.install({
      workspaceRoot: workspace,
      scope: "project",
      source: { type: "directory", location: source },
    });

    expect(installed.skills).toEqual([
      expect.objectContaining({ name: "local-tool", source: "project", managed: true }),
    ]);
    const projectState = JSON.parse(
      await readFile(path.join(workspace, ".dreamcode", "skills.local.json"), "utf8"),
    ) as { installations: Record<string, unknown> };
    expect(Object.keys(projectState.installations)).toHaveLength(1);
    await expect(readFile(path.join(home, "skills.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes user lifecycle changes to every cached workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-global-install-"));
    const home = path.join(root, ".dreamcode");
    const userHome = path.join(root, "user");
    const workspaceA = path.join(root, "project-a");
    const workspaceB = path.join(root, "project-b");
    const source = path.join(root, "source");
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB), writeSkill(source, "global-tool")]);
    const service = new DesktopSkillService({ home, userHome });
    services.push(service);
    await service.list(workspaceB);

    await service.install({
      workspaceRoot: workspaceA,
      scope: "user",
      source: { type: "directory", location: source },
    });

    expect((await service.list(workspaceB)).skills).toEqual([
      expect.objectContaining({ name: "global-tool", source: "user", managed: true }),
    ]);
  });
});

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Helps with ${name}.\n---\n\nUse this skill carefully.\n`,
  );
}
