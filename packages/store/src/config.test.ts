import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getActiveLlmProfile,
  getConfigPath,
  loadDreamCodeConfig,
  saveDreamCodeConfig,
  upsertLlmProfile,
} from "./index";

describe("DreamCode config", () => {
  it("returns an empty config when config.json does not exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-config-"));

    await expect(loadDreamCodeConfig(home)).resolves.toEqual({
      version: 1,
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
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseURL: "https://api.deepseek.com",
    });
    await expect(readFile(configPath, "utf8")).resolves.toContain('"currentProfile": "deepseek"');
  });
});
