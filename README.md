# DreamCode

<p align="center">
  <img src="docs/assets/dreamcode-logo.svg" width="160" alt="DreamCode pixel cat logo" />
</p>

DreamCode 是一个 TypeScript 优先的本地 CLI Agent 运行时 MVP。第一阶段聚焦一个小而真实的闭环: 创建会话、构建上下文、调用模型 provider、通过权限引擎执行工具调用、写入 JSONL 事件日志, 并返回带证据的最终总结。

## 品牌主题

DreamCode 使用紫色像素猫作为品牌标识，黑色像素保留眼睛细节；主题色围绕同一紫色展开，并保留终端 UI 所需的语义色。

| Token | Hex | 用途 |
| --- | --- | --- |
| Brand | `#a855f7` | 主品牌色、运行状态、重点控件 |
| Brand light | `#c084fc` | Logo 高光、标题、强调文字 |
| Brand dark | `#7c3aed` | Logo 阴影、深色状态 |
| Ink | `#0b0b0f` | 深色背景基准 |
| Text | `#f5f3ff` | 主文本 |
| Muted | `#9ca3af` | 次级文本、分隔线 |
| Success | `#6ee7b7` | 成功状态 |
| Warning | `#fbbf24` | 警告状态 |
| Danger | `#f472b6` | 风险、拒绝、错误强调 |

## 快速开始

```bas
pnpm install
pnpm dreamcode --provider fake --cwd evals/fixtures/failing-test-js "修复当前项目的测试失败, 并运行测试确认。"
```

进入交互式 DreamCode shell:

```bash
pnpm dreamcode
```

## Windows 桌面版

桌面版面向 Windows 10/11 x64。开发时先构建 Main、preload 和 Renderer，再启动编译后的 Electron 应用：

桌面端正式 UI 使用 React + Vite 实现。页面编排位于 `packages/desktop/src/renderer/app/App.tsx`，组件位于 `packages/desktop/src/renderer/components`，视觉样式位于 `packages/desktop/src/renderer/app/app.css`。`packages/desktop/index.html` 只是 Vite 的空挂载入口，不是 UI/UX 实现文件；不要在其中或新的 `renderer.html` 中实现产品界面。详细边界见 `packages/desktop/README.md`。

```powershell
pnpm desktop:build
pnpm --dir packages/desktop exec electron dist-main/main/index.js
```

Renderer 热更新使用两个终端：

```powershell
# 终端 1
pnpm --filter @dreamcode/desktop build:main
pnpm desktop:dev

# 终端 2
pnpm --filter @dreamcode/desktop dev:electron
```

确定性验收使用普通 Fake Provider，不需要 API key：

```powershell
pnpm desktop:e2e
```

生成 Windows x64 安装包和便携版：

```powershell
pnpm desktop:dist
pnpm --filter @dreamcode/desktop chain-test
pnpm --filter @dreamcode/desktop checksums
```

输出位于 `packages/desktop/release`：

- `DreamCode-Setup-0.1.0-x64.exe`：双击后按向导完成当前用户安装，可选择安装目录。
- `DreamCode-Portable-0.1.0-x64.exe`：双击即可直接启动，无需安装或管理员权限。
- `chain-test-report.json`：便携版完整任务、命令、重启和 Session 续聊证据。
- `SHA256SUMS.txt`：两个可执行文件的 SHA-256。

桌面版配置与 Session 默认保存在 `%USERPROFILE%\.dreamcode`。API key 可直接保存到配置文件，也可以保存环境变量名；直接保存时为明文，请只在受信任的 Windows 账户中使用。卸载 NSIS 应用不会删除该目录中的配置和 Session 数据；需要清除时由用户自行备份后删除。便携版同样使用这一数据目录，不会把密钥写入可执行文件所在目录。

常用 slash 命令:

```text
/llm       选择 provider/model 并配置 API key
/status    查看当前 cwd、mode、model 和配置文件路径
/mode MODE 切换模式: plan | guided | yolo | full
/cwd PATH  切换工作区目录
/sessions  查看当前工作区历史 session
/diff ID   查看 session 文件变更 diff
/skills    列出可用 Skill
/mcp       刷新并查看配置的 MCP Server 及状态
/clear     清空当前 REPL 的对话摘要
/config    显示配置文件路径
/exit      退出
```

`/llm` 使用方向键选择 provider/model, 并默认把 API key 明文保存到 `~/.dreamcode/config.json`。后续可以直接运行 `pnpm dreamcode` 使用已保存的模型配置。

MCP Server 也保存在这个全局配置中，对所有项目可用。桌面端“设置 → MCP”提供 Server 列表、搜索、启用开关和手动刷新；它只管理已有配置，不在界面内新增或编辑 Server。配置示例：

```json
{
  "version": 3,
  "profiles": {},
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "enabled": false,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"],
      "env": {}
    },
    "remote": {
      "transport": "streamable-http",
      "enabled": false,
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

启用 Server 会建立并维持长期连接，发现到的工具会直接出现在 `tool.list` 对应的 Registry 视图中。远程 HTTP 必须使用 HTTPS，只有 localhost/loopback 可使用 HTTP；当前不支持旧式 SSE transport 或 OAuth。

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
# 在 REPL 中输入 /llm, 用方向键选择 deepseek / deepseek-flash 或 deepseek-v4-pro, 粘贴 API key 保存到 config.json。
# 然后输入:
# 根据 package.json 和源码更新 README 的使用说明。
```

也可以直接在 CLI 中传入 API key。注意这种方式可能进入 shell 历史记录, 日常使用更推荐 `/llm` 写入本地 config.json:

```powershell
pnpm dreamcode --provider deepseek --model deepseek-v4-pro --api-key "你的 DeepSeek API Key" "分析当前项目结构"
```

## LangSmith Trace

已安装的桌面应用使用安装包内的运行时，修改源码不会自动更新它。新增 Trace 功能后，需要重新执行 `pnpm desktop:dist` 并安装新生成的安装包。2026 年 9 月的旧版既不包含 Trace 代码，也会在保存配置时删除不认识的 `langsmith` 字段；请先退出旧版并更新，再填写 LangSmith 配置。`pnpm --filter @dreamcode/desktop chain-test` 会使用模拟密钥和本地 HTTP 接收端验证打包后的桌面应用保留配置并实际上传 Trace。

核心运行时支持完整的每轮 Trace，包含上下文构建、模型请求与响应、首 token 时间、token 用量、工具执行、权限决定、缓存命中和失败/取消状态。每轮对应一个根 Trace，子节点共享 Trace ID；通过 `thread_id`（DreamCode Session ID）和 `turn_id` 关联多轮对话。工具节点带有发起它的 `model_run_id`，并发工具各自保留独立节点。模型返回用量缺失时使用现有估算值，并标记 `usage_estimated`。

可以直接在 `%USERPROFILE%\.dreamcode\config.json` 的顶层增加 `langsmith` 字段，保留原有配置：

```json
"langsmith": {
  "enabled": true,
  "apiKey": "你的 LangSmith API Key",
  "projectName": "DreamCode",
  "hideInputs": false,
  "hideOutputs": false,
  "flushTimeoutMs": 3000
}
```

文件中的 `apiKey` 为明文。也可以将它替换成 `"apiKeyEnv": "MY_LANGSMITH_KEY"`，从指定的环境变量读取密钥。可选的 `endpoint` 和 `workspaceId` 分别指定 API 地址和工作区。CLI、桌面端及本机评测每轮开始时读取配置，因此文件修改从下一轮生效。使用自定义 `home` 时读取该目录中的 `config.json`。

仍然可以在启动 DreamCode 的 PowerShell 中使用环境变量配置或覆盖文件设置：

```powershell
$env:LANGSMITH_TRACING = "true"
$env:LANGSMITH_API_KEY = "你的 LangSmith API Key"
$env:LANGSMITH_PROJECT = "DreamCode"
pnpm dreamcode
```

优先级为单次调用的 `tracing` 参数 > 环境变量 > `config.json` > 默认值，逐字段合并；`LANGSMITH_TRACING=false` 可以覆盖文件中的启用设置。密钥按 `LANGSMITH_API_KEY` > 文件中 `apiKeyEnv` 指向的变量 > 文件中 `apiKey` 选择。没有任何启用设置时默认关闭追踪。修改环境变量后，已启动的桌面应用需要退出并从配置了环境变量的进程重新启动。DreamEval 的断网容器 worker 不会继承宿主端的 LangSmith 配置，也不能直接上传 Trace。

可选配置包括 `LANGSMITH_ENDPOINT`（实例的 API 地址）、`LANGSMITH_WORKSPACE_ID`（需要指定工作区的密钥）、`LANGSMITH_HIDE_INPUTS=true` 和 `LANGSMITH_HIDE_OUTPUTS=true`。打开追踪会上传对话和工具输入输出；实现会遮蔽常见密钥字段、Bearer 凭证及环境变量中的已知密钥，但不能保证识别任意正文中的秘密。附件仅记录元数据，不上传二进制内容。较大文本和集合会截断；工具的大输出继续使用本地 artifact 引用。

上传使用异步批处理，每轮生成器结束时等待上传，默认最多等待 3 秒。缺少密钥、上传失败或超时会提示警告，任务仍继续执行；程序强制终止可能丢失未上传记录。调用方应消费生成器至结束，或调用 `return()` 关闭它。程序调用可通过 `runTurn({ ..., tracing: { enabled, projectName, client, hideInputs, hideOutputs, flushTimeoutMs } })` 覆盖配置；`enabled: false` 可禁用单次调用。

消息和 token 数据遵循 [LangSmith 自定义 LLM Trace 格式](https://docs.langchain.com/langsmith/log-llm-trace)。费用显示取决于提供方上报的费用或 LangSmith 中配置的模型价格。

## MVP 能力

- CLI 入口: `dreamcode [prompt...] --mode plan|guided|yolo|full --cwd <path>`。
- 无 prompt 时进入交互式 REPL, 支持持续对话和 slash command。
- 流式 CLI 输出: 展示模型文本、工具调用、权限决策、工具状态、文件变更和最终总结。
- 持久配置: `~/.dreamcode/config.json`, 支持 `/llm` 保存 provider/model/API key 配置。
- JSONL 事件日志: `~/.dreamcode/sessions/<session-id>/events.jsonl`。
- Session history / resume:
  - `dreamcode sessions`
  - `dreamcode show <session-id>`
  - `dreamcode resume <session-id> "继续任务"`
  - `dreamcode diff <session-id>`
  - `dreamcode rollback <session-id> --file <path>`
  - `dreamcode index rebuild`
- 派生索引: `~/.dreamcode/index.sqlite.json`, 可从 JSONL sessions 重建；JSONL 仍是事实源。
- Agent 主循环: 支持单条 assistant message 提出多个 ToolCall；只读调用组成有界并发 wave，Shell、写入、后台任务和交互工具作为 exclusive barrier。
- Fake 模型 provider: 用于确定性的集成测试。
- OpenAI-compatible 模型 provider 基础设施:
  - 内置 `openai`、`deepseek`、`qwen`、`kimi`、`zhipu`、`siliconflow`、`minimax` preset。
  - 支持 `openai-compatible` 自定义 provider。
  - CLI 支持 `--provider`、`--model`、`--api-key`、`--api-key-env`、`--base-url`、`--list-providers`。
- Tool Registry: 注册经过 Zod 校验的内置工具:
  - `file.read`, `file.write`, `file.patch`
  - `search.grep`, `search.glob`
  - Windows: `pwsh`; Unix: `bash`
  - `job_output`, `job_list`, `job_kill`
  - `git.status`, `git.diff`
  - `todo.write`, `question.ask`
  - `web.search`, `web.fetch`
  - `skill`
  - 启用的 MCP Server 工具以 `mcp__<server>__<tool>` 注册为原生 Tool；不再向模型暴露 `mcp.list` / `mcp.call`。
  - Core 在每次模型请求开始时读取 Tool Registry 快照；运行中的 MCP 刷新不会改变该次请求的工具视图。
- 命令执行采用平台专属 Shell：Windows 使用 `pwsh`，Unix 使用 `bash`；长任务通过 `run_in_background` 启动，并使用 `job_output`、`job_list`、`job_kill` 管理。
- 长期程序由 session 隔离的 Process Supervisor 管理，日志直接落盘并受容量限制，宿主正常退出或 session 删除时清理活动进程。
- 命令结果提供机器可读的错误分类、execution outcome、4 KiB stdout/stderr 首尾预览和完整 artifact 引用。
- Tool Result Aggregator 保证每个 ToolCall 都有独立结果，同时对一次模型步骤的全部工具结果施加共享字符预算，避免 N 个结果线性放大下一轮上下文。
- `file.read` 返回带真实行号的窗口并支持 `offset` / `limit` 精确续读；文件快照和回滚由 `file.write` / `file.patch` 在写入前保存 snapshot，同时保存 patch artifact。
- Permission Engine: 实现 Safe YOLO v0 规则:
  - 自动允许任意本地路径的普通读取与搜索，以及低风险 workspace 写入、只读 git、常见 test/lint/build 命令。
  - 对敏感文件读取、安装依赖、未知 shell 命令和疑似网络命令进行询问。
  - 拒绝 workspace 外写入、递归危险删除、强推、硬重置等高风险动作。
- Safe YOLO v1 扩展:
  - Web 只读访问在 yolo/full 下允许, guided 下询问, plan 下拒绝。
  - MCP 工具在 guided/yolo 下逐次询问，full 下自动允许，plan 下不暴露。
  - dependency install 标记为 `install_dependency` 风险。
- Context Builder: 加载 `DREAMCODE.md`、包含 todo 状态，并按实际 messages、工具 schema 与 Provider 协议开销估算和压缩上下文。
- Model usage 区分完整输入、缓存命中输入、未缓存输入和输出 Token；缓存输入仍计入上下文容量。
- Eval fixtures: 覆盖失败测试修复、README 更新和安全拦截。

## Eval Web 评测平台

本地评测平台复用 `@dreamcode/evals` 的任务发现、Agent 执行、确定性 Oracle 和 LLM-as-Judge 评分链路，可发起单任务或批量评测，并查看历史结果、分项得分、Assertions、工程指标和完整 Session Log。

```bash
# 开发模式，默认监听 http://127.0.0.1:4178
pnpm eval:web

# 生产构建与启动
pnpm eval:web:build
pnpm --filter @dreamcode/eval-web start
```

平台仅监听本机回环地址。默认入口已接入新版 60 题数据集与独立评分协议；Agent 框架可选择 DreamCode、Claude Code、Pi、DeepSeek Harness、OpenCode，Agent 与 Judge 分别选择已有认证配置的模型。外部框架运行于题目原有容器，复用验收与评分；安装和协议支持范围见[多框架接入](docs/evals/DreamEval-multi-agent-frameworks-implementation-2026-10-10.md)。平台支持单题、批次、重复运行、三类结果汇总、过程复评和批次比较。执行记录包含框架版本、实际文件改动、公开消息和工具证据，未知费用保持为空。平台采用统一 Radix 控件与图标，旧 V2 页面、接口及题库已退出运行路径。

新 case、数据集、执行记录与评分系统的实现依据见 [DreamEval 文档入口](docs/evals/README.md) 和 [当前决策](docs/evals/DreamEval-case-dataset-scoring-decision-2026-10-09.md)。[历史评分与操作资料](docs/evals/archive/README.md) 已归档，不作为新实现依据。

新的 [DreamEval 数据集](evals/dataset/README.md) 为独立六字段协议，包含完整 60 道题。运行 `python evals/dataset/preparation/restore_git_state.py` 恢复合并题环境，执行 `pnpm eval:dataset validate` / `quality` 核验，再使用 `pnpm eval:dataset run CASE-001 mimo-v2.5-pro`。任务验收、过程评价和工程指标分别报告，具体质量与试跑范围见 [实施报告](docs/evals/DreamEval-dataset-60-implementation-report-2026-10-10.md)。

“新建评测”支持选择已保存的评测组或直接从 DataSet 勾选题目；评测组管理从弹窗中的“管理评测组”进入。总览与评测记录实时显示批次及当前题目运行时间，缺失指标显示 `_`。评测记录支持删除已结束的批次或独立执行记录，并清理对应工作区、日志和产物；运行中及排队中的批次不能删除。


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
- runtime 平台事实、结构化 process 执行、Shell 单表达式校验和输出外置。
- 可选工具 schema 分层、回合内紧凑缓存命中和缓存失效。
- Provider 缓存 Token 归一化与包含工具 schema 的请求前估算。
- fake model 端到端修复失败的 JavaScript 测试。
- 敏感文件读取授权和破坏性删除的拒绝逻辑。
- OpenAI-compatible tool schema 顶层 object 兼容性。
- 写入后重复只读检查的停止保护。
- Phase 2 覆盖:
  - session resume 和 JSONL replay。
  - session index rebuild。
  - snapshot rollback。
  - local web fetch artifact。
  - skill 渐进读取。
  - MCP stdio 与 Streamable HTTP server 原生工具注册和调用。

现存真实模型评测报告见 [历史运行报告](docs/evals/archive/README.md#历史运行报告)。Fake model 仅用于确定性运行时回归；历史运行结果不作为新数据集的能力结论。

Phase 2 真实模型验收已使用本地 DeepSeek 配置跑通:

- session: `sess_mrd8o35b_ro5orl8t`
- workspace: 临时 `readme-update` fixture 副本
- initial turn: 读取 `package.json` / `README.md`, 创建 `PHASE2_REAL_MODEL_CHECK.md`
- resume turn: `dreamcode resume sess_mrd8o35b_ro5orl8t ...`, 追加 `Phase 2 resume turn OK`
- `dreamcode show` 显示 2 个 turns, `dreamcode diff` 显示 create + update diff。

## 包结构

DreamEval 使用新版数据集指定的 Linux 容器运行环境。Agent 与工具在断网、只读根目录的容器内执行，模型认证留在宿主端。当前 worker 构建命令为 `pnpm eval:dataset:worker:build`，镜像与工作区由 `evals/dataset/runtime` 中的固定配置指定。执行阶段不会自动下载镜像。

该执行环境解决 DreamEval 在 Windows 上运行 Node 管道工具的阻塞；Windows 原生受限令牌后端仍保留预检，失败时停止模型调用。Pi、Claude Code、OpenCode 等外部 CLI 当前继续使用其原有执行方式。统一活动题库不设留出分区，外部 CLI 的交互澄清支持仍有限制。

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
