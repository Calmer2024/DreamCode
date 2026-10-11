import { describe, expect, it, vi } from "vitest";
import { loadDreamCodeConfig } from "@dreamcode/store";
import { configuredProfileEntries } from "./configured-profiles.js";
import { listSavedProfiles, savedModel } from "./runner.js";
import { savedAgentEndpoint } from "./agents.js";

vi.mock("@dreamcode/store", () => ({ loadDreamCodeConfig: vi.fn() }));
const config = (profiles: Record<string, unknown>) =>
  ({ profiles }) as unknown as Awaited<ReturnType<typeof loadDreamCodeConfig>>;
describe("evaluation models from configured provider accounts", () => {
  it("expands MiMo and DeepSeek siblings and resolves both model and native DSH endpoints", async () => {
    vi.mocked(loadDreamCodeConfig).mockResolvedValue(
      config({
        mimo: { alias: "MiMo", provider: "mimo", model: "mimo-v2.5-pro", apiKey: "SECRET-MIMO" },
        deepseek: {
          alias: "DeepSeek",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          apiKey: "SECRET-DS",
          baseURL: "https://api.deepseek.com",
        },
      }),
    );
    const choices = await listSavedProfiles();
    expect(choices.map((entry) => entry.model).sort()).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
    ]);
    expect(JSON.stringify(choices)).not.toContain("SECRET");
    for (const model of choices.map((entry) => entry.model)) {
      expect(await savedModel(model)).toBeDefined();
      const endpoint = await savedAgentEndpoint(model, "dsh");
      expect(endpoint).toMatchObject({ model, protocol: "anthropic" });
      expect(endpoint.baseURL).toMatch(/\/anthropic$/);
      expect(endpoint.apiKey).toBe(model.startsWith("mimo") ? "SECRET-MIMO" : "SECRET-DS");
    }
  });
  it("prefers explicit sibling profiles, rejects ambiguous accounts and omits unauthenticated profiles", async () => {
    const profiles = {
      pro: { provider: "mimo", model: "mimo-v2.5-pro", apiKey: "PRO" },
      standard: { provider: "mimo", model: "mimo-v2.5", apiKey: "STANDARD" },
      missing: { provider: "deepseek", model: "deepseek-v4-pro" },
    };
    expect(
      configuredProfileEntries(config(profiles)).map((entry) => [
        entry.model,
        entry.profile.apiKey,
      ]),
    ).toEqual([
      ["mimo-v2.5-pro", "PRO"],
      ["mimo-v2.5", "STANDARD"],
    ]);
    vi.mocked(loadDreamCodeConfig).mockResolvedValue(
      config({ ...profiles, another: { ...profiles.pro, apiKey: "OTHER" } }),
    );
    await expect(savedModel("mimo-v2.5-pro")).rejects.toThrow("found 2");
    await expect(savedAgentEndpoint("mimo-v2.5-pro", "dsh")).rejects.toThrow("Expected one");
    await expect(savedModel("unknown-model")).rejects.toThrow("found 0");
  });
});
