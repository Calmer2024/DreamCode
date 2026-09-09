import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildProviderRequest,
  buildProviderRequestWithMedia,
  createModelProvider,
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
      model: "deepseek-custom",
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
    expect(config.model).toBe("deepseek-custom");
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
    const request = buildProviderRequest({
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
});
