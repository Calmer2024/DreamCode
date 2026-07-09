# DreamCode 架构决策记录 ADR

关联文档: [DreamCode 架构设计文档](../architecture/dreamcode-architecture.md)

## ADR-001: TypeScript 优先

结论: 第一阶段使用 TypeScript + Node.js 22。

原因:

- 贴近 Claude Code/OpenCode 学习路径。
- CLI/TUI/model SDK/MCP 生态成熟。
- 迭代速度快。
- Windows 兼容优先。

## ADR-002: 自研 Agent 运行时

结论: 不用 LangChain/LangGraph 作为核心。

原因:

- DreamCode 的学习目标就是 runtime 本身。
- 需要完全掌控 agent loop、tool execution、permission、compression。

## ADR-003: JSONL 事件日志作为事实源

结论: 所有 session 事件追加写 JSONL, SQLite 只做索引。

原因:

- 易恢复。
- 易回放。
- 易人工检查。
- 实现简单可靠。

## ADR-004: Safe YOLO 默认模式

结论: 产品默认优化 Safe YOLO, 但所有工具调用必须过 permission engine。

原因:

- 用户目标是高自动化。
- 安全兜底是用户敢用自动化的前提。

## ADR-005: 工作区是本地目录

结论: 第一阶段 workspace 不泛化。

原因:

- 与 Codex/Claude Code/OpenCode 初期核心场景对齐。
- 减少权限和数据模型复杂度。
