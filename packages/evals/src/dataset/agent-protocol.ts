import type { ModelUsage } from "@dreamcode/shared";
import type { ExternalAgent } from "./agents.js";

/** Private model reasoning is transient: keep public text/tools, never thinking blocks or deltas. */
export function publicAgentData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicAgentData).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  if (/(^|[./_:-])(thinking|reasoning)([./_:-]|$)/.test(String(input.type))) return undefined;
  if (
    [
      "thinking",
      "redacted_thinking",
      "thinking_delta",
      "signature_delta",
      "reasoning",
      "reasoning_delta",
    ].includes(String(input.type))
  )
    return undefined;
  if (
    input.type === "message_update" &&
    /thinking/.test(String((input.assistantMessageEvent as any)?.type))
  )
    return undefined;
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([key]) =>
          ![
            "reasoningContent",
            "reasoning_content",
            "reasoning",
            "thinking",
            "signature",
            "partial",
          ].includes(key) && !(key === "stream" && Array.isArray(input[key])),
      )
      .map(([key, item]) => [key, publicAgentData(item)])
      .filter(([, item]) => item !== undefined),
  );
}
export function agentLaunch(agent: ExternalAgent, model: string, prompt: string, bridge: string) {
  const key = "dreameval-loopback-only";
  if (agent === "claude-code")
    return {
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode",
        "bypassPermissions",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--settings",
        "/home/agent/claude-settings.json",
        "--model",
        model,
        "--",
        prompt,
      ],
      env: {
        ANTHROPIC_BASE_URL: bridge,
        ANTHROPIC_AUTH_TOKEN: key,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CONFIG_DIR: "/home/agent/claude",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
      },
      files: {
        "/home/agent/claude-settings.json": { disableAllHooks: true },
        "/home/agent/.claude.json": { hasCompletedOnboarding: true },
      },
    };
  if (agent === "pi")
    return {
      args: [
        "--print",
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--provider",
        "dreameval",
        "--model",
        model,
        "--",
        prompt,
      ],
      env: { PI_CODING_AGENT_DIR: "/home/agent/pi", PI_SKIP_VERSION_CHECK: "1" },
      files: {
        "/home/agent/pi/models.json": {
          providers: {
            dreameval: {
              baseUrl: `${bridge}/v1`,
              api: "openai-completions",
              apiKey: key,
              models: [
                {
                  id: model,
                  name: model,
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 1000000,
                  maxTokens: 32768,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  compat: { supportsDeveloperRole: false, supportsStore: false },
                },
              ],
            },
          },
        },
        "/home/agent/pi/settings.json": { packages: [], extensions: [], skills: [] },
      },
    };
  if (agent === "opencode")
    return {
      args: ["run", "--format", "json", "--model", `dreameval/${model}`, "--", prompt],
      env: {
        OPENCODE_CONFIG: "/home/agent/opencode.json",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_SHARE: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      },
      files: {
        "/home/agent/opencode.json": {
          $schema: "https://opencode.ai/config.json",
          share: "disabled",
          autoupdate: false,
          plugin: [],
          permission: "allow",
          enabled_providers: ["dreameval"],
          model: `dreameval/${model}`,
          small_model: `dreameval/${model}`,
          provider: {
            dreameval: {
              npm: "@ai-sdk/openai-compatible",
              name: "DreamEval model bridge",
              options: { baseURL: `${bridge}/v1`, apiKey: key },
              models: { [model]: { name: model, limit: { context: 1000000, output: 32768 } } },
            },
          },
        },
      },
    };
  return {
    args: ["/runtime/dsh-driver.mjs", prompt, model],
    env: {
      DSH_HOME: "/home/agent/dsh",
      DEEPSEEK_API_KEY: key,
      DEEPSEEK_BASE_URL: `${bridge}/v1`,
      DSH_CWD: "/workspace",
      DSH_SESSION_ROOT: "/home/agent/dsh-sessions",
    },
    files: {},
  };
}
export function usageFromResponse(
  protocol: "openai" | "anthropic",
  value: Record<string, any>,
): ModelUsage | null {
  const usage = protocol === "anthropic" ? (value.message?.usage ?? value.usage) : value.usage;
  if (!usage) return null;
  const input =
    protocol === "anthropic"
      ? usage.input_tokens === undefined
        ? undefined
        : usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0)
      : usage.prompt_tokens;
  const output = protocol === "anthropic" ? usage.output_tokens : usage.completion_tokens;
  return {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {}),
    ...(protocol === "anthropic"
      ? usage.input_tokens !== undefined || usage.cache_read_input_tokens !== undefined
        ? { cachedInputTokens: usage.cache_read_input_tokens ?? 0 }
        : {}
      : typeof usage.prompt_tokens_details?.cached_tokens === "number"
        ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }
        : {}),
  };
}
