# DreamCode

DreamCode 是一个 TypeScript 优先的本地 CLI Agent 运行时 MVP。第一阶段聚焦一个小而真实的闭环: 创建会话、构建上下文、调用模型 provider、通过权限引擎执行工具调用、写入 JSONL 事件日志, 并返回带证据的最终总结。

## 快速开始

```bash
pnpm install
pnpm dreamcode --provider fake --cwd evals/fixtures/failing-test-js "修复当前项目的测试失败, 并运行测试确认。"
```

进入交互式 DreamCode shell:

```bash
pnpm dreamcode
```

常用 slash 命令:

```text
/llm       选择 provider/model 并配置 API key
/status    查看当前 cwd、mode、model 和配置文件路径
/mode MODE 切换模式: plan | guided | yolo | full
/cwd PATH  切换工作区目录
/clear     清空当前 REPL 的对话摘要
/config    显示配置文件路径
/exit      退出
```

`/llm` 使用方向键选择 provider/model, 并默认把 API key 明文保存到 `~/.dreamcode/config.json`。后续可以直接运行 `pnpm dreamcode` 使用已保存的模型配置。

构建并运行编译后的 CLI:

```bash
pnpm build
node packages/cli/dist/main.js --provider fake --cwd evals/fixtures/readme-update "根据 package.json 和源码更新 README 的使用说明。"
```

查看可用模型 provider:

```bash
pnpm dreamcode --list-providers
```

使用 DeepSeek 做真实验收:

```powershell
pnpm dreamcode
# 在 REPL 中输入 /llm, 用方向键选择 deepseek / deepseek-v4-pro, 粘贴 API key 保存到 config.json。
# 然后输入:
# 根据 package.json 和源码更新 README 的使用说明。
```

也可以直接在 CLI 中传入 API key。注意这种方式可能进入 shell 历史记录, 日常使用更推荐 `/llm` 写入本地 config.json:

```powershell
pnpm dreamcode --provider deepseek --model deepseek-v4-pro --api-key "你的 DeepSeek API Key" "分析当前项目结构"
```

## MVP 能力

- CLI 入口: `dreamcode [prompt...] --mode plan|guided|yolo|full --cwd <path>`。
- 无 prompt 时进入交互式 REPL, 支持持续对话和 slash command。
- 流式 CLI 输出: 展示模型文本、工具调用、权限决策、工具状态、文件变更和最终总结。
- 持久配置: `~/.dreamcode/config.json`, 支持 `/llm` 保存 provider/model/API key 配置。
- JSONL 事件日志: `~/.dreamcode/sessions/<session-id>/events.jsonl`。
- Agent 主循环: 支持停止限制、多轮模型/工具循环, 并把工具观察结果回灌到上下文。
- Fake 模型 provider: 用于确定性的集成测试。
- OpenAI-compatible 模型 provider 基础设施:
  - 内置 `openai`、`deepseek`、`qwen`、`kimi`、`zhipu`、`siliconflow`、`minimax` preset。
  - 支持 `openai-compatible` 自定义 provider。
  - CLI 支持 `--provider`、`--model`、`--api-key`、`--api-key-env`、`--base-url`、`--list-providers`。
- Tool Registry: 注册经过 Zod 校验的内置工具:
  - `file.read`, `file.write`, `file.patch`, `file.list`
  - `search.grep`, `search.glob`
  - `shell.run`
  - `git.status`, `git.diff`
  - `todo.write`, `question.ask`
- Permission Engine: 实现 Safe YOLO v0 规则:
  - 自动允许低风险 workspace 读写、搜索、只读 git、常见 test/lint/build 命令。
  - 对安装依赖、未知 shell 命令、疑似网络命令、workspace 外读取进行询问。
  - 拒绝 secret 读取、workspace 外写入、递归危险删除、强推、硬重置等高风险动作。
- Context Builder: 构建 workspace 摘要、加载 `DREAMCODE.md`、包含 todo 状态并压缩工具观察结果。
- Eval fixtures: 覆盖失败测试修复、README 更新和安全拦截。

## 验证

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

当前测试覆盖:

- `~/.dreamcode/config.json` 的配置读写和 active profile。
- permission allow/ask/deny 与 workspace path boundary。
- file patch 的 changed-file 记录。
- shell timeout 处理。
- fake model 端到端修复失败的 JavaScript 测试。
- secret 读取和破坏性删除的拒绝逻辑。
- OpenAI-compatible tool schema 顶层 object 兼容性。
- 写入后重复只读检查的停止保护。

真实模型链路评测见 [docs/evals/real-model-cinemo-eval.md](docs/evals/real-model-cinemo-eval.md)。fake model 只作为确定性运行时回归, 真实能力以 DeepSeek 读取和理解 `D:\Files\Github\Cinemo`、连续问答、写入项目文档的闭环为准。

## 包结构

```text
packages/
  cli/       CLI 参数解析和终端流式渲染
  core/      Agent 主循环、会话编排、最终总结
  context/   上下文构建器和压缩辅助函数
  models/    fake 与 OpenAI-compatible 模型 provider
  safety/    权限引擎、路径边界、命令分类器
  shared/    共享类型、schema、id、事件
  store/     JSONL 事件日志和会话目录辅助函数
  tools/     工具注册表和内置工具
```
