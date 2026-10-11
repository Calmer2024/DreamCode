# DreamEval 文档入口

更新日期：2026-10-10

## 当前实现依据

[DreamEval case、数据集与评分系统决策](DreamEval-case-dataset-scoring-decision-2026-10-09.md) 是新实现的唯一设计依据。

该决策已经确认 case 的六字段结构、首批 60 道题的覆盖目标、环境与验收原则、执行证据、过程 Judge 和评分汇总规则。新数据集独立设计，不兼容旧 case；新协议已实现为独立运行入口；旧数据集保留历史用途。

综合评分已采用用户批准的 `composite-v1-token`：正确性 70%、过程 20%、资源效率 10%；资源效率按 Token 60% / 延迟 40%，初始基准 100,000 Token / 600 秒。见决策第 7.3 节。不得从历史文档补入旧政策，尤其不得自动继承 63＋37 权重或旧四字段 case 提案。

## 实施计划

[完整 60 道 case 数据集实施计划](DreamEval-dataset-60-implementation-plan-2026-10-09.md) 按当前决策安排协议、六道样题、完整候选选题、批次制作与入库验证。选题表是待核验候选，不代表已存在的缺陷或已完成的数据集；计划不改变当前决策中的字段和评分边界。

[新数据集运行说明](../../evals/dataset/README.md) 是新格式的实施入口。当前 `1.0.1` 已实现完整 60 道题，通过对照验证和用户授权的 Agent 复核；八次真实试跑覆盖六道样题。具体结果与范围见 [实施报告](DreamEval-dataset-60-implementation-report-2026-10-10.md)。

[评分系统闭环报告](DreamEval-scoring-closure-report-2026-10-10.md) 说明当前 `dataset-run-v4` 的场景汇总、过程复评、Judge 原始输出、公平比较和全量批次入口；历史试跑记录不回填新协议字段。

[综合评分首版实施](DreamEval-composite-scoring-implementation-2026-10-10.md) 说明用户批准的 70/20/10、Token/延迟计分、缺失规则、批次综合分与排名条件。

[多框架接入](DreamEval-multi-agent-frameworks-implementation-2026-10-10.md) 说明 Claude Code、Pi、DeepSeek Harness、OpenCode 的固定版本容器接入、原生协议、公开轨迹和 Token 采集，以及 Claude Code + MiMo 对照试跑的范围。新运行采用 v5，历史成绩不回填。

[过程 Judge 修复](DreamEval-process-judge-fix-2026-10-10.md) 整合编号错误、说明引用漏检、异步结果缺失、校准政策绑定及复评读取问题，说明新的过程 Judge 政策与真实验证范围。

[测评组与 20 题框架比较](DreamEval-groups-and-20-case-comparison-2026-10-10.md) 说明可复用测评组、默认 60 题组、10 类场景的小型组、启动及历史范围快照，以及 DreamCode / Claude Code + MiMo 的真实批次范围与结果位置。当前执行协议 `dataset-run-v6` 补齐公共传输截止时间与容器终止失败识别；首轮异常记录保留并排除排名。

[平台接入报告](DreamEval-platform-integration-report-2026-10-10.md) 说明新版题库、批次执行、三类结果及复评与比较已经接入平台默认入口。旧页面已由后续 UI 整理退出运行路径，当前只保留新版入口。

## 历史资料

[归档索引](archive/README.md) 保存旧方案、评审、运行报告、审核证据和示例，供追溯使用，不作为新实现依据。

新增文档应明确日期、状态与范围。已确认决策的变更需同步更新当前决策文档及此入口；未确认提案不得声明为当前标准。旧结论被替代后移入归档，不在根目录保留多个竞争入口。

[UI 整理与旧 V2 退役报告](DreamEval-platform-ui-cleanup-2026-10-10.md) 记录当前统一控件、图标、布局及旧代码与题库退出运行路径的范围。

[以批次组织评测记录](DreamEval-batch-records-implementation-2026-10-10.md) 说明批次列表、整体评价、所选题目与重复执行明细的层级，以及评分覆盖和计时规则。

[题目详情与中文任务要求](DreamEval-case-details-ui-2026-10-10.md) 说明四项关键信息、元数据标签、完整 JSON 和中文展示的来源校验。

[数据集组成总览](DreamEval-dataset-composition-ui-2026-10-10.md) 说明评测集顶部场景、项目与验收方式图表及筛选交互。
