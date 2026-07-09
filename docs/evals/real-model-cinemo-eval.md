# Real Model Cinemo Evaluation

日期: 2026-07-09

## 目标

DreamCode 的真实模型评测不再以简单 fixture 任务作为主要验收标准。fake model 仍用于确定性回归, 但真实能力必须用一个真实仓库验证:

> 能够读取 `D:\Files\Github\Cinemo`, 理解项目仓库是干什么的, 能够持续性回答用户的一系列问题, 并能在代码仓库里编写用户指定的文档, 形成闭环。

## fake model 仍然测什么

fake model 有意义, 但它只覆盖运行时基础设施:

- session / turn / event log 能否创建。
- context builder 能否把 workspace 摘要、历史观察和 todo 带进模型输入。
- permission engine 能否允许低风险操作并拒绝高风险操作。
- tool registry 能否执行 file read/write/patch、shell、git、todo 等工具。
- core loop 能否处理 `model -> tool calls -> tool results -> continue -> final summary`。
- 测试可重复、离线、低成本, 适合作为 CI 回归。

fake model 不覆盖:

- 真实 provider API 鉴权、base URL、模型名、流式输出兼容性。
- OpenAI-compatible function calling 的 JSON schema 兼容性。
- 真实模型是否会合理选择工具、停止工具循环、理解复杂仓库。
- 长上下文、连续对话和真实文档写入质量。

## 真实评测环境

- 模型配置: `~/.dreamcode/config.json` 中的 `deepseek` profile。
- 目标仓库: `D:\Files\Github\Cinemo`。
- 推荐模式: `yolo`。
- 工具调用上限: `60`。

运行前确认:

```powershell
git -C D:\Files\Github\Cinemo status --short
pnpm dreamcode --provider deepseek --cwd D:\Files\Github\Cinemo --max-tool-calls 60
```

## 交互式评测脚本

在同一个 DreamCode REPL 中连续输入以下三轮:

```text
请先只阅读仓库，回答 Cinemo 是什么项目、你会优先看哪些文件。不要修改文件。
```

```text
继续基于刚才的上下文，回答：前端、后端、推荐系统分别在哪里，核心数据流是什么。不要修改文件。
```

```text
请在仓库根目录创建 DREAMCODE_CINEMO_REPO_NOTES.md，写一份面向新贡献者的中文项目理解文档，包含项目定位、技术栈、关键目录、启动方式、推荐系统数据流、后续问题清单。写完后总结你写了什么。
```

## 通过标准

一次真实评测通过需要同时满足:

- CLI 显示 `模型: deepseek / deepseek-v4-pro`。
- 第一轮只读任务成功读取 Cinemo 的关键文件, 至少包括 `README.md`、`backend/app.py`、`backend/models.py`、推荐路由或 Spark 任务、前端 API/router/view 之一。
- 第一轮能正确说明 Cinemo 是 Vue + Flask + PySpark ALS + PostgreSQL/openGauss 的电影推荐系统。
- 第二轮在同一个 REPL 中延续上下文, 能说明前端、后端、推荐系统位置和核心数据流。
- 第三轮能创建或更新 `DREAMCODE_CINEMO_REPO_NOTES.md`。
- `turn.completed` 状态为 `completed`, summary 中包含 changed file。
- `git -C D:\Files\Github\Cinemo status --short` 能看到预期文档变更。

## 2026-07-09 实测记录

本轮真实 DeepSeek 评测暴露并修复了三个 fake model 无法发现的问题:

- 工具 schema 顶层是 `$ref`, DeepSeek 拒绝 function parameters。已改为 inline object schema。
- `--provider deepseek` 过去只读取 active profile, 不会回退到 `config.json` 中同名 profile。已修复。
- 模型写完文档后重复读取同一文件, 最终触达 max tool calls。已增加 post-change inspection loop guard, 写入后重复只读检查会收束为 completed summary。

实测结果:

- 真实模型成功读取 Cinemo 多个前后端和推荐系统文件。
- 真实模型在同一个 REPL 中完成连续两轮项目理解问答。
- 真实模型成功创建并更新 `DREAMCODE_CINEMO_REPO_NOTES.md`。
- 修复 guard 后, 文档更新任务以 `turn.completed` / `completed` 收尾。

## 后续评测增强

- 为真实 provider 增加可选的人工/脚本化评测 runner, 自动记录 event log 和通过标准。
- 将重复工具调用、写后停止、连续对话保持作为明确质量指标。
- 增加对大型仓库的上下文预算评估, 避免重复读取同一文件。
- 增加真实模型输出质量 rubric, 检查是否引用真实文件、是否产生幻觉、是否给出可操作文档。
