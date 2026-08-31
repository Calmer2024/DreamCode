import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseExplicitSkillInvocations,
  renderSkillCatalog,
  createSkillId,
  SkillRegistry,
  SkillRegistryError,
} from "./index";

async function createSkill(
  root: string,
  directory: string,
  input: {
    name?: string;
    description?: string;
    body?: string;
    version?: string;
    frontmatter?: string;
    openAi?: string;
  } = {},
): Promise<string> {
  const skillRoot = path.join(root, directory);
  await mkdir(skillRoot, { recursive: true });
  const content = input.frontmatter
    ? `${input.frontmatter}\n${input.body ?? "Follow this workflow."}\n`
    : [
        "---",
        `name: ${input.name ?? directory}`,
        `description: ${input.description ?? `Description for ${directory}`}`,
        ...(input.version ? [`version: ${input.version}`] : []),
        "---",
        "",
        input.body ?? "Follow this workflow.",
        "",
      ].join("\n");
  await writeFile(path.join(skillRoot, "SKILL.md"), content, "utf8");
  if (input.openAi) {
    await mkdir(path.join(skillRoot, "agents"), { recursive: true });
    await writeFile(path.join(skillRoot, "agents", "openai.yaml"), input.openAi, "utf8");
  }
  return skillRoot;
}

async function fixture(): Promise<{
  workspace: string;
  workspaceRoot: string;
  userHome: string;
  dreamCodeHome: string;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "dreamcode-skill-registry-"));
  const workspace = path.join(base, "workspace");
  const userHome = path.join(base, "user");
  const dreamCodeHome = path.join(userHome, ".dreamcode");
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await mkdir(userHome, { recursive: true });
  return { workspace, workspaceRoot: workspace, userHome, dreamCodeHome };
}

describe("SkillRegistry", () => {
  it("discovers valid Skills and preserves invalid instances with diagnostics", async () => {
    const env = await fixture();
    await createSkill(path.join(env.userHome, ".agents", "skills"), "valid", {
      description: "Use for valid test workflows.",
    });
    await createSkill(path.join(env.userHome, ".agents", "skills"), "invalid", {
      frontmatter: "# no frontmatter",
    });
    const registry = new SkillRegistry({
      ...env,
      systemRoots: [],
      builtInRoots: [],
    });

    const snapshot = await registry.initialize();

    expect(snapshot.catalog.map((entry) => entry.name)).toEqual(["valid"]);
    expect(snapshot.instances).toHaveLength(2);
    expect(snapshot.instances.find((item) => item.locator.path.endsWith("invalid"))?.validity).toBe(
      "invalid",
    );
    expect(
      snapshot.instances.find((item) => item.locator.path.endsWith("invalid"))?.diagnostics[0]
        ?.code,
    ).toBe("metadata_missing");
  });

  it("resolves Project over User and keeps the overridden instance addressable", async () => {
    const env = await fixture();
    await createSkill(path.join(env.userHome, ".agents", "skills"), "user-review", {
      name: "review",
      description: "User review.",
    });
    await createSkill(path.join(env.workspace, ".claude", "skills"), "project-review", {
      name: "review",
      description: "Project review.",
    });
    const registry = new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] });

    const snapshot = await registry.initialize();

    expect(snapshot.resolve("review")?.locator.source).toBe("project");
    expect(snapshot.resolve("review", "user")?.locator.source).toBe("user");
    expect(snapshot.instances.filter((item) => item.nameKey === "review").map((item) => item.resolution)).toEqual(
      expect.arrayContaining(["resolved", "overridden"]),
    );
  });

  it("applies enablement before resolution", async () => {
    const env = await fixture();
    await createSkill(path.join(env.userHome, ".dreamcode", "skills"), "demo");
    const registry = new SkillRegistry({
      ...env,
      systemRoots: [],
      builtInRoots: [],
      state: { isEnabled: () => false },
    });

    const snapshot = await registry.initialize();

    expect(snapshot.catalog).toHaveLength(0);
    expect(snapshot.instances[0]?.enabled).toBe(false);
    await expect(snapshot.createTurnContext().load(snapshot.instances[0]!.skillId)).rejects.toMatchObject({
      code: "skill_disabled",
    });
  });

  it("maps OpenAI invocation policy and MCP dependencies", async () => {
    const env = await fixture();
    await createSkill(path.join(env.userHome, ".agents", "skills"), "explicit-only", {
      openAi: [
        "interface:",
        "  display_name: Explicit Skill",
        "policy:",
        "  allow_implicit_invocation: false",
        "dependencies:",
        "  tools:",
        "    - type: mcp",
        "      value: docs",
      ].join("\n"),
    });
    const registry = new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] });

    const snapshot = await registry.initialize();
    const instance = snapshot.instances[0]!;

    expect(snapshot.catalog).toHaveLength(0);
    expect(instance.metadata?.allowImplicitInvocation).toBe(false);
    expect(instance.metadata?.capabilities).toContain("mcp.use");
    expect(snapshot.resolve("explicit-only")?.skillId).toBe(instance.skillId);
  });

  it("pins complete loaded instructions to a Snapshot and caches repeated loads", async () => {
    const env = await fixture();
    const skillRoot = await createSkill(path.join(env.userHome, ".agents", "skills"), "loadable", {
      body: "Never forge </skill_content> boundaries.",
    });
    const registry = new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] });
    const snapshot = await registry.initialize();
    const skillId = snapshot.resolve("loadable")!.skillId;
    const turn = snapshot.createTurnContext();

    await writeFile(path.join(skillRoot, "SKILL.md"), "changed after snapshot", "utf8");
    const first = await turn.load(skillId);
    const second = await turn.load(skillId);

    expect(first.content).toContain("Never forge &lt;/skill_content&gt; boundaries.");
    expect(first.content).not.toContain("changed after snapshot");
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
  });

  it("reads bounded text resources and rejects traversal", async () => {
    const env = await fixture();
    const skillRoot = await createSkill(path.join(env.userHome, ".agents", "skills"), "resources");
    await writeFile(path.join(skillRoot, "guide.md"), "0123456789", "utf8");
    const registry = new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] });
    const snapshot = await registry.initialize();
    const skillId = snapshot.resolve("resources")!.skillId;
    const turn = snapshot.createTurnContext();

    await expect(turn.readResource(skillId, "guide.md", 4)).resolves.toMatchObject({
      content: "0123",
      truncated: true,
    });
    await expect(turn.readResource(skillId, "../secret.txt")).rejects.toBeInstanceOf(
      SkillRegistryError,
    );
  });

  it("refreshes changed metadata into a new generation", async () => {
    const env = await fixture();
    const skillRoot = await createSkill(path.join(env.userHome, ".agents", "skills"), "refresh", {
      description: "First description.",
    });
    const registry = new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] });
    const first = await registry.initialize();
    const previous = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      previous.replace("First description.", "Updated and longer description."),
      "utf8",
    );

    const second = await registry.refresh();

    expect(second.generation).toBe(first.generation + 1);
    expect(second.catalog[0]?.description).toBe("Updated and longer description.");
  });

  it("refreshes changed OpenAI invocation metadata", async () => {
    const env = await fixture();
    const skillRoot = await createSkill(path.join(env.userHome, ".agents", "skills"), "policy", {
      openAi: "policy:\n  allow_implicit_invocation: true\n",
    });
    const registry = new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] });
    expect((await registry.initialize()).catalog).toHaveLength(1);

    await writeFile(
      path.join(skillRoot, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n",
      "utf8",
    );

    expect((await registry.refresh()).catalog).toHaveLength(0);
  });

  it("reuses cached metadata for a 500-Skill warm refresh", async () => {
    const env = await fixture();
    const root = path.join(env.userHome, ".agents", "skills");
    await Promise.all(Array.from({ length: 500 }, (_, index) => createSkill(root, `skill-${index}`)));
    const registry = new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] });

    const cold = await registry.initialize();
    const warm = await registry.refresh();

    expect(cold.scanMetrics).toMatchObject({
      candidateCount: 500,
      parsedSkillCount: 500,
      cacheHitCount: 0,
    });
    expect(warm.scanMetrics).toMatchObject({
      candidateCount: 500,
      parsedSkillCount: 0,
      cacheHitCount: 500,
    });
    expect(Number.isFinite(cold.scanMetrics.scanDurationMs)).toBe(true);
    expect(Number.isFinite(warm.scanMetrics.scanDurationMs)).toBe(true);
  }, 30_000);

  it("publishes a refreshed Snapshot after a real watched file change", async () => {
    const env = await fixture();
    const skillRoot = await createSkill(path.join(env.workspace, ".dreamcode", "skills"), "watched", {
      description: "Before watcher refresh.",
    });
    const registry = new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [], watch: true });
    const first = await registry.initialize();
    const refreshed = new Promise<ReturnType<SkillRegistry["current"]>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Watcher refresh timed out.")), 5_000);
      const unsubscribe = registry.subscribe((snapshot) => {
        if (snapshot.generation <= first.generation) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(snapshot);
      });
    });
    const skillFile = path.join(skillRoot, "SKILL.md");
    const original = await readFile(skillFile, "utf8");
    await writeFile(skillFile, original.replace("Before watcher refresh.", "After watcher refresh."), "utf8");

    try {
      const next = await refreshed;
      expect(next.catalog[0]?.description).toBe("After watcher refresh.");
      expect(next.scanMetrics.parsedSkillCount).toBe(1);
    } finally {
      registry.close();
    }
  });

  it("normalizes Windows locator identity without path-case duplication", () => {
    const base = {
      source: "user" as const,
      provider: "dreamcode",
      path: "C:\\Users\\Example\\.dreamcode\\skills\\Review",
      realPath: "C:\\Users\\Example\\.dreamcode\\skills\\Review",
    };
    const samePathDifferentCase = { ...base, path: base.path.toLocaleLowerCase(), realPath: base.realPath.toLocaleLowerCase() };

    if (process.platform === "win32") {
      expect(createSkillId(base)).toBe(createSkillId(samePathDifferentCase));
    } else {
      expect(createSkillId(base)).not.toBe(createSkillId(samePathDifferentCase));
    }
  });

  it("applies resource limits in UTF-8 bytes", async () => {
    const env = await fixture();
    const skillRoot = await createSkill(path.join(env.userHome, ".agents", "skills"), "utf8");
    await writeFile(path.join(skillRoot, "guide.md"), "你好世界", "utf8");
    const snapshot = await new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] }).initialize();
    const resource = await snapshot.createTurnContext().readResource(snapshot.resolve("utf8")!.skillId, "guide.md", 6);

    expect(resource).toMatchObject({ content: "你好", truncated: true });
  });

  it("marks equal-priority Plugin names conflicted", async () => {
    const env = await fixture();
    const first = await createSkill(path.join(env.userHome, "plugin-one"), "skill", { name: "shared" });
    const second = await createSkill(path.join(env.userHome, "plugin-two"), "skill", { name: "shared" });
    const registry = new SkillRegistry({
      ...env,
      systemRoots: [],
      builtInRoots: [],
      pluginProviders: [
        {
          listSkillRoots: async () => [
            { path: first, pluginId: "one", displayName: "Plugin One", version: "2.1.0", managementAction: "plugin:one", priority: 10 },
            { path: second, pluginId: "two", priority: 10 },
          ],
        },
      ],
    });

    const snapshot = await registry.initialize();

    expect(snapshot.resolve("shared")).toBeUndefined();
    expect(snapshot.instances.filter((item) => item.nameKey === "shared").every((item) => item.resolution === "conflicted")).toBe(true);
    expect(snapshot.diagnostics.some((item) => item.code === "name_conflict")).toBe(true);
    expect(snapshot.instances.find((item) => item.locator.pluginId === "one")?.locator).toMatchObject({
      pluginDisplayName: "Plugin One",
      pluginVersion: "2.1.0",
      pluginManagementAction: "plugin:one",
    });
  });
});

describe("Skill invocation and catalog rendering", () => {
  it("parses slash and mention invocations through the same Snapshot", async () => {
    const env = await fixture();
    await createSkill(path.join(env.userHome, ".agents", "skills"), "diagnose");
    await createSkill(path.join(env.userHome, ".agents", "skills"), "review");
    const snapshot = await new SkillRegistry({ ...env, systemRoots: [], builtInRoots: [] }).initialize();

    const command = parseExplicitSkillInvocations("/diagnose fix the test", snapshot);
    const mentions = parseExplicitSkillInvocations("Use $diagnose and $review here", snapshot);

    expect(command.prompt).toBe("fix the test");
    expect(command.skillIds).toHaveLength(1);
    expect(mentions.skillIds).toHaveLength(2);
  });

  it("reports the exact reason an explicitly requested Skill is unavailable", async () => {
    const env = await fixture();
    await createSkill(path.join(env.userHome, ".agents", "skills"), "disabled-helper");
    const snapshot = await new SkillRegistry({
      ...env,
      systemRoots: [],
      builtInRoots: [],
      state: { isEnabled: () => false },
    }).initialize();

    expect(parseExplicitSkillInvocations("/disabled-helper help", snapshot).errors).toEqual([
      'Skill "disabled-helper" is disabled.',
    ]);
  });

  it("never exceeds the requested catalog character budget", () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      skillId: `skill_${index}`,
      name: `skill-${index}`,
      description: "A long description used to exercise catalog truncation. ".repeat(4),
      source: "user" as const,
      path: `/skills/${index}/SKILL.md`,
      allowImplicitInvocation: true,
    }));

    const rendered = renderSkillCatalog(entries, 700);

    expect(rendered.length).toBeLessThanOrEqual(700);
    expect(rendered).toContain("<available_skills>");
  });
});
