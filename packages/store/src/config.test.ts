import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLlmProfile,
  deleteLlmProfile,
  getActiveLlmProfile,
  getConfigPath,
  loadDreamCodeConfig,
  saveDreamCodeConfig,
  setCurrentLlmProfile,
  setMcpServerEnabled,
  setSessionPinned,
  upsertLlmProfile,
  upsertProject,
} from "./index";

describe("DreamCode config", () => {
  it("preserves LangSmith settings when updating model profiles", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));
    const langsmith = {
      enabled: true,
      apiKey: "smith-secret",
      apiKeyEnv: "MY_SMITH_KEY",
      projectName: "DreamCode",
      endpoint: "https://example.com",
      workspaceId: "workspace",
      hideInputs: false,
      hideOutputs: true,
      flushTimeoutMs: 1500,
    };
    await saveDreamCodeConfig({ version: 3, profiles: {}, langsmith }, home);
    const loaded = await loadDreamCodeConfig(home);
    expect(loaded.langsmith).toEqual(langsmith);
    await saveDreamCodeConfig(upsertLlmProfile(loaded, "fake", { provider: "fake" }), home);
    expect((await loadDreamCodeConfig(home)).langsmith).toEqual(langsmith);
  });

  it("ignores malformed LangSmith fields and normalizes valid settings", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));
    await writeFile(
      getConfigPath(home),
      JSON.stringify({
        version: 3,
        profiles: {},
        langsmith: {
          enabled: "true",
          apiKey: 123,
          projectName: "  Test  ",
          endpoint: [],
          hideInputs: false,
          hideOutputs: "false",
          flushTimeoutMs: -1,
        },
      }),
    );
    expect((await loadDreamCodeConfig(home)).langsmith).toEqual({
      projectName: "Test",
      hideInputs: false,
    });
    await writeFile(
      getConfigPath(home),
      JSON.stringify({ version: 3, profiles: {}, langsmith: [] }),
    );
    expect((await loadDreamCodeConfig(home)).langsmith).toBeUndefined();
  });

  it("returns an empty config when config.json does not exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));

    await expect(loadDreamCodeConfig(home)).resolves.toEqual({
      version: 3,
      profiles: {},
    });
  });

  it("persists and loads the active llm profile", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));
    const config = upsertLlmProfile(await loadDreamCodeConfig(home), "deepseek", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseURL: "https://api.deepseek.com",
    });

    const configPath = await saveDreamCodeConfig(config, home);
    const loaded = await loadDreamCodeConfig(home);

    expect(configPath).toBe(getConfigPath(home));
    expect(getActiveLlmProfile(loaded)).toEqual({
      alias: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseURL: "https://api.deepseek.com",
    });
    await expect(readFile(configPath, "utf8")).resolves.toContain('"currentProfileId":');
  });

  it("persists the Exa web search credential", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));
    await saveDreamCodeConfig({ version: 2, profiles: {}, exaApiKey: "exa-secret" }, home);

    await expect(loadDreamCodeConfig(home)).resolves.toMatchObject({ exaApiKey: "exa-secret" });
  });

  it("migrates version 1 profiles without losing credentials", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));
    await writeFile(
      getConfigPath(home),
      JSON.stringify({
        version: 1,
        currentProfile: "work",
        profiles: {
          work: { provider: "openai", model: "gpt-existing", apiKey: "secret-value" },
        },
      }),
      "utf8",
    );

    const first = await loadDreamCodeConfig(home);
    const second = await loadDreamCodeConfig(home);
    const profileId = Object.keys(first.profiles)[0];

    expect(first.version).toBe(3);
    expect(profileId).toMatch(/^profile_legacy_/);
    expect(second.currentProfileId).toBe(profileId);
    expect(first.profiles[profileId!]).toMatchObject({
      alias: "work",
      provider: "openai",
      apiKey: "secret-value",
    });
  });

  it("migrates legacy DeepSeek model ids to deepseek-flash", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-deepseek-"));
    await writeFile(
      getConfigPath(home),
      JSON.stringify({
        version: 3,
        currentProfileId: "profile_deepseek",
        profiles: {
          profile_deepseek: {
            alias: "DeepSeek",
            provider: "deepseek",
            model: "deepseek-v4-flash",
          },
        },
      }),
      "utf8",
    );

    const config = await loadDreamCodeConfig(home);
    expect(config.profiles.profile_deepseek?.model).toBe("deepseek-flash");
  });

  it("keeps stable ids while editing aliases and falls back when deleting the default", () => {
    const first = createLlmProfile(
      { version: 2, profiles: {} },
      { alias: "工作", provider: "openai", model: "gpt-5.5" },
    );
    const second = createLlmProfile(first.config, {
      alias: "个人",
      provider: "openai",
      model: "gpt-5.4",
    });
    const withDefault = setCurrentLlmProfile(second.config, first.profileId);
    const deleted = deleteLlmProfile(withDefault, first.profileId);

    expect(deleted.currentProfileId).toBe(second.profileId);
    expect(Object.keys(deleted.profiles)).toEqual([second.profileId]);
  });

  it("persists project metadata and pinned sessions in the shared config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));
    const workspaceRoot = path.join(home, "workspace");

    await upsertProject({ workspaceRoot, name: "Workspace", pinned: true }, home);
    await setSessionPinned("sess_1", true, home);

    await expect(loadDreamCodeConfig(home)).resolves.toMatchObject({
      projects: [{ workspaceRoot: path.resolve(workspaceRoot), name: "Workspace", pinned: true }],
      pinnedSessionIds: ["sess_1"],
    });
  });

  it("migrates legacy MCP stdio entries disabled and keeps a v2 backup", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));
    const legacy = {
      version: 2,
      profiles: {},
      mcpServers: {
        local: { command: "node", args: ["server.js"], env: { TOKEN: "$" + "{TOKEN}" } },
      },
    };
    await writeFile(getConfigPath(home), JSON.stringify(legacy), "utf8");

    const migrated = await loadDreamCodeConfig(home);

    expect(migrated).toMatchObject({
      version: 3,
      mcpServers: { local: { transport: "stdio", enabled: false, command: "node" } },
    });
    await expect(readFile(path.join(home, "config.v2.backup.json"), "utf8")).resolves.toBe(
      JSON.stringify(legacy),
    );
  });

  it("updates only the selected MCP enabled field from the latest config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));
    await writeFile(
      getConfigPath(home),
      JSON.stringify(
        {
          version: 3,
          profiles: {},
          retained: { custom: true },
          mcpServers: {
            one: { enabled: false, transport: "stdio", command: "node", custom: "keep" },
            two: { enabled: true, transport: "streamable-http", url: "https://example.com/mcp" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await setMcpServerEnabled("one", true, home);
    const raw = JSON.parse(await readFile(getConfigPath(home), "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({
      retained: { custom: true },
      mcpServers: {
        one: { enabled: true, custom: "keep" },
        two: { enabled: true },
      },
    });
  });
});
