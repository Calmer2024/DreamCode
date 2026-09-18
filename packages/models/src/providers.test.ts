import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDeepSeekProviderRequest,
  buildProviderRequest,
  buildProviderRequestWithMedia,
  createModelProvider,
  DeepSeekModelProvider,
  detectConfiguredProvider,
  findModelProviderPreset,
  listModelProviderPresets,
  normalizeOpenAIUsage,
  resolveModelProviderConfig,
} from "./index";

describe("模型 provider preset", () => {
  it("列出国产 provider 和自定义兼容入口", () => {
    const ids = listModelProviderPresets().map((preset) => preset.id);

    expect(ids).toContain("deepseek");
    expect(ids).toContain("qwen");
    expect(ids).toContain("kimi");
    expect(ids).toContain("zhipu");
    expect(ids).toContain("siliconflow");
    expect(ids).toContain("minimax");
    expect(ids).toContain("openai-compatible");
  });

  it("通过别名解析 provider", () => {
    expect(findModelProviderPreset("moonshot")?.id).toBe("kimi");
    expect(findModelProviderPreset("dashscope")?.id).toBe("qwen");
    expect(findModelProviderPreset("zai")?.id).toBe("zhipu");
  });

  it("非自定义 provider 的默认模型包含在 TUI 候选模型中", () => {
    for (const preset of listModelProviderPresets()) {
      if (preset.id === "openai-compatible") {
        continue;
      }

      expect(preset.models?.map((model) => model.id)).toContain(preset.defaultModel);
    }
  });

  it("CLI 参数优先于环境变量和 preset 默认值", () => {
    const config = resolveModelProviderConfig({
      provider: "deepseek",
      apiKey: "cli-key",
      baseURL: "https://example.com/v1",
      model: "deepseek-v4-flash",
      env: {
        DEEPSEEK_API_KEY: "env-key",
        DEEPSEEK_MODEL: "env-model",
      },
    });

    expect(config.providerId).toBe("deepseek");
    expect(config.apiKey).toBe("cli-key");
    expect(config.apiKeySource).toBe("cli");
    expect(config.baseURL).toBe("https://example.com/v1");
    expect(config.baseURLSource).toBe("cli");
    expect(config.model).toBe("deepseek-flash");
    expect(config.modelSource).toBe("cli");
  });

  it("可以从 provider 专属环境变量解析配置", () => {
    const config = resolveModelProviderConfig({
      provider: "qwen",
      env: {
        DASHSCOPE_API_KEY: "dashscope-key",
        QWEN_MODEL: "qwen-custom",
      },
    });

    expect(config.apiKey).toBe("dashscope-key");
    expect(config.apiKeySource).toBe("DASHSCOPE_API_KEY");
    expect(config.model).toBe("qwen-custom");
    expect(config.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("按已配置 API key 自动探测默认 provider", () => {
    expect(detectConfiguredProvider({ DEEPSEEK_API_KEY: "key" })).toBe("deepseek");
    expect(detectConfiguredProvider({ DASHSCOPE_API_KEY: "key" })).toBe("qwen");
    expect(detectConfiguredProvider({ OPENAI_API_KEY: "key" })).toBe("openai");
  });

  it("创建真实 provider 时要求 API key", () => {
    const config = resolveModelProviderConfig({
      provider: "deepseek",
      env: {},
    });

    expect(() => createModelProvider(config)).toThrow(/API key/);
  });

  it("标准化 OpenAI-compatible 流式 token usage", () => {
    expect(
      normalizeOpenAIUsage({ prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 }),
    ).toEqual({ inputTokens: 1200, outputTokens: 80, totalTokens: 1280 });
  });

  it("解析 DeepSeek reasoning token usage", () => {
    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        completion_tokens_details: { reasoning_tokens: 50 },
      }),
    ).toMatchObject({ reasoningTokens: 50 });
  });

  it("保留缓存命中的输入 token，并区分未缓存输入", () => {
    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        prompt_tokens_details: { cached_tokens: 900 },
      }),
    ).toMatchObject({
      inputTokens: 1200,
      cachedInputTokens: 900,
      uncachedInputTokens: 300,
      outputTokens: 80,
      totalTokens: 1280,
    });
    expect(normalizeOpenAIUsage({ prompt_tokens: 12 })?.cachedInputTokens).toBeUndefined();
  });

  it("为多模态消息估算传输开销且不暴露本机路径", () => {
    const request = buildDeepSeekProviderRequest({
      model: "vision-model",
      tools: [],
      messages: [{
        role: "user",
        content: "比较这些内容",
        attachments: [{
          id: "attachment_1",
          name: "photo.png",
          kind: "image",
          mimeType: "image/png",
          size: 1024,
          sha256: "abc",
          relativePath: "attachments/attachment_1/original.png",
          sendRelativePath: "attachments/attachment_1/send.png",
          sourcePath: "C:\\Users\\secret\\send.png",
        }],
      }],
    });
    const serialized = JSON.stringify(request.messages);
    expect(serialized).toContain("photo.png");
    expect(serialized).not.toContain("Users");
  });

  it("在发送时把图片内容序列化为 data URL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dreamcode-provider-media-"));
    const sourcePath = path.join(directory, "send.png");
    await writeFile(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const request = await buildProviderRequestWithMedia({
        model: "vision-model",
        tools: [],
        messages: [{
          role: "user",
          content: "查看图片",
          attachments: [{
            id: "attachment_1",
            name: "photo.png",
            kind: "image",
            mimeType: "image/png",
            size: 4,
            sha256: "abc",
            relativePath: "attachments/attachment_1/original.png",
            sendRelativePath: "attachments/attachment_1/send.png",
            sourcePath,
          }],
        }],
      }, "openai");
      const serialized = JSON.stringify(request.messages);
      expect(serialized).toContain("data:image/png;base64,iVBORw==");
      expect(serialized).toContain("附件 1：photo.png");
      expect(serialized).not.toContain(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("在 DeepSeek 工具调用历史中保留 reasoning_content", () => {
    const request = buildDeepSeekProviderRequest({
      model: "deepseek-flash",
      tools: [],
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "file.read", input: { file_path: "README.md" } }],
          reasoningContent: "先读取 README，再继续处理。",
        } as any,
      ],
    });

    expect(request.messages[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "先读取 README，再继续处理。",
    });
  });

  it("不为没有工具调用的 assistant 回传 reasoning_content", () => {
    const request = buildProviderRequest({
      model: "deepseek-flash",
      tools: [],
      messages: [
        {
          role: "assistant",
          content: "完成了。",
          reasoningContent: "内部推理不应随普通文本回传。",
        } as any,
      ],
    });

    expect(request.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("发送 DeepSeek thinking 参数并解析 reasoning 与工具调用流", async () => {
    const create = vi.fn().mockResolvedValue((async function* () {
      yield { choices: [{ delta: { reasoning_content: "先检查 " } }] };
      yield { choices: [{ delta: { reasoning_content: "工具结果。" } }] };
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "file__read", arguments: '{"file_path":"README.md"}' },
            }],
          },
        }],
      };
      yield { choices: [{ delta: { content: "完成。" } }] };
      yield {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      };
    })());
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      defaultModel: "deepseek-flash",
      client,
    });
    const events = [];
    for await (const event of provider.stream({
      messages: [{ role: "user", content: "读取 README" }],
      tools: [{ name: "file.read", description: "read", inputSchema: { type: "object" } }],
      model: "deepseek-flash",
      mode: "workspace-write",
      workspaceRoot: "/repo",
    })) {
      events.push(event);
    }

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-flash",
        extra_body: { thinking: { type: "enabled" } },
      }),
      undefined,
    );
    expect(events).toEqual(expect.arrayContaining([
      { type: "reasoning_delta", text: "先检查 " },
      { type: "reasoning_delta", text: "工具结果。" },
      { type: "reasoning_done", content: "先检查 工具结果。" },
      { type: "text_delta", text: "完成。" },
      expect.objectContaining({
        type: "tool_call",
        toolCall: expect.objectContaining({
          id: "call_1",
          name: "file.read",
          input: { file_path: "README.md" },
          rawProvider: "deepseek",
        }),
      }),
      expect.objectContaining({
        type: "usage",
        usage: expect.objectContaining({ reasoningTokens: 12 }),
      }),
    ]));
  });

  it("拒绝不在 DeepSeek 模型目录中的模型 ID", () => {
    expect(() => resolveModelProviderConfig({ provider: "deepseek", model: "deepseek-custom" }))
      .toThrow("deepseek-flash, deepseek-v4-pro");
  });
});
