import {
  createDefaultFakeProvider,
  createModelProvider,
  resolveModelProviderConfig,
} from "@dreamcode/models";
import type { ModelProvider } from "@dreamcode/shared";
import type { DreamCodeLlmProfile } from "@dreamcode/store";

export function createDesktopProvider(prompt: string, profile: DreamCodeLlmProfile) {
  if (profile.provider === "fake") {
    if (process.env.DREAMCODE_E2E === "1" && profile.model === "e2e-blocking") {
      return { provider: createBlockingE2eProvider(), model: profile.model };
    }
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

function createBlockingE2eProvider(): ModelProvider {
  return {
    name: "fake-e2e-blocking",
    async *stream(input) {
      yield { type: "text_delta", text: "Waiting for an explicit stop.\n" };
      await waitForAbort(input.signal);
    },
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const rejectForAbort = () => reject(signal?.reason ?? new Error("Run interrupted."));
    if (signal?.aborted) {
      rejectForAbort();
      return;
    }
    signal?.addEventListener("abort", rejectForAbort, { once: true });
  });
}
