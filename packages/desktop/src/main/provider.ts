import {
  createDefaultFakeProvider,
  createModelProvider,
  resolveModelProviderConfig,
} from "@dreamcode/models";
import type { DreamCodeLlmProfile } from "@dreamcode/store";

export function createDesktopProvider(prompt: string, profile: DreamCodeLlmProfile) {
  if (profile.provider === "fake") {
    return { provider: createDefaultFakeProvider(prompt), model: profile.model };
  }

  const apiKey = profile.apiKeyEnv
    ? process.env[profile.apiKeyEnv]?.trim() || profile.apiKey
    : profile.apiKey;
  const resolved = resolveModelProviderConfig({
    provider: profile.provider,
    apiKey,
    baseURL: profile.baseURL,
    model: profile.model,
  });
  return { provider: createModelProvider(resolved), model: resolved.model };
}
