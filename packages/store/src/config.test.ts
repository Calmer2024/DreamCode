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
  setSessionPinned,
  upsertLlmProfile,
  upsertProject,
} from "./index";

describe("DreamCode config", () => {
  it("returns an empty config when config.json does not exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));

    await expect(loadDreamCodeConfig(home)).resolves.toEqual({
      version: 2,
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

    expect(first.version).toBe(2);
    expect(profileId).toMatch(/^profile_legacy_/);
    expect(second.currentProfileId).toBe(profileId);
    expect(first.profiles[profileId!]).toMatchObject({
      alias: "work",
      provider: "openai",
      apiKey: "secret-value",
    });
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
});
