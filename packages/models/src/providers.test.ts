import { describe, expect, it } from "vitest";
import {
  createModelProvider,
  detectConfiguredProvider,
  findModelProviderPreset,
  listModelProviderPresets,
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
});
