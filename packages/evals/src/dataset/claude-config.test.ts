import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configuredClaudeEndpoints, savedAgentEndpoint } from "./agents.js";
import { createModelBridge } from "./model-bridge.js";

afterEach(() => vi.unstubAllEnvs());
describe("Claude Code local model configuration", () => {
  it("rereads switched models and credentials, resolves aliases and preserves extended context", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claude-config-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", directory);
    const save = (model: string, token: string) =>
      writeFile(
        path.join(directory, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://gateway.invalid/anthropic",
            ANTHROPIC_AUTH_TOKEN: token,
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "fast-model",
          },
        }),
      );
    await save("first[1m]", "SECRET-A");
    expect((await configuredClaudeEndpoints()).map((entry) => entry.model)).toEqual([
      "first[1m]",
      "fast-model",
    ]);
    expect(await savedAgentEndpoint("first[1m]", "claude-code")).toMatchObject({
      apiKey: "SECRET-A",
      authType: "bearer",
    });
    await save("second[1m]", "SECRET-B");
    expect((await configuredClaudeEndpoints()).map((entry) => entry.model)).toEqual([
      "second[1m]",
      "fast-model",
    ]);
    expect(await savedAgentEndpoint("second[1m]", "claude-code")).toMatchObject({
      apiKey: "SECRET-B",
    });
    await writeFile(
      path.join(directory, "settings.json"),
      JSON.stringify({
        model: "sonnet[1m]",
        env: {
          ANTHROPIC_API_KEY: "KEY",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "custom",
          ANTHROPIC_MODEL: "",
        },
      }),
    );
    expect((await configuredClaudeEndpoints())[0]).toMatchObject({
      model: "custom[1m]",
      authType: "api-key",
    });
    await writeFile(path.join(directory, "settings.json"), "malformed");
    await expect(configuredClaudeEndpoints()).rejects.toThrow("settings.json 格式无效");
  });
  it.each([
    "bearer",
    "api-key",
  ] as const)("uses the configured %s authentication without exposing it in evidence", async (authType) => {
    let sent: RequestInit | undefined;
    const evidence: unknown[] = [];
    const bridge = createModelBridge({
      endpoint: {
        protocol: "anthropic",
        baseURL: "https://gateway.invalid",
        apiKey: "SECRET",
        model: "custom[1m]",
        provider: "claude-code-config",
        authType,
      },
      maxModelRequests: 1,
      signal: new AbortController().signal,
      usage: [],
      onEvent: () => {},
      add: (_type, value) => evidence.push(value),
      fetch: async (_url, init) => {
        sent = init;
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    for await (const _ of bridge({ path: "/v1/messages", body: { model: "custom" } })) {
    }
    const headers = new Headers(sent?.headers);
    expect(JSON.parse(String(sent?.body)).model).toBe("custom");
    expect(headers.get("authorization")).toBe(authType === "bearer" ? "Bearer SECRET" : null);
    expect(headers.get("x-api-key")).toBe(authType === "api-key" ? "SECRET" : null);
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
  });
});
