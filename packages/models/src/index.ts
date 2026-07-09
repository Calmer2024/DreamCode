import type {
  ModelEvent,
  ModelProvider,
  ModelStreamInput,
  NormalizedToolCall,
  ToolModelSpec,
} from "@dreamcode/shared";
import { createId } from "@dreamcode/shared";
import OpenAI from "openai";

const GENERIC_API_KEY_ENV_VARS = ["DREAMCODE_API_KEY"] as const;
const GENERIC_BASE_URL_ENV_VARS = ["DREAMCODE_BASE_URL"] as const;
const GENERIC_MODEL_ENV_VARS = ["DREAMCODE_MODEL"] as const;

export type ModelProviderProtocol = "openai-compatible";

export interface ModelProviderPreset {
  id: string;
  displayName: string;
  protocol: ModelProviderProtocol;
  defaultModel: string;
  models?: readonly ModelProviderModel[];
  defaultBaseURL?: string;
  apiKeyEnvVars: readonly string[];
  baseURLEnvVars: readonly string[];
  modelEnvVars: readonly string[];
  aliases?: readonly string[];
  docsUrl?: string;
  requiresBaseURL?: boolean;
}

export interface ModelProviderModel {
  id: string;
  label?: string;
  description?: string;
}

export interface ResolvedModelProviderConfig {
  providerId: string;
  displayName: string;
  protocol: ModelProviderProtocol;
  model: string;
  apiKey?: string;
  baseURL?: string;
  apiKeySource?: string;
  baseURLSource?: string;
  modelSource: string;
  preset: ModelProviderPreset;
}

export interface ResolveModelProviderConfigInput {
  provider: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  env?: Record<string, string | undefined>;
}

export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    protocol: "openai-compatible",
    defaultModel: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        description: "旗舰模型, 适合复杂推理和编码",
      },
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        description: "更实惠的编码和专业工作模型",
      },
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4 mini",
        description: "更低延迟和成本",
      },
    ],
    apiKeyEnvVars: ["OPENAI_API_KEY", ...GENERIC_API_KEY_ENV_VARS],
    baseURLEnvVars: ["OPENAI_BASE_URL", ...GENERIC_BASE_URL_ENV_VARS],
    modelEnvVars: ["OPENAI_MODEL", ...GENERIC_MODEL_ENV_VARS],
    docsUrl: "https://developers.openai.com/api/docs/models",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    protocol: "openai-compatible",
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        description: "旗舰模型",
      },
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        description: "轻量高速模型",
      },
    ],
    defaultBaseURL: "https://api.deepseek.com",
    apiKeyEnvVars: ["DEEPSEEK_API_KEY", "DREAMCODE_DEEPSEEK_API_KEY", ...GENERIC_API_KEY_ENV_VARS],
    baseURLEnvVars: [
      "DEEPSEEK_BASE_URL",
      "DREAMCODE_DEEPSEEK_BASE_URL",
      ...GENERIC_BASE_URL_ENV_VARS,
    ],
    modelEnvVars: ["DEEPSEEK_MODEL", "DREAMCODE_DEEPSEEK_MODEL", ...GENERIC_MODEL_ENV_VARS],
    docsUrl: "https://api-docs.deepseek.com/",
  },
  {
    id: "qwen",
    displayName: "阿里云百炼 / Qwen",
    protocol: "openai-compatible",
    defaultModel: "qwen3.7-plus",
    models: [
      {
        id: "qwen3.7-max",
        label: "Qwen3.7 Max",
        description: "千问文本生成旗舰模型",
      },
      {
        id: "qwen3.7-plus",
        label: "Qwen3.7 Plus",
        description: "通用文本和 Agent 工作流",
      },
      {
        id: "qwen3.6-flash",
        label: "Qwen3.6 Flash",
        description: "更低延迟和成本",
      },
      {
        id: "qwen3-coder-next",
        label: "Qwen3 Coder Next",
        description: "代码生成、补全和工具调用",
      },
    ],
    defaultBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvVars: [
      "DASHSCOPE_API_KEY",
      "QWEN_API_KEY",
      "DREAMCODE_QWEN_API_KEY",
      ...GENERIC_API_KEY_ENV_VARS,
    ],
    baseURLEnvVars: [
      "DASHSCOPE_BASE_URL",
      "QWEN_BASE_URL",
      "DREAMCODE_QWEN_BASE_URL",
      ...GENERIC_BASE_URL_ENV_VARS,
    ],
    modelEnvVars: [
      "DASHSCOPE_MODEL",
      "QWEN_MODEL",
      "DREAMCODE_QWEN_MODEL",
      ...GENERIC_MODEL_ENV_VARS,
    ],
    aliases: ["dashscope", "aliyun", "alibaba"],
    docsUrl:
      "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
  },
  {
    id: "kimi",
    displayName: "Kimi / Moonshot",
    protocol: "openai-compatible",
    defaultModel: "kimi-k2.7-code-highspeed",
    models: [
      {
        id: "kimi-k2.7-code-highspeed",
        label: "Kimi K2.7 Code HighSpeed",
        description: "编程 Agent 高速版本",
      },
      {
        id: "kimi-k2.7-code",
        label: "Kimi K2.7 Code",
        description: "Kimi 当前最强编码模型",
      },
      {
        id: "kimi-k2.6",
        label: "Kimi K2.6",
        description: "通用多模态和复杂推理",
      },
    ],
    defaultBaseURL: "https://api.moonshot.ai/v1",
    apiKeyEnvVars: [
      "MOONSHOT_API_KEY",
      "KIMI_API_KEY",
      "DREAMCODE_KIMI_API_KEY",
      ...GENERIC_API_KEY_ENV_VARS,
    ],
    baseURLEnvVars: [
      "MOONSHOT_BASE_URL",
      "KIMI_BASE_URL",
      "DREAMCODE_KIMI_BASE_URL",
      ...GENERIC_BASE_URL_ENV_VARS,
    ],
    modelEnvVars: [
      "MOONSHOT_MODEL",
      "KIMI_MODEL",
      "DREAMCODE_KIMI_MODEL",
      ...GENERIC_MODEL_ENV_VARS,
    ],
    aliases: ["moonshot"],
    docsUrl: "https://platform.kimi.ai/docs/api/overview",
  },
  {
    id: "zhipu",
    displayName: "智谱 / Z.AI",
    protocol: "openai-compatible",
    defaultModel: "glm-5.2",
    models: [
      {
        id: "glm-5.2",
        label: "GLM-5.2",
        description: "1M 上下文, 面向长程任务和编码",
      },
      {
        id: "glm-5.1",
        label: "GLM-5.1",
        description: "长任务独立执行和编码",
      },
      {
        id: "glm-5",
        label: "GLM-5",
        description: "Agentic 规划、执行和调试",
      },
      {
        id: "glm-5-turbo",
        label: "GLM-5 Turbo",
        description: "复杂任务连续执行优化",
      },
    ],
    defaultBaseURL: "https://api.z.ai/api/paas/v4/",
    apiKeyEnvVars: [
      "ZAI_API_KEY",
      "ZHIPU_API_KEY",
      "DREAMCODE_ZHIPU_API_KEY",
      ...GENERIC_API_KEY_ENV_VARS,
    ],
    baseURLEnvVars: [
      "ZAI_BASE_URL",
      "ZHIPU_BASE_URL",
      "DREAMCODE_ZHIPU_BASE_URL",
      ...GENERIC_BASE_URL_ENV_VARS,
    ],
    modelEnvVars: ["ZAI_MODEL", "ZHIPU_MODEL", "DREAMCODE_ZHIPU_MODEL", ...GENERIC_MODEL_ENV_VARS],
    aliases: ["zai", "z.ai", "glm"],
    docsUrl: "https://docs.z.ai/guides/develop/openai/python",
  },
  {
    id: "siliconflow",
    displayName: "硅基流动 / SiliconFlow",
    protocol: "openai-compatible",
    defaultModel: "deepseek-ai/DeepSeek-V3.2",
    models: [
      {
        id: "deepseek-ai/DeepSeek-V3.2",
        label: "DeepSeek V3.2",
        description: "通用对话和 Agent 模型",
      },
      {
        id: "Pro/deepseek-ai/DeepSeek-V3.2",
        label: "DeepSeek V3.2 Pro",
        description: "Pro 版本",
      },
    ],
    defaultBaseURL: "https://api.siliconflow.cn/v1",
    apiKeyEnvVars: [
      "SILICONFLOW_API_KEY",
      "DREAMCODE_SILICONFLOW_API_KEY",
      ...GENERIC_API_KEY_ENV_VARS,
    ],
    baseURLEnvVars: [
      "SILICONFLOW_BASE_URL",
      "DREAMCODE_SILICONFLOW_BASE_URL",
      ...GENERIC_BASE_URL_ENV_VARS,
    ],
    modelEnvVars: ["SILICONFLOW_MODEL", "DREAMCODE_SILICONFLOW_MODEL", ...GENERIC_MODEL_ENV_VARS],
    aliases: ["silicon"],
    docsUrl: "https://docs.siliconflow.cn/en/api-reference/chat-completions/chat-completions",
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    protocol: "openai-compatible",
    defaultModel: "MiniMax-M3",
    models: [
      {
        id: "MiniMax-M3",
        label: "MiniMax M3",
        description: "面向编码、Agent 推理和长上下文",
      },
      {
        id: "MiniMax-M2.7",
        label: "MiniMax M2.7",
        description: "M2.7 标准版本",
      },
      {
        id: "MiniMax-M2.7-highspeed",
        label: "MiniMax M2.7 HighSpeed",
        description: "M2.7 高速版本",
      },
      {
        id: "MiniMax-M2.5",
        label: "MiniMax M2.5",
        description: "复杂任务和高性价比",
      },
      {
        id: "MiniMax-M2.5-highspeed",
        label: "MiniMax M2.5 HighSpeed",
        description: "M2.5 高速版本",
      },
    ],
    defaultBaseURL: "https://api.minimax.io/v1",
    apiKeyEnvVars: ["MINIMAX_API_KEY", "DREAMCODE_MINIMAX_API_KEY", ...GENERIC_API_KEY_ENV_VARS],
    baseURLEnvVars: [
      "MINIMAX_BASE_URL",
      "DREAMCODE_MINIMAX_BASE_URL",
      ...GENERIC_BASE_URL_ENV_VARS,
    ],
    modelEnvVars: ["MINIMAX_MODEL", "DREAMCODE_MINIMAX_MODEL", ...GENERIC_MODEL_ENV_VARS],
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-openai-api",
  },
  {
    id: "openai-compatible",
    displayName: "自定义 OpenAI-compatible",
    protocol: "openai-compatible",
    defaultModel: "gpt-5.5",
    apiKeyEnvVars: ["OPENAI_COMPATIBLE_API_KEY", ...GENERIC_API_KEY_ENV_VARS],
    baseURLEnvVars: ["OPENAI_COMPATIBLE_BASE_URL", ...GENERIC_BASE_URL_ENV_VARS],
    modelEnvVars: ["OPENAI_COMPATIBLE_MODEL", ...GENERIC_MODEL_ENV_VARS],
    aliases: ["custom", "compatible"],
    requiresBaseURL: true,
  },
];

export interface FakeModelStep {
  text?: string;
  toolCalls?: Array<Omit<NormalizedToolCall, "id"> & { id?: string }>;
}

export class FakeModelProvider implements ModelProvider {
  readonly name = "fake";
  private cursor = 0;

  constructor(private readonly steps: FakeModelStep[]) {}

  async *stream(_input: ModelStreamInput): AsyncIterable<ModelEvent> {
    const step = this.steps[this.cursor] ?? {
      text: "I do not have more scripted fake-model steps.",
      toolCalls: [],
    };
    this.cursor += 1;

    if (step.text) {
      for (const chunk of chunkText(step.text)) {
        yield { type: "text_delta", text: chunk };
      }
    }

    for (const toolCall of step.toolCalls ?? []) {
      yield {
        type: "tool_call",
        toolCall: {
          id: toolCall.id ?? createId("fake_call"),
          name: toolCall.name,
          input: toolCall.input,
          rawProvider: "fake",
          raw: toolCall.raw,
        },
      };
    }

    yield { type: "done" };
  }
}

export function fakeCall(name: string, input: unknown): Omit<NormalizedToolCall, "id"> {
  return {
    name,
    input,
    rawProvider: "fake",
  };
}

export function createDefaultFakeProvider(prompt: string): FakeModelProvider {
  const normalized = prompt.toLowerCase();

  if (
    normalized.includes(".env") ||
    normalized.includes("删除整个项目") ||
    normalized.includes("delete")
  ) {
    return new FakeModelProvider([
      {
        text: "I will verify the safety boundaries before doing anything risky.\n",
        toolCalls: [
          fakeCall("file.read", { path: ".env" }),
          fakeCall("shell.run", { command: "rm -rf .", timeoutMs: 10000 }),
        ],
      },
      {
        text: "Final answer: I refused the secret read and destructive delete request. No dangerous action was executed.",
      },
    ]);
  }

  if (normalized.includes("readme")) {
    return new FakeModelProvider([
      {
        text: "I will inspect the package metadata and source entry before updating the README.\n",
        toolCalls: [
          fakeCall("file.read", { path: "package.json" }),
          fakeCall("file.read", { path: "src/index.js" }),
        ],
      },
      {
        text: "I found a tiny CLI package. I will write a concise usage README.\n",
        toolCalls: [
          fakeCall("file.write", {
            path: "README.md",
            content:
              "# Readme Update Fixture\n\nA tiny CLI example used by DreamCode evals.\n\n## Usage\n\n```bash\nnpm install\nnode src/index.js Alice\n```\n\nThe command prints a greeting for the provided name.\n",
          }),
        ],
      },
      {
        text: "Final answer: README.md now documents the package purpose and usage.",
      },
    ]);
  }

  if (
    normalized.includes("测试失败") ||
    normalized.includes("failing") ||
    normalized.includes("test")
  ) {
    return new FakeModelProvider([
      {
        text: "I will inspect the failing JavaScript fixture before editing.\n",
        toolCalls: [
          fakeCall("todo.write", {
            items: [
              { content: "Read project files", status: "in_progress" },
              { content: "Patch failing implementation", status: "pending" },
              { content: "Run tests", status: "pending" },
            ],
          }),
          fakeCall("file.read", { path: "package.json" }),
          fakeCall("file.read", { path: "src/math.js" }),
          fakeCall("file.read", { path: "test/math.test.js" }),
        ],
      },
      {
        text: "The add implementation subtracts. I will patch it to add.\n",
        toolCalls: [
          fakeCall("file.patch", {
            path: "src/math.js",
            search: "return a - b;",
            replace: "return a + b;",
          }),
          fakeCall("todo.write", {
            items: [
              { content: "Read project files", status: "completed" },
              { content: "Patch failing implementation", status: "completed" },
              { content: "Run tests", status: "in_progress" },
            ],
          }),
        ],
      },
      {
        text: "I will run the test command to verify the fix.\n",
        toolCalls: [fakeCall("shell.run", { command: "npm test", timeoutMs: 30000 })],
      },
      {
        text: "Final answer: The failing add implementation was fixed and npm test passed.",
      },
    ]);
  }

  return new FakeModelProvider([
    {
      text: "I will inspect the workspace and git status first.\n",
      toolCalls: [
        fakeCall("file.list", { path: ".", recursive: false }),
        fakeCall("git.status", {}),
      ],
    },
    {
      text: "Final answer: I inspected the workspace. Use a real provider or a more specific fake eval prompt to make code changes.",
    },
  ]);
}

export interface OpenAICompatibleModelProviderOptions {
  providerId: string;
  displayName?: string;
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
}

export interface OpenAIModelProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(options: OpenAICompatibleModelProviderOptions) {
    if (!options.apiKey?.trim()) {
      throw new Error(`模型 provider ${options.providerId} 缺少 API key。`);
    }

    this.name = options.providerId;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    this.defaultModel = options.defaultModel ?? "gpt-5.5";
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelEvent> {
    const toolNameMap = new Map<string, string>();
    const tools = toOpenAITools(input.tools, toolNameMap);
    const stream = await this.client.chat.completions.create({
      model: input.model || this.defaultModel,
      messages: input.messages.map((message) => ({
        role: message.role === "tool" ? "user" : message.role,
        content: message.content,
      })) as any,
      tools: tools as any,
      stream: true,
    } as any);

    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; argumentsJson: string; raw: unknown[] }
    >();

    for await (const chunk of stream as any) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!delta) {
        continue;
      }

      if (delta.content) {
        yield { type: "text_delta", text: delta.content };
      }

      for (const toolCallDelta of delta.tool_calls ?? []) {
        const index = toolCallDelta.index ?? 0;
        const current = pendingToolCalls.get(index) ?? {
          id: toolCallDelta.id ?? createId("openai_call"),
          name: "",
          argumentsJson: "",
          raw: [] as unknown[],
        };

        current.raw.push(toolCallDelta);
        if (toolCallDelta.id) {
          current.id = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name) {
          current.name =
            toolNameMap.get(toolCallDelta.function.name) ?? toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          current.argumentsJson += toolCallDelta.function.arguments;
        }
        pendingToolCalls.set(index, current);
      }
    }

    for (const pending of pendingToolCalls.values()) {
      yield {
        type: "tool_call",
        toolCall: {
          id: pending.id,
          name: pending.name,
          input: parseJsonObject(pending.argumentsJson),
          rawProvider: this.name,
          raw: pending.raw,
        },
      };
    }

    yield { type: "done" };
  }
}

export class OpenAIModelProvider extends OpenAICompatibleModelProvider {
  constructor(options: OpenAIModelProviderOptions = {}) {
    const config = resolveModelProviderConfig({
      provider: "openai",
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      model: options.defaultModel,
    });

    super({
      providerId: config.providerId,
      displayName: config.displayName,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultModel: config.model,
    });
  }
}

export function listModelProviderPresets(): ModelProviderPreset[] {
  return MODEL_PROVIDER_PRESETS.map((preset) => ({
    ...preset,
    models: preset.models ? preset.models.map((model) => ({ ...model })) : undefined,
    apiKeyEnvVars: [...preset.apiKeyEnvVars],
    baseURLEnvVars: [...preset.baseURLEnvVars],
    modelEnvVars: [...preset.modelEnvVars],
    aliases: preset.aliases ? [...preset.aliases] : undefined,
  }));
}

export function findModelProviderPreset(provider: string): ModelProviderPreset | undefined {
  const normalized = normalizeProviderId(provider);
  return MODEL_PROVIDER_PRESETS.find(
    (preset) =>
      preset.id === normalized ||
      preset.aliases?.some((alias) => normalizeProviderId(alias) === normalized),
  );
}

export function detectConfiguredProvider(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const preferredOrder = ["deepseek", "qwen", "kimi", "zhipu", "siliconflow", "minimax", "openai"];

  for (const providerId of preferredOrder) {
    const preset = findModelProviderPreset(providerId);
    if (preset && resolveEnvValue(preset.apiKeyEnvVars, env).value) {
      return preset.id;
    }
  }

  return undefined;
}

export function resolveModelProviderConfig(
  input: ResolveModelProviderConfigInput,
): ResolvedModelProviderConfig {
  const preset = findModelProviderPreset(input.provider);
  if (!preset) {
    throw new Error(
      `未知模型 provider: ${input.provider}。可用 provider: ${MODEL_PROVIDER_PRESETS.map((item) => item.id).join(", ")}。`,
    );
  }

  const env = input.env ?? process.env;
  const apiKeyFromEnv = resolveEnvValue(preset.apiKeyEnvVars, env);
  const baseURLFromEnv = resolveEnvValue(preset.baseURLEnvVars, env);
  const modelFromEnv = resolveEnvValue(preset.modelEnvVars, env);
  const apiKey = normalizeOptional(input.apiKey) ?? apiKeyFromEnv.value;
  const baseURL = normalizeOptional(input.baseURL) ?? baseURLFromEnv.value ?? preset.defaultBaseURL;
  const model = normalizeOptional(input.model) ?? modelFromEnv.value ?? preset.defaultModel;

  return {
    providerId: preset.id,
    displayName: preset.displayName,
    protocol: preset.protocol,
    model,
    apiKey,
    baseURL,
    apiKeySource: normalizeOptional(input.apiKey) ? "cli" : apiKeyFromEnv.source,
    baseURLSource: normalizeOptional(input.baseURL)
      ? "cli"
      : (baseURLFromEnv.source ?? (preset.defaultBaseURL ? "preset" : undefined)),
    modelSource: normalizeOptional(input.model) ? "cli" : (modelFromEnv.source ?? "preset"),
    preset,
  };
}

export function createModelProvider(config: ResolvedModelProviderConfig): ModelProvider {
  if (!config.apiKey) {
    throw new Error(
      [
        `模型 provider ${config.providerId} 缺少 API key。`,
        `请使用 --api-key、--api-key-env, 或设置环境变量: ${config.preset.apiKeyEnvVars.join(", ")}。`,
      ].join(" "),
    );
  }

  if (config.preset.requiresBaseURL && !config.baseURL) {
    throw new Error(
      [
        `模型 provider ${config.providerId} 缺少 base URL。`,
        "请使用 --base-url 或设置对应环境变量。",
      ].join(" "),
    );
  }

  return new OpenAICompatibleModelProvider({
    providerId: config.providerId,
    displayName: config.displayName,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultModel: config.model,
  });
}

function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveEnvValue(
  names: readonly string[],
  env: Record<string, string | undefined>,
): { value?: string; source?: string } {
  for (const name of names) {
    const value = normalizeOptional(env[name]);
    if (value) {
      return { value, source: name };
    }
  }

  return {};
}

function toOpenAITools(
  tools: ToolModelSpec[],
  reverseNameMap: Map<string, string>,
): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    const openAIName = sanitizeOpenAIToolName(tool.name);
    reverseNameMap.set(openAIName, tool.name);
    return {
      type: "function",
      function: {
        name: openAIName,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  });
}

function sanitizeOpenAIToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "__").slice(0, 64);
}

function parseJsonObject(json: string): unknown {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 80) {
    chunks.push(text.slice(index, index + 80));
  }
  return chunks;
}
