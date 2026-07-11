#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { type ApprovalRequest, runTurn } from "@dreamcode/core";
import {
  createDefaultFakeProvider,
  createModelProvider,
  detectConfiguredProvider,
  findModelProviderPreset,
  listModelProviderPresets,
  type ModelProviderPreset,
  resolveModelProviderConfig,
} from "@dreamcode/models";
import type { AgentEvent, FinalSummary, ModelProvider, RunMode } from "@dreamcode/shared";
import { runModeSchema, toErrorMessage } from "@dreamcode/shared";
import {
  type DreamCodeConfig,
  type DreamCodeLlmProfile,
  getActiveLlmProfile,
  getConfigPath,
  getDreamCodeHome,
  getIndexPath,
  listSessions,
  loadDreamCodeConfig,
  readReplayedSession,
  rebuildSessionIndex,
  rollbackSession,
  saveDreamCodeConfig,
  upsertLlmProfile,
} from "@dreamcode/store";
import { createDefaultToolRegistry } from "@dreamcode/tools";
import { Command } from "commander";
import { runInkTui } from "./tui.js";

interface CliOptions {
  mode: string;
  cwd: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxToolCalls: string;
  home?: string;
  listProviders?: boolean;
  tui?: boolean;
}

interface LlmOptions {
  provider?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}

interface ReplState {
  config: DreamCodeConfig;
  transientProfile?: DreamCodeLlmProfile;
  workspaceRoot: string;
  mode: RunMode;
  home?: string;
  maxToolCalls: number;
  conversation: ConversationEntry[];
}

interface ConversationEntry {
  user: string;
  status: FinalSummary["status"];
  assistant: string;
}

type PromptInterface = ReturnType<typeof createInterface>;

interface SelectChoice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export async function main(argv = process.argv): Promise<void> {
  const program = new Command();
  let handledSubcommand = false;
  const rootPromptMode = shouldTreatAsRootPrompt(argv);
  program
    .name("dreamcode")
    .description("DreamCode 本地 CLI Agent 运行时 MVP")
    .argument("[prompt...]", "任务提示词")
    .option("--mode <mode>", "plan | guided | yolo | full", "yolo")
    .option("--cwd <path>", "工作区根目录", process.cwd())
    .option("--model <model>", "模型名称")
    .option(
      "--provider <provider>",
      "fake | openai | deepseek | qwen | kimi | zhipu | siliconflow | minimax | openai-compatible",
    )
    .option("--api-key <key>", "直接传入模型 API key。注意: 可能进入 shell 历史记录")
    .option("--api-key-env <name>", "从指定环境变量读取模型 API key")
    .option("--base-url <url>", "覆盖模型 provider 的 OpenAI-compatible base URL")
    .option("--list-providers", "列出可用模型 provider preset")
    .option("--max-tool-calls <count>", "最大工具调用次数", "80")
    .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
    .option("--no-tui", "无 prompt 时禁用 Ink TUI, 使用旧版 REPL")
    .showHelpAfterError()
    .action(() => {});

  if (!rootPromptMode) {
    program
      .command("sessions")
      .description("列出 DreamCode 历史 session")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .option("--cwd <path>", "只显示指定工作区")
      .option("--status <status>", "按状态筛选")
      .action(async (options: { home?: string; cwd?: string; status?: string }) => {
        handledSubcommand = true;
        await printSessions(options);
      });

    program
      .command("show <sessionId>")
      .description("显示 session 的重放摘要")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .action(async (sessionId: string, options: { home?: string }) => {
        handledSubcommand = true;
        await printSession(sessionId, options.home);
      });

    program
      .command("resume [sessionId] [prompt...]")
      .description("恢复一个历史 session 并追加新 turn")
      .option("--last", "恢复最近一个 session")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .option("--mode <mode>", "plan | guided | yolo | full", "yolo")
      .option("--model <model>", "模型名称")
      .option("--provider <provider>", "模型 provider")
      .option("--api-key <key>", "直接传入模型 API key")
      .option("--api-key-env <name>", "从指定环境变量读取模型 API key")
      .option("--base-url <url>", "覆盖模型 provider base URL")
      .option("--max-tool-calls <count>", "最大工具调用次数", "80")
      .action(
        async (
          sessionId: string | undefined,
          promptParts: string[],
          options: CliOptions & { last?: boolean },
        ) => {
          handledSubcommand = true;
          await resumeSessionCommand(sessionId, promptParts, options);
        },
      );

    program
      .command("diff <sessionId>")
      .description("显示 session 文件变更 diff")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .option("--file <path>", "只显示单个文件")
      .action(async (sessionId: string, options: { home?: string; file?: string }) => {
        handledSubcommand = true;
        await printSessionDiff(sessionId, options);
      });

    program
      .command("rollback <sessionId>")
      .description("回滚 session 修改过的文件")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .option("--file <path>", "回滚单个文件")
      .option("--all", "回滚所有文件")
      .option("--force", "当前文件 hash 不匹配时仍强制回滚")
      .action(
        async (
          sessionId: string,
          options: { home?: string; file?: string; all?: boolean; force?: boolean },
        ) => {
          handledSubcommand = true;
          const result = await rollbackSession({
            sessionId,
            home: options.home,
            filePath: options.file,
            all: options.all,
            force: options.force,
          });
          console.log(`已回滚 session ${result.sessionId}`);
          for (const file of result.rolledBackFiles) {
            console.log(`- ${file}`);
          }
          for (const skipped of result.skippedFiles) {
            console.log(`跳过 ${skipped.path}: ${skipped.reason}`);
          }
        },
      );

    const index = program.command("index").description("维护 DreamCode 派生索引");
    index
      .command("rebuild")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .action(async (options: { home?: string }) => {
        handledSubcommand = true;
        const rebuilt = await rebuildSessionIndex(options.home);
        console.log(`已重建索引: ${getIndexPath(options.home)}`);
        console.log(`session 数量: ${rebuilt.sessions.length}`);
      });

    const skills = program.command("skills").description("查看本地 DreamCode skills");
    skills
      .command("list")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .option("--cwd <path>", "工作区根目录", process.cwd())
      .action(async (options: { home?: string; cwd: string }) => {
        handledSubcommand = true;
        await runToolCommand("skill.list", {}, options);
      });
    skills
      .command("show <name>")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .option("--cwd <path>", "工作区根目录", process.cwd())
      .action(async (name: string, options: { home?: string; cwd: string }) => {
        handledSubcommand = true;
        await runToolCommand("skill.read", { name }, options);
      });

    const mcp = program.command("mcp").description("查看配置的 MCP server");
    mcp
      .command("list")
      .option("--home <path>", "DreamCode 状态目录, 默认 ~/.dreamcode")
      .action(async (options: { home?: string }) => {
        handledSubcommand = true;
        const config = await loadDreamCodeConfig(options.home);
        await runToolCommand("mcp.list", {}, { home: options.home, cwd: process.cwd(), config });
      });
  }

  await program.parseAsync(argv);
  if (handledSubcommand) {
    return;
  }
  const options = program.opts<CliOptions>();

  if (options.listProviders) {
    printProviderList();
    return;
  }

  const mode = runModeSchema.parse(options.mode);
  const maxToolCalls = parseMaxToolCalls(options.maxToolCalls);
  const config = await loadDreamCodeConfig(options.home);
  const prompt = program.args.join(" ").trim();

  if (!prompt) {
    if (shouldRunTui(options)) {
      const transientProfile = createTransientProfile(options, config);
      await runInkTui({
        version: "0.1.0",
        config,
        workspaceRoot: path.resolve(options.cwd),
        mode,
        home: options.home,
        maxToolCalls,
        createProvider: (nextPrompt: string) =>
          createCliProvider(nextPrompt, options, config, transientProfile),
      });
      return;
    }
    await runInteractiveShell({ options, config, mode, maxToolCalls });
    return;
  }

  const { provider, model } = createCliProvider(prompt, options, config);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    for await (const event of runTurn({
      prompt,
      workspaceRoot: path.resolve(options.cwd),
      provider,
      model,
      mode,
      home: options.home,
      maxToolCalls,
      registry: createDefaultToolRegistry({ mcpServers: config.mcpServers }),
      approvalHandler: (request: ApprovalRequest) => askApproval(rl, request),
      questionHandler: async (question: string) =>
        (await questionOrUndefined(rl, `\n? ${question}\n> `)) ?? "",
    })) {
      renderEvent(event);
    }
  } finally {
    rl.close();
  }
}

async function runInteractiveShell(input: {
  options: CliOptions;
  config: DreamCodeConfig;
  mode: RunMode;
  maxToolCalls: number;
}): Promise<void> {
  const state: ReplState = {
    config: input.config,
    transientProfile: createTransientProfile(input.options, input.config),
    workspaceRoot: path.resolve(input.options.cwd),
    mode: input.mode,
    home: input.options.home,
    maxToolCalls: input.maxToolCalls,
    conversation: [],
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  printReplWelcome(state);

  try {
    while (true) {
      const answer = await questionOrUndefined(rl, "\ndreamcode> ");
      if (answer === undefined) {
        return;
      }
      const line = answer.trim();
      if (!line) {
        continue;
      }

      if (line.startsWith("/")) {
        const shouldContinue = await handleSlashCommand(line, state, rl);
        if (!shouldContinue) {
          return;
        }
        continue;
      }

      await runInteractiveTurn(line, state, rl);
    }
  } finally {
    rl.close();
  }
}

async function runInteractiveTurn(
  prompt: string,
  state: ReplState,
  rl: PromptInterface,
): Promise<void> {
  let finalSummary: FinalSummary | undefined;

  try {
    const { provider, model } = createCliProvider(prompt, {}, state.config, state.transientProfile);
    for await (const event of runTurn({
      prompt,
      workspaceRoot: state.workspaceRoot,
      provider,
      model,
      mode: state.mode,
      conversationSummary: buildConversationSummary(state.conversation),
      home: state.home,
      maxToolCalls: state.maxToolCalls,
      registry: createDefaultToolRegistry({ mcpServers: state.config.mcpServers }),
      approvalHandler: (request: ApprovalRequest) => askApproval(rl, request),
      questionHandler: async (question: string) =>
        (await questionOrUndefined(rl, `\n? ${question}\n> `)) ?? "",
    })) {
      renderEvent(event, { markProcessFailure: false });
      const payload = event.payload as { summary?: FinalSummary };
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        finalSummary = payload.summary;
      }
    }
  } catch (error) {
    console.error(`DreamCode 无法启动本轮任务: ${toErrorMessage(error)}`);
    console.error("可以运行 /llm 配置模型, 或运行 /status 查看当前配置。");
    return;
  }

  if (finalSummary) {
    state.conversation.push({
      user: prompt,
      status: finalSummary.status,
      assistant: finalSummary.message,
    });
    state.conversation = state.conversation.slice(-8);
  }
}

async function handleSlashCommand(
  line: string,
  state: ReplState,
  rl: PromptInterface,
): Promise<boolean> {
  const [rawCommand = "", ...args] = line.slice(1).trim().split(/\s+/);
  const command = rawCommand.toLowerCase();

  switch (command) {
    case "exit":
    case "quit":
    case "q":
      console.log("Bye.");
      return false;
    case "help":
    case "?":
      printSlashHelp();
      return true;
    case "status":
      printReplStatus(state);
      return true;
    case "config":
      console.log(`配置文件: ${getConfigPath(state.home)}`);
      return true;
    case "clear":
      state.conversation = [];
      console.log("已清空当前 REPL 的对话摘要。");
      return true;
    case "cwd":
      updateWorkspaceRoot(state, args.join(" "));
      return true;
    case "mode":
      await updateMode(state, args[0], rl);
      return true;
    case "llm":
      await runLlmWizard(state, rl);
      return true;
    case "sessions":
      await printSessions({ home: state.home, cwd: state.workspaceRoot });
      return true;
    case "diff":
      if (!args[0]) {
        console.log("用法: /diff <session-id>");
        return true;
      }
      await printSessionDiff(args[0], { home: state.home });
      return true;
    case "skills":
      await runToolCommand("skill.list", {}, { home: state.home, cwd: state.workspaceRoot });
      return true;
    case "mcp":
      await runToolCommand(
        "mcp.list",
        {},
        { home: state.home, cwd: state.workspaceRoot, config: state.config },
      );
      return true;
    default:
      console.log(`未知命令: /${command || ""}。输入 /help 查看可用命令。`);
      return true;
  }
}

async function runLlmWizard(state: ReplState, rl: PromptInterface): Promise<void> {
  const activeProfile = state.transientProfile ?? getActiveLlmProfile(state.config);
  const effective = getEffectiveLlmProfile(state.config, state.transientProfile);
  const presets = listModelProviderPresets();

  const provider = await selectChoice(
    rl,
    "选择 LLM Provider",
    [
      {
        value: "fake",
        label: "fake",
        hint: "本地脚本化 provider, 用于离线测试",
      },
      ...presets.map((preset) => ({
        value: preset.id,
        label: `${preset.id} - ${preset.displayName}`,
      })),
    ],
    { defaultValue: effective.provider },
  );

  if (provider === "fake") {
    const nextConfig = upsertLlmProfile(state.config, "fake", { provider: "fake" });
    state.config = nextConfig;
    state.transientProfile = undefined;
    const configPath = await saveDreamCodeConfig(nextConfig, state.home);
    console.log(`已保存 fake provider 到 ${configPath}`);
    return;
  }

  const preset = findModelProviderPreset(provider);
  if (!preset) {
    console.log(`未知 provider: ${provider}`);
    return;
  }

  const profileForProvider =
    activeProfile?.provider === preset.id ? activeProfile : state.config.profiles[preset.id];
  const model = await selectModel(rl, preset, profileForProvider?.model);
  const baseURL = await resolveWizardBaseURL(rl, preset, profileForProvider);
  if (preset.requiresBaseURL && !baseURL) {
    console.log("这个 provider 必须配置 base URL。");
    return;
  }

  const apiKeyConfig = await askApiKeyConfig(rl, {
    providerId: preset.id,
    current: profileForProvider,
  });
  const profile: DreamCodeLlmProfile = {
    provider: preset.id,
    model,
    baseURL,
    ...apiKeyConfig,
  };
  const nextConfig = upsertLlmProfile(state.config, preset.id, profile);
  state.config = nextConfig;
  state.transientProfile = undefined;
  const configPath = await saveDreamCodeConfig(nextConfig, state.home);

  console.log("");
  console.log(`已保存 LLM 配置: ${preset.id} / ${model}`);
  console.log(`配置文件: ${configPath}`);
}

async function selectModel(
  rl: PromptInterface,
  preset: ModelProviderPreset,
  currentModel: string | undefined,
): Promise<string> {
  const choices: SelectChoice<string>[] =
    preset.models?.map((model) => ({
      value: model.id,
      label: model.label ? `${model.label} (${model.id})` : model.id,
      hint: model.description,
    })) ?? [];

  if (currentModel && !choices.some((choice) => choice.value === currentModel)) {
    choices.unshift({
      value: currentModel,
      label: `${currentModel} (当前配置)`,
      hint: "当前配置中的模型, 不在内置候选列表中",
    });
  }

  if (preset.requiresBaseURL) {
    choices.push({
      value: "__custom_model__",
      label: "手动输入自定义模型",
      hint: "用于 DreamCode 未内置的 OpenAI-compatible 服务",
    });
  }

  if (!choices.length) {
    return askCustomModel(rl, currentModel ?? preset.defaultModel);
  }

  const selected = await selectChoice(rl, `选择模型 (${preset.displayName})`, choices, {
    defaultValue: currentModel ?? preset.defaultModel,
  });

  if (selected === "__custom_model__") {
    return askCustomModel(rl, currentModel ?? preset.defaultModel);
  }

  return selected;
}

async function askCustomModel(rl: PromptInterface, fallback: string): Promise<string> {
  const answer = await askWithDefault(rl, "Model", fallback);
  return answer.trim();
}

async function resolveWizardBaseURL(
  rl: PromptInterface,
  preset: ModelProviderPreset,
  current: DreamCodeLlmProfile | undefined,
): Promise<string | undefined> {
  if (!preset.requiresBaseURL) {
    const baseURL = current?.baseURL ?? preset.defaultBaseURL;
    console.log(`Base URL: ${baseURL ?? "OpenAI SDK 默认值"} (provider preset)`);
    return baseURL;
  }

  const fallback = current?.baseURL ?? preset.defaultBaseURL ?? "";
  const answer = await askWithDefault(rl, "Base URL", fallback);
  return normalizeOptional(answer);
}

async function askApiKeyConfig(
  rl: PromptInterface,
  input: {
    providerId: string;
    current?: DreamCodeLlmProfile;
  },
): Promise<Partial<Pick<DreamCodeLlmProfile, "apiKey" | "apiKeyEnv">>> {
  const hasStoredApiKey = Boolean(input.current?.apiKey);
  if (!process.stdin.isTTY) {
    if (hasStoredApiKey) {
      console.log(`API key (${input.providerId}): 保留 config.json 中现有 API key`);
      return { apiKey: input.current?.apiKey };
    }
    console.log(`API key (${input.providerId}): 非交互环境无法粘贴 API key, 本次不保存 API key。`);
    return {};
  }

  const action = await selectChoice(
    rl,
    `API key (${input.providerId})`,
    hasStoredApiKey
      ? [
          {
            value: "keep",
            label: "保留 config.json 中现有 API key",
          },
          {
            value: "replace",
            label: "重新粘贴 API key 并保存到 config.json (明文)",
          },
          {
            value: "skip",
            label: "暂时不保存 API key",
          },
        ]
      : [
          {
            value: "replace",
            label: "粘贴 API key 并保存到 config.json (明文)",
          },
          {
            value: "skip",
            label: "暂时不保存 API key",
          },
        ],
    { defaultValue: hasStoredApiKey ? "keep" : "replace" },
  );

  if (action === "keep") {
    return { apiKey: input.current?.apiKey };
  }

  if (action === "skip") {
    return {};
  }

  if (input.current?.apiKeyEnv && !input.current.apiKey) {
    console.log(
      `当前 profile 使用环境变量 ${input.current.apiKeyEnv}; 本次会改为保存到 config.json。`,
    );
  }
  console.log("注意: 该 API key 会以明文保存在 DreamCode 配置文件 config.json 中。");

  while (true) {
    const apiKeyAnswer = await questionOrUndefined(rl, "API key: ");
    if (apiKeyAnswer === undefined) {
      return {};
    }
    const apiKey = normalizeOptional(apiKeyAnswer);
    if (apiKey) {
      return { apiKey };
    }

    const nextAction = await selectChoice(
      rl,
      "API key 为空",
      [
        {
          value: "retry",
          label: "继续填写 API key",
        },
        {
          value: "skip",
          label: "暂时不保存 API key",
        },
      ],
      { defaultValue: "retry" },
    );

    if (nextAction === "skip") {
      return {};
    }
  }
}

function createCliProvider(
  prompt: string,
  options: LlmOptions,
  config: DreamCodeConfig,
  profileOverride?: DreamCodeLlmProfile,
): { provider: ModelProvider; model?: string } {
  const activeProfile = profileOverride ?? getActiveLlmProfile(config);
  const providerName =
    normalizeOptional(options.provider) ??
    activeProfile?.provider ??
    detectConfiguredProvider(process.env) ??
    "fake";

  if (providerName === "fake") {
    return {
      provider: createDefaultFakeProvider(prompt),
      model: normalizeOptional(options.model) ?? activeProfile?.model,
    };
  }

  const profileForProvider = getProfileForProvider(config, providerName, activeProfile);
  const apiKey = resolveApiKeyOption(options) ?? resolveProfileApiKey(profileForProvider);
  const resolved = resolveModelProviderConfig({
    provider: providerName,
    apiKey,
    baseURL: normalizeOptional(options.baseUrl) ?? profileForProvider?.baseURL,
    model: normalizeOptional(options.model) ?? profileForProvider?.model,
  });

  return {
    provider: createModelProvider(resolved),
    model: resolved.model,
  };
}

function createTransientProfile(
  options: CliOptions,
  config: DreamCodeConfig,
): DreamCodeLlmProfile | undefined {
  if (
    !options.provider?.trim() &&
    !options.model?.trim() &&
    !options.apiKey?.trim() &&
    !options.apiKeyEnv?.trim() &&
    !options.baseUrl?.trim()
  ) {
    return undefined;
  }

  const activeProfile = getActiveLlmProfile(config);
  const provider =
    normalizeOptional(options.provider) ??
    activeProfile?.provider ??
    detectConfiguredProvider(process.env) ??
    "fake";
  const profileForProvider = getProfileForProvider(config, provider, activeProfile);

  return {
    provider,
    model: normalizeOptional(options.model) ?? profileForProvider?.model,
    apiKey: resolveApiKeyOption(options) ?? profileForProvider?.apiKey,
    apiKeyEnv: normalizeOptional(options.apiKeyEnv) ?? profileForProvider?.apiKeyEnv,
    baseURL: normalizeOptional(options.baseUrl) ?? profileForProvider?.baseURL,
  };
}

function getProfileForProvider(
  config: DreamCodeConfig,
  provider: string,
  activeProfile?: DreamCodeLlmProfile,
): DreamCodeLlmProfile | undefined {
  return activeProfile?.provider === provider ? activeProfile : config.profiles[provider];
}

function resolveApiKeyOption(options: LlmOptions): string | undefined {
  if (options.apiKey?.trim()) {
    return options.apiKey.trim();
  }

  if (options.apiKeyEnv?.trim()) {
    const envName = options.apiKeyEnv.trim();
    const value = process.env[envName]?.trim();
    if (!value) {
      throw new Error(`环境变量 ${envName} 未设置, 无法读取模型 API key。`);
    }
    return value;
  }

  return undefined;
}

function resolveProfileApiKey(profile: DreamCodeLlmProfile | undefined): string | undefined {
  if (!profile) {
    return undefined;
  }
  if (profile.apiKeyEnv) {
    return process.env[profile.apiKeyEnv]?.trim() || profile.apiKey;
  }
  return profile.apiKey;
}

function printProviderList(): void {
  console.log("可用模型 provider:");
  console.log("- fake: 本地脚本化 provider, 用于离线测试和 eval。");

  for (const preset of listModelProviderPresets()) {
    const baseURLDescription = preset.requiresBaseURL
      ? "必须显式配置"
      : (preset.defaultBaseURL ?? "OpenAI SDK 默认值");

    console.log(`- ${preset.id}: ${preset.displayName}`);
    console.log(`  默认模型: ${preset.defaultModel}`);
    console.log(`  默认 base URL: ${baseURLDescription}`);
    console.log(`  API key 环境变量: ${preset.apiKeyEnvVars.join(", ")}`);
    if (preset.aliases?.length) {
      console.log(`  别名: ${preset.aliases.join(", ")}`);
    }
  }

  console.log("");
  console.log(
    "配置优先级: CLI 参数 > ~/.dreamcode/config.json > provider 专属环境变量 > DREAMCODE_* 通用环境变量 > preset 默认值。",
  );
}

async function printSessions(options: {
  home?: string;
  cwd?: string;
  status?: string;
}): Promise<void> {
  const sessions = await listSessions({
    home: options.home,
    cwd: options.cwd,
    status: options.status,
    limit: 50,
  });
  if (!sessions.length) {
    console.log("没有找到 DreamCode session。");
    return;
  }
  for (const session of sessions) {
    console.log(
      [
        session.id,
        session.status,
        session.updatedAt,
        `${session.changedFileCount} file(s)`,
        session.title,
      ].join("  "),
    );
    console.log(`  cwd: ${session.workspaceRoot}`);
  }
}

async function printSession(sessionId: string, home?: string): Promise<void> {
  const state = await readReplayedSession(sessionId, home);
  console.log(`session: ${sessionId}`);
  console.log(`status: ${state.status}`);
  console.log(`turns: ${state.turns.length}`);
  if (state.firstPrompt) {
    console.log(`first prompt: ${state.firstPrompt}`);
  }
  if (state.latestSummary) {
    printSummary(state.latestSummary);
  }
  if (state.changedFiles.length) {
    console.log("changed files:");
    for (const file of state.changedFiles) {
      console.log(`- ${file.operation}: ${file.path}`);
    }
  }
  if (state.commands.length) {
    console.log("commands:");
    for (const command of state.commands) {
      console.log(`- ${command.command} -> ${command.exitCode ?? "unknown"}`);
    }
  }
  for (const warning of state.warnings) {
    console.log(`warning: ${warning}`);
  }
}

async function resumeSessionCommand(
  sessionId: string | undefined,
  promptParts: string[],
  options: {
    last?: boolean;
    home?: string;
    mode: string;
    model?: string;
    provider?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    maxToolCalls: string;
  },
): Promise<void> {
  const normalized = normalizeResumeInlineOptions(promptParts, options);
  const effectiveOptions = normalized.options;
  const resolvedSessionId = effectiveOptions.last
    ? await resolveLastSessionId(effectiveOptions.home)
    : normalizeOptional(sessionId);
  if (!resolvedSessionId) {
    throw new Error("请传入 session id, 或使用 dreamcode resume --last。");
  }

  const prompt =
    normalized.promptParts.join(" ").trim() ||
    "继续这个 DreamCode 历史任务。请先根据已有事件确认状态, 然后完成仍未完成的目标。";
  const config = await loadDreamCodeConfig(effectiveOptions.home);
  const mode = runModeSchema.parse(effectiveOptions.mode);
  const maxToolCalls = parseMaxToolCalls(effectiveOptions.maxToolCalls);
  const { provider, model } = createCliProvider(prompt, effectiveOptions, config);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for await (const event of runTurn({
      sessionId: resolvedSessionId,
      prompt,
      workspaceRoot: process.cwd(),
      provider,
      model,
      mode,
      home: effectiveOptions.home,
      maxToolCalls,
      registry: createDefaultToolRegistry({ mcpServers: config.mcpServers }),
      approvalHandler: (request: ApprovalRequest) => askApproval(rl, request),
      questionHandler: async (question: string) =>
        (await questionOrUndefined(rl, `\n? ${question}\n> `)) ?? "",
    })) {
      renderEvent(event);
    }
  } finally {
    rl.close();
  }
}

function normalizeResumeInlineOptions(
  promptParts: string[],
  options: {
    last?: boolean;
    home?: string;
    mode: string;
    model?: string;
    provider?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    maxToolCalls: string;
  },
): {
  promptParts: string[];
  options: {
    last?: boolean;
    home?: string;
    mode: string;
    model?: string;
    provider?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    maxToolCalls: string;
  };
} {
  const nextOptions = { ...options };
  const rest: string[] = [];
  for (let index = 0; index < promptParts.length; index += 1) {
    const token = promptParts[index] ?? "";
    const next = promptParts[index + 1];
    if (token === "--max-tool-calls" && next) {
      nextOptions.maxToolCalls = next;
      index += 1;
      continue;
    }
    if (token === "--mode" && next) {
      nextOptions.mode = next;
      index += 1;
      continue;
    }
    if (token === "--provider" && next) {
      nextOptions.provider = next;
      index += 1;
      continue;
    }
    if (token === "--model" && next) {
      nextOptions.model = next;
      index += 1;
      continue;
    }
    if (token === "--api-key-env" && next) {
      nextOptions.apiKeyEnv = next;
      index += 1;
      continue;
    }
    if (token === "--base-url" && next) {
      nextOptions.baseUrl = next;
      index += 1;
      continue;
    }
    rest.push(token);
  }
  return { promptParts: rest, options: nextOptions };
}

async function resolveLastSessionId(home?: string): Promise<string | undefined> {
  const sessions = await listSessions({ home, limit: 1 });
  return sessions[0]?.id;
}

async function printSessionDiff(
  sessionId: string,
  options: { home?: string; file?: string },
): Promise<void> {
  const state = await readReplayedSession(sessionId, options.home);
  const files = options.file
    ? state.changedFiles.filter((file) => file.path === options.file)
    : state.changedFiles;
  if (!files.length) {
    console.log("这个 session 没有匹配的文件变更。");
    return;
  }
  for (const file of files) {
    console.log(`diff -- ${file.path}`);
    console.log(file.diff ?? "(no diff recorded)");
  }
}

async function runToolCommand(
  toolName: string,
  input: unknown,
  options: { home?: string; cwd: string; config?: DreamCodeConfig },
): Promise<void> {
  const config = options.config ?? (await loadDreamCodeConfig(options.home));
  const registry = createDefaultToolRegistry({ mcpServers: config.mcpServers });
  const tool = registry.get(toolName);
  if (!tool) {
    throw new Error(`工具不存在: ${toolName}`);
  }
  const home = options.home ?? getDreamCodeHome();
  const result = await tool.execute(input, {
    workspaceRoot: path.resolve(options.cwd),
    sessionDir: path.join(home, "sessions", "_cli"),
    mode: "full",
    toolCallId: `cli_${toolName.replace(/\W/g, "_")}`,
  });
  console.log(result.summary);
  if (result.data !== undefined) {
    console.log(JSON.stringify(result.data, null, 2));
  }
}

async function askApproval(rl: PromptInterface, request: ApprovalRequest): Promise<boolean> {
  console.log("");
  console.log(`${request.toolCall.name} 需要权限确认`);
  console.log(`原因: ${request.decision.reason}`);
  console.log(`输入: ${JSON.stringify(request.toolCall.input)}`);

  const answer = await selectChoice(
    rl,
    "本次是否允许",
    [
      { value: "deny", label: "拒绝" },
      { value: "allow", label: "允许本次" },
    ],
    { defaultValue: "deny" },
  );
  return answer === "allow";
}

function renderEvent(event: AgentEvent, options: { markProcessFailure?: boolean } = {}): void {
  const payload = event.payload as Record<string, unknown>;
  const markProcessFailure = options.markProcessFailure ?? true;

  switch (event.type) {
    case "session.created": {
      const session = payload.session as { id: string; workspaceRoot: string; sessionDir: string };
      console.log(`DreamCode 会话 ${session.id}`);
      console.log(`工作区: ${session.workspaceRoot}`);
      console.log(`日志目录: ${session.sessionDir}`);
      break;
    }
    case "session.resumed": {
      const session = payload.session as { id: string; workspaceRoot: string; sessionDir: string };
      console.log(`DreamCode 恢复会话 ${session.id}`);
      console.log(`工作区: ${session.workspaceRoot}`);
      console.log(`日志目录: ${session.sessionDir}`);
      break;
    }
    case "turn.started": {
      const turn = payload.turn as { mode: string };
      console.log(`模式: ${turn.mode}`);
      break;
    }
    case "model.started": {
      console.log(
        `模型: ${String(payload.provider)} / ${String(payload.model)}，可用工具数: ${String(payload.toolCount)}`,
      );
      break;
    }
    case "model.delta":
      process.stdout.write(String(payload.text ?? ""));
      break;
    case "model.tool_call": {
      const toolCall = payload.toolCall as { name: string; input: unknown };
      console.log(`\n→ ${toolCall.name} ${JSON.stringify(toolCall.input)}`);
      break;
    }
    case "permission.decided": {
      const decision = payload.decision as { decision: string; reason: string };
      console.log(`  权限: ${decision.decision} - ${decision.reason}`);
      break;
    }
    case "tool.started":
      console.log(`  运行 ${String(payload.tool)}`);
      break;
    case "tool.completed":
      console.log(`  ${String(payload.status)}: ${String(payload.summary)}`);
      break;
    case "file.changed": {
      const changed = payload.changedFile as { path: string; operation: string };
      console.log(`  文件 ${changed.operation}: ${changed.path}`);
      break;
    }
    case "artifact.created":
      console.log(`  artifact: ${String(payload.path)}`);
      break;
    case "web.source.saved":
      console.log(`  source: ${String(payload.title ?? payload.url ?? payload.path)}`);
      break;
    case "skill.loaded":
      console.log(`  skill: ${String(payload.name)}`);
      break;
    case "file.snapshot.created":
      console.log(`  快照: ${String(payload.path)}`);
      break;
    case "todo.updated":
      console.log("  todo 已更新");
      break;
    case "turn.completed": {
      console.log("");
      printSummary((payload.summary ?? {}) as FinalSummary);
      break;
    }
    case "turn.failed": {
      console.log("");
      console.error(`DreamCode 失败: ${String(payload.error)}`);
      printSummary((payload.summary ?? {}) as FinalSummary);
      if (markProcessFailure) {
        process.exitCode = 1;
      }
      break;
    }
    default:
      break;
  }
}

function printSummary(summary: FinalSummary): void {
  console.log("最终总结");
  console.log(`状态: ${summary.status}`);
  console.log(summary.message);

  if (summary.changedFiles?.length) {
    console.log("变更文件:");
    for (const file of summary.changedFiles) {
      console.log(`- ${file.operation}: ${file.path}`);
    }
  }

  if (summary.commands?.length) {
    console.log("执行命令:");
    for (const command of summary.commands) {
      console.log(`- ${command.command} -> ${command.exitCode ?? "unknown"} (${command.summary})`);
    }
  }

  if (summary.risks?.length) {
    console.log("风险 / 已拦截动作:");
    for (const risk of summary.risks) {
      console.log(`- ${risk}`);
    }
  }

  console.log(`事件日志: ${summary.eventLogPath}`);
}

function printReplWelcome(state: ReplState): void {
  console.log("DreamCode interactive shell");
  printReplStatus(state);
  console.log("输入 /help 查看命令, /llm 配置真实模型, /exit 退出。");
}

function printReplStatus(state: ReplState): void {
  const profile = getEffectiveLlmProfile(state.config, state.transientProfile);
  console.log(`工作区: ${state.workspaceRoot}`);
  console.log(`模式: ${state.mode}`);
  console.log(`模型: ${profile.provider} / ${profile.model ?? "default"}`);
  console.log(`配置文件: ${getConfigPath(state.home)}`);
  console.log(`当前 REPL 对话轮次: ${state.conversation.length}`);
}

function printSlashHelp(): void {
  console.log("可用命令:");
  console.log("/llm       选择 provider/model 并配置 API key");
  console.log("/status    查看当前 cwd、mode、model 和配置文件路径");
  console.log("/mode MODE 切换模式: plan | guided | yolo | full");
  console.log("/cwd PATH  切换工作区目录");
  console.log("/clear     清空当前 REPL 的对话摘要");
  console.log("/sessions  查看当前工作区历史 session");
  console.log("/diff ID   查看 session 文件变更 diff");
  console.log("/skills    列出可用 Skill");
  console.log("/mcp       列出配置的 MCP 工具");
  console.log("/config    显示配置文件路径");
  console.log("/exit      退出");
}

function updateWorkspaceRoot(state: ReplState, inputPath: string): void {
  const next = normalizeOptional(inputPath);
  if (!next) {
    console.log(`当前工作区: ${state.workspaceRoot}`);
    return;
  }
  state.workspaceRoot = path.resolve(next);
  console.log(`工作区已切换到: ${state.workspaceRoot}`);
}

async function updateMode(
  state: ReplState,
  mode: string | undefined,
  rl: PromptInterface,
): Promise<void> {
  if (!mode) {
    state.mode = runModeSchema.parse(
      await selectChoice(
        rl,
        "选择运行模式",
        [
          { value: "plan", label: "plan", hint: "只规划, 不写文件" },
          { value: "guided", label: "guided", hint: "低风险操作自动执行, 写入需确认" },
          { value: "yolo", label: "yolo", hint: "默认模式, 安全边界内自动执行" },
          { value: "full", label: "full", hint: "更少拦截, 适合受信任环境" },
        ],
        { defaultValue: state.mode },
      ),
    );
    console.log(`模式已切换到: ${state.mode}`);
    return;
  }
  state.mode = runModeSchema.parse(mode);
  console.log(`模式已切换到: ${state.mode}`);
}

function getEffectiveLlmProfile(
  config: DreamCodeConfig,
  override?: DreamCodeLlmProfile,
): DreamCodeLlmProfile {
  const active = override ?? getActiveLlmProfile(config);
  const provider = active?.provider ?? detectConfiguredProvider(process.env) ?? "fake";
  if (provider === "fake") {
    return { provider: "fake", model: active?.model };
  }

  const resolved = resolveModelProviderConfig({
    provider,
    apiKey: resolveProfileApiKey(active),
    baseURL: active?.baseURL,
    model: active?.model,
  });

  return {
    provider: resolved.providerId,
    model: resolved.model,
    apiKey: active?.apiKey,
    apiKeyEnv: active?.apiKeyEnv,
    baseURL: resolved.baseURL,
  };
}

function buildConversationSummary(entries: ConversationEntry[]): string {
  if (!entries.length) {
    return "";
  }

  return entries
    .slice(-6)
    .map((entry, index) =>
      [
        `Turn ${index + 1}:`,
        `User: ${entry.user}`,
        `DreamCode status: ${entry.status}`,
        `DreamCode summary: ${entry.assistant}`,
      ].join("\n"),
    )
    .join("\n\n");
}

async function selectChoice<T extends string>(
  rl: PromptInterface,
  title: string,
  choices: readonly SelectChoice<T>[],
  options: { defaultValue?: T } = {},
): Promise<T> {
  if (!choices.length) {
    throw new Error(`${title} 没有可选项。`);
  }

  const defaultIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === options.defaultValue),
  );
  const fallback = choices[defaultIndex] ?? choices[0];
  if (!fallback) {
    throw new Error(`${title} 没有可选项。`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`${title}: ${formatChoiceSummary(fallback)} (非交互环境使用默认值)`);
    return fallback.value;
  }

  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  let selectedIndex = defaultIndex;
  let renderedLines = 0;

  return new Promise<T>((resolve, reject) => {
    const clear = () => {
      if (renderedLines > 0) {
        output.write(`\x1b[${renderedLines}A\x1b[0J`);
      }
    };

    const render = () => {
      clear();
      const lines = [
        `${title} (方向键选择, Enter 确认)`,
        ...choices.map((choice, index) => formatChoiceLine(choice, index === selectedIndex)),
      ];
      output.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      rl.resume();
    };

    const finish = (choice: SelectChoice<T>) => {
      cleanup();
      clear();
      output.write(`${title}: ${choice.label}\n`);
      resolve(choice.value);
    };

    const fail = (error: Error) => {
      cleanup();
      clear();
      reject(error);
    };

    const move = (delta: number) => {
      selectedIndex = (selectedIndex + delta + choices.length) % choices.length;
      render();
    };

    const onKeypress = (_value: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        fail(new Error("用户取消选择。"));
        return;
      }

      switch (key.name) {
        case "up":
        case "k":
          move(-1);
          break;
        case "down":
        case "j":
          move(1);
          break;
        case "return":
        case "enter":
          {
            const choice = choices[selectedIndex] ?? fallback;
            finish(choice);
          }
          break;
        default:
          break;
      }
    };

    rl.pause();
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    render();
  });
}

function formatChoiceLine<T extends string>(choice: SelectChoice<T>, selected: boolean): string {
  const marker = selected ? ">" : " ";
  return `${marker} ${formatChoiceSummary(choice)}`;
}

function formatChoiceSummary<T extends string>(choice: SelectChoice<T>): string {
  return choice.hint ? `${choice.label} - ${choice.hint}` : choice.label;
}

async function askWithDefault(
  rl: PromptInterface,
  question: string,
  defaultValue: string,
): Promise<string> {
  const answer = await questionOrUndefined(rl, `${question} [${defaultValue}]: `);
  return answer?.trim() || defaultValue;
}

async function questionOrUndefined(
  rl: PromptInterface,
  question: string,
): Promise<string | undefined> {
  try {
    return await rl.question(question);
  } catch (error) {
    if (isReadlineClosedError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isReadlineClosedError(error: unknown): boolean {
  return error instanceof Error && error.message === "readline was closed";
}

function parseMaxToolCalls(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--max-tool-calls 必须是正整数, 当前值: ${value}`);
  }
  return parsed;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function shouldRunTui(options: CliOptions): boolean {
  return options.tui !== false && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function shouldTreatAsRootPrompt(argv: string[]): boolean {
  const knownCommands = new Set([
    "sessions",
    "show",
    "resume",
    "diff",
    "rollback",
    "index",
    "skills",
    "mcp",
    "help",
  ]);
  const optionsWithValue = new Set([
    "--mode",
    "--cwd",
    "--model",
    "--provider",
    "--api-key",
    "--api-key-env",
    "--base-url",
    "--max-tool-calls",
    "--home",
  ]);

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return true;
    }
    if (optionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (Array.from(optionsWithValue).some((option) => token.startsWith(`${option}=`))) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (knownCommands.has(token)) {
      return false;
    }
    return true;
  }
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
