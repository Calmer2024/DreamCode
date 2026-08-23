# DreamCode 自动化评测器使用说明

评测器代码位于 `packages/evals`，任务数据位于根目录 `evals/`。当前包含 52 个覆盖理解、调试、功能开发、重构、测试、文档、Git、安全、研究、可观测性、运行时选择和 Token 成本效率的任务。

## Fake 回归

```powershell
pnpm --filter @dreamcode/evals eval --task B01 --provider fake
pnpm --filter @dreamcode/evals eval --task F01 --provider fake
pnpm --filter @dreamcode/evals eval --task K01 --provider fake
# 运行当前全部 52 个 Fake 任务
pnpm --filter @dreamcode/evals eval --provider fake
```

不指定 `--task` 时运行所有已发现任务。每次运行会创建新的临时 workspace 和 DreamCode home，并把报告保存到 `evals/runs/`；该目录默认被 gitignore。

## Mimo 评测

Agent 和 Judge 使用独立凭证：

```powershell
$env:DREAMCODE_MIMO_API_KEY = "..."
$env:DREAMCODE_JUDGE_MIMO_API_KEY = "..."
pnpm --filter @dreamcode/evals eval --task B01 --provider mimo --model mimo-v2.5 --judge --repeat 3
# 当前 52 任务各执行一次真实 Mimo + Judge
pnpm --filter @dreamcode/evals eval --provider mimo --model mimo-v2.5-pro --judge --concurrency 1
```

Judge 默认使用 `mimo-v2.5-pro`，结果写入 `judge.json`，不改变确定性主评分。

如果没有设置环境变量，Runner 会读取 `%USERPROFILE%/.dreamcode/config.json` 中已保存的 Mimo profile。环境变量始终优先于存储配置。Judge 可以使用独立的 `DREAMCODE_JUDGE_MIMO_API_KEY`；未设置时，在用户明确授权真实评测的情况下复用已保存的 Mimo profile。

## 产物

每次运行保存：

- `events.jsonl`：完整 Agent 事件；
- `snapshot-before.json` / `snapshot-after.json`：workspace 文件快照；
- `evaluation.json`：断言、分项分数、总分和工程指标；
- `judge.json`：可选的 Mimo Judge 结果。

每次 CLI 调用还会创建一个 `suite-*` 目录，其中的 `summary.json` 汇总成功率、硬失败、平均分、P50/P95 延迟、Token 和 Judge 错误。

当前 Runner 默认串行运行。Fake 评测可以通过后续 CLI 扩展提高并发；真实 Mimo 和 Judge 评测默认保持串行，以避免限流和资源争用。
