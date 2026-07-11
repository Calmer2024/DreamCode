# DreamCode 第二阶段 MVP 文档

版本: v0.1
日期: 2026-07-09
阶段名称: 第二阶段 - 可恢复任务控制台 MVP
关联文档: [PRD](../prd/dreamcode-prd.md), [架构设计](../architecture/dreamcode-architecture.md), [ADR](../adr/dreamcode-architecture-adr.md), [第一阶段 MVP](./dreamcode-mvp-phase-1.md)

## 1. MVP 定位

第一阶段已经跑通了一个最小但真实的本地 Agent 运行时闭环: CLI 启动、上下文构建、模型 provider、工具调用、权限判定、JSONL 事件日志、安全兜底和最终总结。

第二阶段的目标是把第一阶段的运行时闭环产品化成一个可以长期使用、可以中断恢复、可以观察审计、可以扩展工具边界的本地任务控制台:

> 用户可以在本地项目中启动 DreamCode, 让它持续完成编码、调研和文档任务; 当任务中断、失败或跨天继续时, DreamCode 能从事件日志恢复上下文, 展示历史、diff、验证结果和风险, 并通过 Web、Skills、MCP 等受控扩展能力完成更真实的任务。

第二阶段的产品关键词:

- 可恢复。
- 可观察。
- 可审计。
- 可回滚。
- 可扩展。
- 可验证。

## 2. 第二阶段成功标准

第二阶段 MVP 完成时, DreamCode 必须能端到端完成以下任务:

1. 用户运行一次编码任务后退出进程, 再通过 `dreamcode sessions` 找到历史任务, 通过 `dreamcode resume <session>` 恢复任务上下文并继续执行。
2. DreamCode 能从 `events.jsonl` 重建 session 状态, 包括用户输入、todo、工具观察、文件变更、命令结果、最终总结和最近上下文摘要。
3. DreamCode 能维护 SQLite 派生索引, 用于快速列出、搜索和筛选历史 session; JSONL 仍然是事实源。
4. 用户能在 TUI 中看到当前目标、todo、工具事件、权限审批、命令结果、文件 diff、成本摘要和最终结果。
5. 用户能查看某个 session 的文件变更, 并将本 session 修改过的文件回滚到写入前快照。
6. DreamCode 能完成一个带来源引用的调研 / 文档任务: 搜索网页、抓取页面、提取正文、保存来源引用, 最终生成 Markdown 报告。
7. DreamCode 能加载一个本地 Skill, 只在需要时读取完整 `SKILL.md` 和相关资源, 并把 Skill 指令纳入上下文。
8. DreamCode 能连接一个最小 MCP stdio server, 把 MCP tool 转成 DreamCode Tool, 并经过 permission engine 执行。
9. Safe YOLO v1 能覆盖网络访问、MCP 工具、回滚、安装依赖、危险命令、secret 和 workspace boundary。
10. 新增功能有确定性测试和 eval fixture, `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。

## 3. 用户故事

### 3.1 恢复历史任务

作为个人开发者, 我希望 DreamCode 能继续上一次没有完成的任务。

示例:

```bash
dreamcode sessions
dreamcode resume sess_abc123
```

验收标准:

- `dreamcode sessions` 展示最近 session 的时间、workspace、状态、首轮 prompt、修改文件数量和验证结果。
- `dreamcode resume <session>` 能读取历史事件并构建恢复上下文。
- 恢复后新用户输入会追加为新的 turn, 不覆盖旧事件。
- 最终总结能区分“历史已完成内容”和“本次恢复后完成内容”。

### 3.2 在 TUI 中观察和介入

作为高自动化倾向用户, 我希望 DreamCode 自动执行低风险操作, 但我能随时看懂它正在做什么。

验收标准:

- TUI 顶部显示 session、mode、model、workspace、当前状态。
- 主区域显示模型输出和用户输入。
- 侧边栏显示 todo 和当前执行步骤。
- 工具区域显示工具名称、状态、耗时、摘要和错误。
- 文件区域显示 changed files 和 diff。
- 审批区域能处理 ask 类权限请求。
- 支持中断当前 turn, 并能从中断状态恢复。

### 3.3 回滚不满意的文件修改

作为用户, 我希望 DreamCode 修改文件前自动保留快照, 当结果不满意时可以回滚。

验收标准:

- `file.write` 和 `file.patch` 在写入前保存快照。
- 每个 changed file 有 before hash、after hash 和 diff。
- 用户可以通过 TUI 或 CLI 查看本 session diff。
- 用户可以回滚单个文件或本 session 的全部文件变更。
- 回滚动作本身也写入 event log。

### 3.4 完成带来源的调研任务

作为技术型写作者或研究者, 我希望 DreamCode 能查阅公开网页并生成有来源的 Markdown 报告。

示例:

```bash
dreamcode "调研 Vitest workspace 配置方式, 写入 docs/research/vitest-workspace.md, 需要来源链接。"
```

验收标准:

- Agent 能调用 `web.search` 获取候选来源。
- Agent 能调用 `web.fetch` 抓取网页并提取正文摘要。
- Web 原始内容或摘要保存到 session artifact 中。
- 最终报告包含来源链接。
- 对发布时间、版本、事实和推断做清晰区分。

### 3.5 使用本地 Skill

作为用户, 我希望把常用工作流封装成 Skill, 让 DreamCode 在合适任务中自动使用。

示例目录:

```text
~/.dreamcode/skills/
  diagnose/
    SKILL.md
    references/
    scripts/
```

验收标准:

- DreamCode 启动时只加载 Skill 名称、描述和触发条件摘要。
- 当用户显式指定 Skill 或模型判断需要 Skill 时, 才读取完整 `SKILL.md`。
- Skill references 按需读取, 不一次性塞入上下文。
- Skill scripts 不绕过权限系统, 执行时仍走 `shell.run`。

### 3.6 使用 MCP 工具

作为进阶用户, 我希望 DreamCode 能接入本地 MCP server, 复用外部工具生态。

验收标准:

- 配置文件可以声明 MCP stdio server。
- `dreamcode mcp list` 能显示已配置 server 和 tools。
- MCP tool 在模型侧呈现为 `mcp.<server>.<tool>`。
- MCP tool metadata 会进入 permission engine。
- 默认不自动执行有外部副作用或网络风险的 MCP tool。

## 4. MVP 范围

### 4.1 必做功能

第二阶段必须完成:

- Session history:
  - `dreamcode sessions`
  - `dreamcode show <session>`
  - `dreamcode resume <session>`
  - session 状态重建
  - 多 turn 追加
- SQLite derived index:
  - session 列表索引
  - turn 索引
  - changed files 索引
  - tool call 摘要索引
  - rebuild index 命令
- TUI v1:
  - Ink 主界面
  - 流式输出
  - todo 面板
  - tool event 面板
  - permission approval 面板
  - changed files / diff 面板
  - interrupt / resume 基础交互
- 文件快照和回滚:
  - 写入前快照
  - session patch / snapshot 目录规范
  - diff 查看
  - 单文件回滚
  - session 级回滚
- Web 工具:
  - `web.search`
  - `web.fetch`
  - 来源 artifact 保存
  - 调研报告引用规则
- Skills v0:
  - Skill discovery
  - Skill metadata
  - 按需读取 `SKILL.md`
  - references 按需读取
  - 上下文注入策略
- MCP client v0:
  - stdio server 配置
  - tool discovery
  - MCP tool 到 DreamCode Tool 的适配
  - MCP permission metadata
- Context / cost:
  - session summary 保存
  - resume context builder
  - tool result reference 化
  - token / cost event 记录
- Safety v1:
  - 网络访问风险
  - MCP 工具风险
  - rollback 权限
  - remembered approval 最小设计
  - command classifier 增强
- 测试和 eval:
  - session resume fixture
  - rollback fixture
  - web mock fixture
  - skill fixture
  - MCP fake server fixture
  - SQLite rebuild 测试

### 4.2 可以延后但要预留接口

第二阶段不一定完成, 但架构中要留口:

- LSP diagnostics。
- LSP references / definition / symbols。
- Hooks。
- Subagents。
- 多模型 router。
- Basic desktop app。
- Browser automation。
- 复杂 trace viewer。
- 长期记忆。
- 向量数据库。
- Plugin packaging。

### 4.3 明确不做

第二阶段不做:

- 云端任务。
- 多人协作。
- 企业权限和审计后台。
- 插件市场。
- 自动 git commit / push / PR。
- 自动部署。
- 邮件 / 日历 / Jira / GitHub connector。
- 浏览器自动化。
- 完整 IDE 插件。
- 完整 LSP 语义索引。
- 复杂 subagent 编排。
- 复杂 workflow engine。

## 5. 功能模块设计

### 5.1 Session History 和 Resume

目标:

- 让 DreamCode 的任务历史成为可恢复、可搜索、可复盘的产品资产。

新增 CLI:

```bash
dreamcode sessions
dreamcode sessions --cwd .
dreamcode sessions --status running
dreamcode show <session-id>
dreamcode resume <session-id>
dreamcode resume --last
```

Session 状态:

- `running`: 正在执行。
- `interrupted`: 用户中断或进程退出后可恢复。
- `completed`: 正常完成。
- `failed`: 异常失败。
- `rolled_back`: 已执行 session 级回滚。

恢复原则:

- resume 不是恢复旧进程或旧 shell。
- resume 是从 JSONL 事件重建状态, 创建新 turn, 并把历史摘要、todo、变更、命令结果和风险作为上下文给模型。
- 旧事件不可修改; 新 turn 继续追加事件。
- 如果历史 event log 损坏, DreamCode 应尽量读取可解析部分, 并明确提示恢复风险。

需要实现的 store API:

```ts
listSessions(filter): Promise<SessionListItem[]>
readSession(sessionId): Promise<Session>
readSessionEvents(sessionId): Promise<AgentEvent[]>
replaySession(events): ReplayedSessionState
appendTurn(sessionId, input): Promise<Turn>
updateSessionSummary(sessionId, summary): Promise<void>
```

`ReplayedSessionState` 至少包含:

- session metadata。
- turns。
- latest status。
- user prompts。
- assistant summaries。
- todo items。
- tool observations summary。
- changed files。
- commands。
- approval decisions。
- artifacts。
- cost usage。
- latest context summary。

### 5.2 SQLite Derived Index

目标:

- 保持 JSONL 作为事实源。
- 用 SQLite 提供快速 session 列表、搜索、筛选和统计。

建议路径:

```text
~/.dreamcode/
  index.sqlite
  sessions/
    <session-id>/
      session.json
      events.jsonl
      outputs/
      patches/
      snapshots/
      artifacts/
```

最小表:

```text
sessions(
  id,
  workspace_root,
  status,
  title,
  first_prompt,
  created_at,
  updated_at,
  completed_at,
  changed_file_count,
  command_count,
  total_cost_usd
)

turns(
  id,
  session_id,
  prompt,
  mode,
  status,
  started_at,
  completed_at
)

changed_files(
  id,
  session_id,
  turn_id,
  path,
  operation,
  before_hash,
  after_hash
)

tool_calls(
  id,
  session_id,
  turn_id,
  tool,
  status,
  summary,
  started_at,
  completed_at
)

artifacts(
  id,
  session_id,
  turn_id,
  kind,
  path,
  title,
  url,
  created_at
)
```

索引规则:

- 所有索引都可以从 JSONL 重新构建。
- 写 event 成功后再 best-effort 更新 SQLite。
- SQLite 写失败不能让 agent 任务失败, 但要在日志中提示。
- 提供 `dreamcode index rebuild` 从 sessions 目录重建索引。

### 5.3 Ink TUI v1

目标:

- 让用户不只看到流式日志, 而是能掌控任务状态。

TUI 必备能力:

- 显示当前任务目标。
- 显示 stream text。
- 显示 tool started / completed。
- 显示 permission ask / allow / deny。
- 显示 todo 状态。
- 显示 changed files。
- 显示 command exit code。
- 显示 final summary。
- 用户可以输入新消息。
- 用户可以批准或拒绝 ask。
- 用户可以中断当前 turn。
- 用户可以查看 diff。

优先实现方式:

- 先做稳定的单进程 Ink TUI。
- 保留现有流式 CLI 作为 fallback。
- TUI 从 `AgentEvent` 驱动 UI, 不直接依赖 core 内部状态。
- Event renderer 和 TUI state reducer 共享事件解释逻辑。

### 5.4 文件快照、Diff 和回滚

目标:

- 让 Safe YOLO 下的自动写文件更可信。

写入前流程:

1. `file.write` / `file.patch` 解析目标路径。
2. permission engine 确认可写。
3. 读取 before 内容。
4. 计算 before hash。
5. 保存 snapshot 到 session `snapshots/`。
6. 执行写入。
7. 计算 after hash。
8. 保存 patch 到 session `patches/`。
9. 追加 `file.changed` event。

回滚流程:

1. 用户选择 session 或文件。
2. DreamCode 检查当前文件 after hash 是否仍与记录一致。
3. 如果一致, 用 snapshot 恢复。
4. 如果不一致, 要求用户确认, 因为文件可能被用户或其他进程改过。
5. 回滚完成后追加 `file.rolled_back` event。

新增 CLI:

```bash
dreamcode diff <session-id>
dreamcode diff <session-id> --file packages/core/src/index.ts
dreamcode rollback <session-id> --file packages/core/src/index.ts
dreamcode rollback <session-id> --all
```

验收重点:

- 不允许回滚 workspace 外路径。
- 不允许回滚 secret 文件内容到输出日志。
- 回滚失败必须保留当前文件, 不做半截写入。
- 回滚动作本身需要进入最终总结和事件日志。

### 5.5 Web Search / Web Fetch

目标:

- 支持 PRD 中的调研、方案对比、文档撰写场景。

工具:

```text
web.search
web.fetch
```

`web.search` 输入:

- query。
- maxResults。
- recency 可选。
- domains 可选。

`web.search` 输出:

- title。
- url。
- snippet。
- publishedAt 可选。
- source provider。

`web.fetch` 输入:

- url。
- maxBytes。
- extractMode: `readability | text | raw`。

`web.fetch` 输出:

- title。
- url。
- fetchedAt。
- content summary。
- quoted snippets。
- artifactRef。

权限策略:

- `plan` mode 默认不访问网络。
- `guided` mode 网络访问默认 ask。
- `yolo` mode 首次访问某 domain 默认 ask, 用户可记住本 session 允许。
- `full` mode 允许非 hard-deny 网络访问, 但仍记录风险。
- POST、登录态、cookie、表单提交等外部副作用不进入第二阶段。

引用规则:

- 调研报告必须包含来源链接。
- 对最新信息必须标注 fetched date。
- 不把网页长正文直接塞入最终文档。
- 大网页内容保存为 artifact, 上下文只放摘要和必要片段。

### 5.6 Skills v0

目标:

- 让 DreamCode 学习 Codex / Claude Code 风格的可复用工作流, 但不在第二阶段引入完整插件系统。

Skill 目录:

```text
~/.dreamcode/skills/
  diagnose/
    SKILL.md
    references/
    scripts/

<workspace>/.dreamcode/skills/
  project-review/
    SKILL.md
```

Skill metadata:

- name。
- description。
- trigger。
- source path。
- trust level。

加载策略:

1. 启动时扫描 skill 目录。
2. 只读取 `SKILL.md` 的 frontmatter 或首段摘要。
3. Context Builder 把可用 skill 列表放入上下文。
4. 用户显式指定或模型选择时, 再读取完整 `SKILL.md`。
5. references 和 scripts 按需读取。

建议工具:

```text
skill.list
skill.read
skill.read_resource
```

安全规则:

- Skill 是指令和资源, 不是免审批插件。
- Skill scripts 只能通过 `shell.run` 执行。
- workspace skill 优先级高于 global skill, 但要在 UI 中标明来源。
- Skill 不能覆盖 permission engine 的 hard deny。

### 5.7 MCP Client v0

目标:

- 让 DreamCode 具备连接外部工具生态的最小能力。

第二阶段只支持:

- stdio MCP server。
- tools/list。
- tools/call。
- 文本型 tool result。
- 基础超时。
- server 启停。

暂不支持:

- remote MCP。
- OAuth。
- resources。
- prompts。
- sampling。
- long-running streaming tool。

配置示例:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["./scripts/example-mcp-server.js"],
      "env": {}
    }
  }
}
```

工具命名:

```text
mcp.<serverName>.<toolName>
```

Permission metadata:

- MCP server 名称。
- tool 名称。
- tool description。
- input schema。
- risk tags。
- network / filesystem / external side effect 标记。

默认策略:

- 未配置的 MCP server 不可启动。
- MCP tool 默认 ask, 除非 metadata 和用户规则明确 allow。
- 有 external side effect 风险的 MCP tool 在 Safe YOLO 下 ask。
- MCP server stderr 和异常写入 event log 摘要。

### 5.8 Context、Summary 和 Cost

目标:

- 让长任务可恢复, 同时控制 token 和成本。

新增能力:

- 每个 turn 完成后生成 session summary。
- 关键 tool observation 结构化保存。
- 大 stdout / stderr / web content 保存为 artifactRef。
- Context Builder 支持 resume 输入。
- Context Builder 支持历史摘要、最近事件、当前 todo、changed files、验证结果分层注入。
- 模型 usage event 记录 inputTokens、outputTokens、totalTokens、costUsd。
- TUI 和最终总结显示本次任务成本估算。

上下文优先级:

1. 当前用户目标。
2. 最新用户反馈。
3. 项目规则 `DREAMCODE.md`。
4. 当前 todo。
5. 已修改文件和验证结果。
6. 最近失败错误。
7. 相关文件片段。
8. 历史 session summary。
9. 低价值长输出摘要。

### 5.9 Safe YOLO v1

目标:

- 在工具面变大后继续保持“高自动化但有底线”。

新增风险标签:

```ts
type RiskTag =
  | "network_access"
  | "web_fetch"
  | "mcp_tool"
  | "rollback"
  | "install_dependency"
  | "writes_config"
  | "external_side_effect"
```

策略升级:

- 网络访问按 domain 控制。
- MCP tool 按 server + tool 控制。
- dependency install 默认 ask。
- git commit / push 默认 ask。
- destructive command 继续 hard deny。
- secret read 继续 hard deny。
- workspace 外写继续 hard deny。
- workspace 外读默认 ask, full mode 可 allow。
- remembered approval 只在当前 session 生效, 第二阶段不做全局永久记忆。

审批记录:

- 记录用户批准 / 拒绝。
- 记录 approval scope。
- 记录 reason。
- 记录是否 remembered。

## 6. 事件设计

第一阶段已有事件:

- `session.created`
- `turn.started`
- `user.message`
- `context.built`
- `context.compressed`
- `model.started`
- `model.delta`
- `model.tool_call`
- `permission.decided`
- `tool.started`
- `tool.completed`
- `file.changed`
- `todo.updated`
- `turn.completed`
- `turn.failed`

第二阶段建议新增:

- `session.resumed`
- `session.summarized`
- `session.indexed`
- `turn.interrupted`
- `model.usage`
- `artifact.created`
- `web.source.saved`
- `skill.loaded`
- `skill.resource.loaded`
- `mcp.server.started`
- `mcp.server.stopped`
- `mcp.tool.discovered`
- `file.snapshot.created`
- `file.rollback.started`
- `file.rollback.completed`
- `file.rollback.failed`
- `approval.remembered`

事件原则:

- Event payload 必须结构化。
- 大内容必须落 artifact, event 只保存引用。
- Event 类型新增要兼容旧 session。
- Replay 遇到未知事件要跳过并保留 warning。
- Event log 不保存 secret 明文。

## 7. CLI 和 Slash Command 设计

新增 CLI:

```bash
dreamcode sessions
dreamcode show <session-id>
dreamcode resume <session-id>
dreamcode resume --last
dreamcode diff <session-id>
dreamcode rollback <session-id> --file <path>
dreamcode rollback <session-id> --all
dreamcode index rebuild
dreamcode skills list
dreamcode skills show <skill-name>
dreamcode mcp list
dreamcode mcp tools <server-name>
```

新增 REPL / TUI slash command:

```text
/sessions
/resume <session-id>
/interrupt
/diff
/rollback
/cost
/compact
/skills
/skill <name>
/mcp
/sources
/help
```

兼容要求:

- 现有 `pnpm dreamcode "prompt"` 继续可用。
- 无 prompt 时默认进入 TUI; 如果终端不支持 TUI, fallback 到现有 REPL。
- CI / 测试环境可通过 flag 禁用 TUI。

## 8. Eval 和测试策略

### 8.1 单元测试

必须新增:

- event replay 状态重建。
- session list filter。
- SQLite index rebuild。
- snapshot 保存。
- rollback hash mismatch。
- web search provider mock。
- web fetch extractor。
- skill discovery。
- skill read progressive disclosure。
- MCP fake server tool discovery。
- MCP tool permission。
- Safe YOLO v1 allow / ask / deny。

### 8.2 集成测试

必须新增 fixture:

```text
evals/fixtures/session-resume/
evals/fixtures/rollback/
evals/fixtures/web-research/
evals/fixtures/skills/
evals/fixtures/mcp-server/
```

建议场景:

1. Session resume:
   - fake model 第一次修改文件后中断。
   - resume 后读取历史状态。
   - fake model 继续运行测试并完成。
2. Rollback:
   - fake model 修改两个文件。
   - 执行 session rollback。
   - 验证文件恢复。
3. Web research:
   - 本地 mock HTTP server 提供网页。
   - `web.search` 返回 mock results。
   - agent 生成带来源 Markdown。
4. Skill:
   - skill 只在被选择后读取完整内容。
   - references 按需读取。
5. MCP:
   - fake MCP server 暴露一个只读 tool。
   - DreamCode 发现并执行 tool。

### 8.3 真实模型验收

至少完成:

1. 在 Cinemo（D:\Files\Github\Cinemo） 仓库中运行一个真实编码任务, 中断后 resume 并完成。
2. 让真实模型生成一份带来源链接的技术调研 Markdown。
3. 让真实模型使用一个本地 Skill 完成诊断或文档任务。
4. 让真实模型调用一个 fake MCP server 的只读工具。

验收输出:

- session id。
- event log path。
- changed files。
- command results。
- sources。
- cost summary。
- residual risks。

## 9. 分阶段交付计划

### 9.1 Phase 2.1: Session 和索引

目标:

- 先解决任务历史可恢复。

交付:

- session list / show / resume。
- event replay reducer。
- SQLite index。
- index rebuild。
- resume context builder。
- 相关测试和 fixture。

验收:

- 可以从历史 session 创建新 turn。
- SQLite 删除后能从 JSONL 重建。
- 旧 Phase 1 session 不崩溃。

### 9.2 Phase 2.2: 快照、Diff 和回滚

目标:

- 让自动写入有可逆保障。

交付:

- 写入前 snapshot。
- patch 保存。
- diff CLI。
- rollback CLI。
- TUI changed files 数据源。
- rollback 测试。

验收:

- 能回滚单文件和整 session。
- hash mismatch 时不会静默覆盖用户改动。

### 9.3 Phase 2.3: Ink TUI v1

目标:

- 把流式 CLI 升级成任务控制台。

交付:

- TUI layout。
- event reducer。
- approval UI。
- interrupt。
- diff panel。
- cost panel。
- fallback REPL。

验收:

- 同一个 agent event stream 能驱动 CLI renderer 和 TUI。
- TUI 能处理 ask 权限。

### 9.4 Phase 2.4: Web 调研能力

目标:

- 支持调研和文档任务。

交付:

- `web.search`。
- `web.fetch`。
- source artifact。
- web permission。
- mock web eval。
- 调研报告写作规则。

验收:

- 能生成带来源链接的 Markdown。
- 网络访问可审批和记录。

### 9.5 Phase 2.5: Skills 和 MCP

目标:

- 建立可扩展能力基线。

交付:

- Skill discovery / read。
- Skill 上下文注入。
- MCP stdio client。
- MCP tool adapter。
- MCP permission metadata。
- fake MCP eval。

验收:

- Skill 不会一次性污染上下文。
- MCP tool 不绕过 permission engine。

### 9.6 Phase 2.6: Safety、真实验收和文档收尾

目标:

- 把第二阶段能力打磨到可日常使用。

交付:

- Safe YOLO v1。
- remembered approval session scope。
- cost summary。
- README 更新。
- guide 更新。
- real model eval。

验收:

- 所有自动化检查通过。
- 至少一条真实模型 resume 任务成功。
- 至少一条真实模型 web research 任务成功。

## 10. 完成定义

第二阶段 MVP 完成需要满足:

- 所有必做模块有实现。
- 所有新增 CLI 命令有基础测试或集成测试覆盖。
- 所有新增工具都经过 Zod schema 校验。
- 所有新增工具都进入 permission engine。
- JSONL 仍是事实源, SQLite 可删除重建。
- resume 能恢复 Phase 2 产生的 session。
- TUI 能完成真实任务的观察、审批和最终总结展示。
- rollback 能恢复本 session 写入前文件状态。
- web research eval 能生成带来源链接的 Markdown。
- skill eval 能验证渐进式加载。
- MCP eval 能验证 tool discovery 和 tool call。
- `pnpm lint` 通过。
- `pnpm typecheck` 通过。
- `pnpm test` 通过。
- `pnpm build` 通过。
- 文档更新:
  - README。
  - MVP Phase 2 文档。
  - 架构文档如有事件、store、工具边界变更则同步更新。
  - model provider / web / MCP / skills guide 如有配置项则补齐。

## 11. 风险和缓解

### 11.1 范围过大

风险:

- Session、TUI、Web、Skills、MCP 都做, 容易把第二阶段拖成平台化大工程。

缓解:

- 先交付 Phase 2.1 和 2.2。
- TUI 只做 event-driven v1。
- Skills 只做指令加载, 不做插件运行时。
- MCP 只做 stdio tools/list 和 tools/call。
- LSP、Hooks、Subagents 全部延后。

### 11.2 Resume 语义不清

风险:

- 用户以为 resume 能恢复旧进程中的 shell 状态或未完成命令。

缓解:

- 明确 resume 是从事件恢复上下文并开启新 turn。
- interrupted 状态显示未完成工具调用。
- 最终总结标明恢复点和未恢复内容。

### 11.3 SQLite 和 JSONL 不一致

风险:

- 派生索引与事实源不一致导致历史展示错误。

缓解:

- JSONL 永远是事实源。
- SQLite 可重建。
- 每个 session show 可选择直接从 JSONL 读取。
- index rebuild 做成常规维护命令。

### 11.4 Web 内容质量和版权

风险:

- 网页来源过时、不可靠或内容过长。

缓解:

- 保存 fetchedAt。
- 最终报告包含来源 URL。
- 区分事实、推断、建议。
- 不长篇复制网页正文。
- 大内容 artifact 化。

### 11.5 MCP 安全边界扩大

风险:

- MCP tool 可能有文件、网络或外部副作用。

缓解:

- MCP 默认关闭, 只加载用户配置 server。
- MCP tool 默认 ask。
- Permission engine 不信任 server 自述。
- hard deny 规则仍生效。

### 11.6 TUI 稳定性

风险:

- Ink 交互、流式输出和审批 UI 复杂, 影响核心任务。

缓解:

- 保留流式 CLI fallback。
- TUI 只消费 AgentEvent。
- 先覆盖最小布局, 不追求复杂多面板交互。

## 12. 第二阶段后的下一步

第二阶段完成后再进入 Phase 3, 重点候选:

- LSP diagnostics / references / symbols。
- Hooks。
- Subagents。
- 多模型 router。
- Trace viewer。
- Basic desktop app。
- Browser automation。
- Artifact preview。
- Workflow templates。
- Plugin packaging。
- SDK / Server API。

## 13. 当前实现状态

截至 2026-07-09, 本仓库已经实现第二阶段 MVP 的本地闭环版本:

- 已实现 session history / replay / resume:
  - `dreamcode sessions`
  - `dreamcode show <session-id>`
  - `dreamcode resume <session-id>`
  - 多 turn 追加到同一个 `events.jsonl`
- 已实现可重建派生索引:
  - 路径: `~/.dreamcode/index.sqlite.json`
  - 命令: `dreamcode index rebuild`
  - JSONL 仍是事实源。
- 已实现文件快照、patch artifact 和 rollback:
  - `dreamcode diff <session-id>`
  - `dreamcode rollback <session-id> --file <path>`
  - hash mismatch 时默认拒绝静默覆盖。
- 已实现 Phase 2 工具:
  - `web.search`
  - `web.fetch`
  - `skill.list`
  - `skill.read`
  - `skill.read_resource`
  - `mcp.list`
  - `mcp.call`
- 已实现 Safe YOLO v1 增量规则:
  - Web 只读访问在 yolo/full 下允许。
  - MCP tool 默认 ask, full mode 允许配置内 MCP tool。
  - dependency install 标记为 `install_dependency` 风险。
- 已实现 CLI / REPL 增量入口:
  - `/sessions`
  - `/diff <session-id>`
  - `/skills`
  - `/mcp`
- 已实现 Ink TUI v1:
  - 无 prompt 且交互式终端下默认进入 TUI。
  - 顶部状态栏展示 session、mode、model、workspace 和当前目标。
  - 主区域展示模型流式输出和事件 timeline。
  - 宽屏侧栏展示 todo、tool events、changed files / diff 和 cost。
  - 支持 slash command: `/sessions`、`/resume`、`/diff`、`/rollback`、`/skills`、`/mcp`、`/cost`、`/interrupt`、`/clear`、`/help`。
  - 支持 ask 权限审批、question 输入、Ctrl+C / `/interrupt` 中断当前 turn。
  - `--no-tui` 保留旧版 REPL fallback。
- 已实现测试覆盖:
  - session resume。
  - JSONL replay。
  - rollback。
  - web fetch artifact。
  - skill 渐进读取。
  - fake MCP stdio server tool call。

已验证命令:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

真实模型验收:

- Provider: `deepseek`
- Model: `deepseek-v4-pro`
- Session: `sess_mrd8o35b_ro5orl8t`
- Initial turn: 在临时 `readme-update` fixture 副本中读取 `package.json` / `README.md`, 创建 `PHASE2_REAL_MODEL_CHECK.md`。
- Resume turn: 通过 `dreamcode resume sess_mrd8o35b_ro5orl8t ...` 恢复同一 session, 追加 `Phase 2 resume turn OK`。
- 验收结果:
  - `PHASE2_REAL_MODEL_CHECK.md` 同时包含 initial 和 resume 标记。
  - `dreamcode show sess_mrd8o35b_ro5orl8t` 显示 2 个 turns。
  - `dreamcode diff sess_mrd8o35b_ro5orl8t --file PHASE2_REAL_MODEL_CHECK.md` 显示 create + update diff。

仍然预留到后续阶段的内容:

- LSP diagnostics / references / symbols。
- Hooks。
- Subagents。
- 多模型 router。
- Browser automation。
- Basic desktop app。
