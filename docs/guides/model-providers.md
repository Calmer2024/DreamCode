# DreamCode 模型 Provider 配置指南

版本: v0.1  
日期: 2026-07-09  
状态: 第一阶段已实现

## 1. 目标

DreamCode 的模型层不直接绑定某一家模型厂商。第一阶段已经把真实模型调用收敛到 OpenAI-compatible 协议适配器, 再通过 provider preset 解决不同厂商的 `base URL`、默认模型、环境变量和别名。

这样做的收益:

- Agent 主循环只依赖统一的 `ModelProvider` 接口。
- 工具调用统一归一化为 `NormalizedToolCall`。
- CLI 可以通过 TUI 直接选择 provider 和模型；已知 provider 的 base URL 由 preset 内置；API key 默认明文保存到本地 config.json。
- 新增国产模型 provider 时优先增加 preset, 不改核心运行时。

## 2. CLI 配置入口

查看可用 provider:

```bash
pnpm dreamcode --list-providers
```

进入交互式 REPL 并使用 `/llm` 配置真实模型:

```bash
pnpm dreamcode
```

在 REPL 中输入:

```text
/llm
```

`/llm` 会引导用户:

- 使用方向键选择 provider。
- 使用方向键选择内置模型列表中的 model。
- 对已知 provider 直接使用 preset 中的 base URL；仅自定义 `openai-compatible` 入口需要输入 base URL。
- 粘贴 API key, 默认明文保存到 config.json；已有 config.json API key 时可选择保留或替换。

配置会保存到:

```text
~/.dreamcode/config.json
```

基础格式:

```bash
pnpm dreamcode --provider <provider> --model <model> "任务提示词"
```

直接传入 API key:

```bash
pnpm dreamcode --provider deepseek --model deepseek-v4-pro --api-key "你的 API key" "分析当前项目"
```

脚本或临时运行时仍可从指定环境变量读取 API key:

```bash
pnpm dreamcode --provider deepseek --api-key-env DEEPSEEK_API_KEY --model deepseek-v4-pro "分析当前项目"
```

覆盖 base URL:

```bash
pnpm dreamcode --provider openai-compatible --base-url "https://example.com/v1" --model "vendor-model" --api-key-env VENDOR_API_KEY "分析当前项目"
```

API key 直接写在命令行中可能进入 shell 历史记录。交互式 `/llm` 默认把 API key 保存到 `~/.dreamcode/config.json`。

## 3. 配置优先级

同一项配置的优先级:

1. CLI 参数。
2. `~/.dreamcode/config.json` 中当前 profile。
3. provider 专属环境变量。
4. `DREAMCODE_*` 通用环境变量。
5. provider preset 默认值。

示例:

- `--model deepseek-v4-flash` 会覆盖 `DEEPSEEK_MODEL`。
- `/llm` 保存的 `model` 会优先于 provider 默认模型。
- `DEEPSEEK_API_KEY` 会优先于 `DREAMCODE_API_KEY`, 但不会覆盖 CLI 传入的 `--api-key`。
- `--base-url` 会覆盖 preset 中的默认 base URL。

示例配置文件:

```json
{
  "version": 1,
  "currentProfile": "deepseek",
  "profiles": {
    "deepseek": {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "apiKey": "sk-your-api-key",
      "baseURL": "https://api.deepseek.com"
    }
  }
}
```

## 4. 已内置 Provider Preset

| Provider | 默认模型 | 默认 base URL | 常用 API key 环境变量 |
| --- | --- | --- | --- |
| `openai` | `gpt-5.5` | OpenAI SDK 默认值 | `OPENAI_API_KEY` |
| `deepseek` | `deepseek-v4-pro` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `qwen` | `qwen3.7-plus` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| `kimi` | `kimi-k2.7-code-highspeed` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
| `zhipu` | `glm-5.2` | `https://api.z.ai/api/paas/v4/` | `ZAI_API_KEY` |
| `siliconflow` | `deepseek-ai/DeepSeek-V3.2` | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` |
| `minimax` | `MiniMax-M3` | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` |
| `openai-compatible` | `gpt-5.5` | 必须显式配置 | `OPENAI_COMPATIBLE_API_KEY` |

常用别名:

- `moonshot` -> `kimi`
- `dashscope`、`aliyun`、`alibaba` -> `qwen`
- `zai`、`z.ai`、`glm` -> `zhipu`
- `custom`、`compatible` -> `openai-compatible`

## 5. DeepSeek 实际验收

建议复制 fixture 到临时目录, 避免真实验收污染原 fixture:

```powershell
$temp = Join-Path $env:TEMP ("dreamcode-deepseek-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
Copy-Item -Path evals\fixtures\failing-test-js\* -Destination $temp -Recurse
```

先用交互式配置写入 API key:

```powershell
pnpm dreamcode --cwd $temp
```

在 REPL 中输入 `/llm`, 使用方向键选择 `deepseek`, model 选择 `deepseek-v4-pro`, 然后粘贴 API key 保存到 config.json。保存后可以直接输入任务, 或退出 REPL 后运行:

```powershell
pnpm dreamcode --provider deepseek --model deepseek-v4-pro --cwd $temp "修复当前项目的测试失败, 并运行测试确认。"
```

在 REPL 中可直接输入:

```text
修复当前项目的测试失败, 并运行测试确认。
```

验收观察点:

- CLI 输出显示 `模型: deepseek / deepseek-v4-pro`。
- 模型能发起 `file.read`、`file.patch`、`shell.run` 等工具调用。
- 权限引擎对低风险 workspace 操作自动允许。
- `src/math.js` 被修复。
- `npm test` 返回成功。
- 最终总结包含变更文件、执行命令和事件日志路径。

## 6. 架构边界

`packages/models` 只负责:

- provider preset 解析。
- OpenAI-compatible 客户端创建。
- 流式文本增量输出。
- 工具调用归一化。
- usage 事件预留。

`packages/models` 不负责:

- 执行工具。
- 判断权限。
- 读取或写入工作区文件。
- 决定任务何时结束。

这些职责分别由 `packages/core`、`packages/tools`、`packages/safety` 和 `packages/context` 承担。

## 7. 后续增强

后续可以继续补强:

- 配置文件中的 provider profiles。
- 多模型 router 和 fallback。
- Anthropic-compatible 协议适配。
- Responses API 适配。
- provider-specific 参数, 例如 thinking、reasoning effort、temperature 限制。
- 更完整的 tool result continuation 协议。

## 8. 参考来源

- [OpenAI Models 文档](https://developers.openai.com/api/docs/models)
- [DeepSeek Chat Completion 文档](https://api-docs.deepseek.com/api/create-chat-completion)
- [阿里云百炼模型选择文档](https://help.aliyun.com/zh/model-studio/models)
- [阿里云百炼 Qwen-Coder 文档](https://help.aliyun.com/zh/model-studio/qwen-coder)
- [Kimi API Overview](https://platform.kimi.ai/docs/api/overview)
- [Z.AI OpenAI SDK 文档](https://docs.z.ai/guides/develop/openai/python)
- [SiliconFlow Chat Completions 文档](https://docs.siliconflow.cn/en/api-reference/chat-completions/chat-completions)
- [MiniMax OpenAI SDK 文档](https://platform.minimax.io/docs/api-reference/text-openai-api)
