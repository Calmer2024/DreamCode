# DreamEval 多框架接入

日期：2026-10-10。实现、模拟联调和 Claude Code + MiMo 的真实三题试跑已完成，最终版本已接入本地平台。

后续[过程 Judge 修复](DreamEval-process-judge-fix-2026-10-10.md)发现旧输入过滤遗漏了 Claude Code 子 Agent 的公开完成通知；部分旧 Judge 的“子 Agent 没有返回结果”判断不成立。下文原始成绩保持不变，新复评按独立政策保存，不混合生成正式排名。

## 实现范围

DreamEval 新建评测可分别选择 Agent 框架、Agent 模型和 Judge 模型。支持 DreamCode、Claude Code、Pi、DeepSeek Harness、OpenCode，选题与重复次数仍以批次组织。框架选择写入批次与执行记录，不增加 case 字段，也不改变数据集、验收器和评分公式。

框架适配器负责启动产品自身的 CLI/SDK、转换公开事件和采集遥测，不使用 DreamCode 的 Agent 循环代替外部产品。外部产品在每道题原有固定镜像中运行，额外挂载只读框架安装卷；工作区是同一份冻结源码的独立副本。容器继续采用无网络、只读根目录、2 CPU、2 GiB 内存与独立 home；只读题目的工作区也只读挂载。

模型请求通过容器内回环 HTTP 服务、stdio 和宿主机代理到已配置模型。真实密钥仅在宿主机注入上游请求头，CLI 获得的只是本地桥接用占位值。任务工具不能直接访问互联网。代理保留原生 API 请求与采样参数，不把 OpenAI 请求转换成 Anthropic 请求，也不偷偷替换模型。Claude Code 的 MiMo Anthropic 入口依据 [MiMo 官方接入说明](https://github.com/XiaomiMiMo/awesome-mimo-agent/blob/main/docs/claude_code.zh-CN.md)。

固定版本如下。它们是本次测试版本，不代表自动采用最新版。

| 框架 | 版本 | 运行入口 | 本次 MiMo 协议 |
|---|---|---|---|
| DreamCode | 当前工作区构建，保存 worker 摘要 | 内置容器 worker | 原有 provider |
| Claude Code | 2.1.226 | 官方 `claude -p --output-format stream-json` | Anthropic |
| Pi | 0.85.1 | 官方 `pi --print --mode json` | OpenAI compatible |
| DeepSeek Harness | 0.2.0-rc.2，SDK client 0.0.1-rc.1 | 官方 SDK + `sdk-minimal` composition | Anthropic |
| OpenCode | 1.18.21 | 官方 `opencode run --format json` | OpenAI compatible |

Claude Code 和本次 DeepSeek Harness 接入当前只开放已配置的 MiMo 官方端点。Pi、OpenCode 使用已配置的 OpenAI compatible 端点。未支持的协议在提交时拒绝，不伪装成可用。DeepSeek Harness 采用官方 SDK minimal composition，不能把这份配置的结果泛化为全部 DeepSeek Harness 插件组合。

各框架使用独立会话，不复制个人认证文件、历史会话、MCP 配置或自定义插件。容器已经提供文件与进程边界，Claude Code 的非交互权限和 OpenCode 的工具许可由容器承担约束。题目要求的禁止修改范围继续由公共验收流程检查。

## 证据与评分

保存框架版本、安装锁摘要、模型协议、容器镜像、worker 摘要，以及带时间的公开事件。原生事件经过过滤后保留，并转换为公共工具调用、工具结果和最终回答，复用同一过程 Judge。DeepSeek Harness 的提交事件采用其原始时间；其他 CLI 的工具事件标记为接收时间，不能据此虚构真实工具起止耗时。

Token 从宿主机观察的原生模型 HTTP 响应采集，每次生成请求只计一次；不再叠加 CLI 的累计用量。所有生成请求，包括框架内部辅助请求，均占用 80 次请求预算。缓存 Token 已包含在总输入中；输出内部 reasoning Token 不另加一次。失败或中断请求缺少完整用量时保留未知值和已报告小计。费用未提供时为 null，不影响 Token 计分。

私有 thinking/reasoning 块、增量和 DeepSeek 内部模型 stream 不写入正式证据。原始 HTTP 响应只作瞬时传输。不能从 CLI 退出码 0 推断任务成功：还需要产品终止事件、完整工具配对及公共验收。启动失败、协议错误和不完整轨迹标为评测异常；预算耗尽标为失败。

平台显示准备工作区、Agent 执行、任务验收、过程 Judge，以及当前模型请求和工具完成数量。CLI 与平台批次均固定一份 worker 副本，避免途中重新构建影响后续题目。跨框架比较允许框架版本、安装锁和原生协议不同，但继续要求题目、重复次数、预算、执行协议和 Judge 政策一致；输出保留各组配置。原生系统提示、工具集合、上下文策略、辅助请求与思考参数仍可能不同，这是产品比较的变量，不能据此声称只比较了 Agent 循环的一项差异。

## 验证与运行

四个真实 CLI/SDK 均在无网络题目容器中通过模拟上游测试：执行真实 shell 工具、修改隔离文件、输出最终回答、采集完整 Token。模拟测试没有调用付费模型，也不是数据集成绩。最终 worker 的统一联调证据位于 `evals/runs/agents-smoke/1263cc08-fdc6-4f13-803a-ce210a0e35c8/report.json`。DeepSeek SDK 的重复 scope 依赖实例已通过显式固定并统一核心依赖解决；没有修改其 Agent 代码。

相关协议、评分、平台和数据集测试通过 45 项，包含流中断用量不得冒充完整用量和跨框架预算一致性检查。类型检查与生产构建通过。平台浏览器测试验证了四个外部框架的选择、Claude Code 提交参数、新建评测、批次详情和移动布局；测试拦截启动请求，付费模型调用为 0。浏览器证据位于 `C:/Users/28109/AppData/Local/Temp/dreameval-dataset-web-T7wgmu/smoke.json`。

首次安装步骤（本机已有 Docker 与固定题目镜像）：

```powershell
docker tag sha256:4bdab846549aea0e4b783a8cfb55f798e767c66e29099cf3de01d9187e570976 dreameval-agents-build-base:2026-10-10
docker build -t dreameval-external-agents:2026-10-10 packages/evals/container/agents
pnpm eval:agents:install
pnpm eval:dataset:worker:build
pnpm eval:dataset agents
pnpm eval:web:build
```

安装程序校验镜像与两份锁文件的摘要一致，再创建带镜像与摘要标签的只读安装卷。安装回执位于 `evals/agents/installation.json`，不进入数据集或 Git；可通过 `DREAMEVAL_AGENT_INSTALLATION` 指定回执位置。保留仍被运行或记录引用的安装卷。

```powershell
pnpm exec tsx --conditions=development packages/evals/scripts/agents-smoke.ts
pnpm eval:dataset run CASE-001 mimo-v2.5-pro --agent claude-code
pnpm eval:dataset run-all mimo-v2.5-pro 1 --agent pi
```

CLI `--agent` 可选 `dreamcode`、`claude-code`、`pi`、`dsh`、`opencode`。平台地址仍为 `http://127.0.0.1:4178/`。

## 本次真实试跑

用户要求停止 DreamCode 60 题批次，优先 Claude Code + MiMo。原批次 `93a75f16-8456-4b32-91bc-4aeee8f48570` 保留 3 道完整记录（2 通过、1 超时）；第 4 道未完成执行不算 Agent 失败。

Claude Code 批次 `192d98fc-35c4-4e82-badb-fdda5f618744` 使用同一数据集版本 `1.0.1` 和摘要、CASE-001/002/003、MiMo Agent/Judge、20 分钟与 80 次请求预算，各执行一次，按顺序运行。原 DreamCode 记录是 v4，新框架记录是 v5；本次只能作为诊断对照，不生成正式跨协议综合排名。三道题也不能代表全部场景，更不能仅凭两组成功率就断言数据集或框架有问题。

CASE-001 已完成并通过确定性验收。Agent 耗时 840,626 ms（约 14.0 分钟），59 次模型生成请求、89 次工具调用，输入 2,613,790 Token、输出 21,678 Token，其中缓存输入 2,503,296 Token 已包含在输入总量中。Claude Code 调用了原生子 Agent；本次模型工具列表没有 Grep，但模型五次尝试调用 Grep 并收到错误，再改用 Bash。一次 Read 将目录作为文件读取。失败工具调用不能都视为测试失败，应逐项检查语义。

按桥接层 `model.started` 至 `model.usage` 的时间区间取并集，第一题有模型请求在途的时间为 829.6 秒，占 Agent 时长约 98.7%；第二题对应 318.2 / 321.0 秒。并集处理了子 Agent 并发，不能直接累加各请求耗时。这说明本次墙钟耗时主要落在模型请求期间，不能解释成仓库测试脚本本身跑了十几分钟；仍需结合生成长度、请求次数、模型服务与原生框架路径分析原因。

提交修改了 `src/click/core.py` 并在 `tests/test_basic.py` 增加回归测试，同时产生 `.pytest_cache`。现有 changes 采集将这些测试缓存也视作变更，造成补丁与 Judge 输入噪声，后续应区分提交源码与运行产物，同时保留原始证据。

过程 Judge 在两次格式修复后仍引用不存在的七位数字证据编号（正式编号为六位），本题过程分与综合分为 null，不能强行补成 0 或满分。原始记录保留在 `evals/runs/dataset/web-192d98fc-35c4-4e82-badb-fdda5f618744/CASE-001-e49b53e1-2856-4136-bbb2-37106fef5a28/record.json`。Judge 自身用量另行统计，不计入 Agent Token。此问题属于 Judge 引用可靠性，并非验收失败。

三道题均已完成，确定性验收 3/3 通过，无执行异常、无缺失用量；各题所有必需验收项均通过。过程评分覆盖 2/3，不具备完整综合评分条件，批次综合分保持 null。第二题 Judge 说明中有七位数字错写，第三题说明中的部分证据没有列入对应结构化 evidence 数组；审计已识别，不能把 68.75 的已评分子集均值解释为完整批次过程分。

| 题目 | DreamCode 验收 / Agent 分钟 / Token 总量 | Claude Code 验收 / Agent 分钟 / Token 总量 | Claude Code 过程分 |
|---|---|---|---|
| CASE-001 | 失败（超时） / 20.01 / 757,662 | 通过 / 14.01 / 2,635,468 | 缺失：Judge 引用失败 |
| CASE-002 | 通过 / 4.27 / 514,424 | 通过 / 5.35 / 527,574 | 75，说明引用需复核 |
| CASE-003 | 通过 / 7.52 / 888,825 | 通过 / 5.49 / 935,299 | 62.5，说明引用需复核 |

Claude Code 三题总输入加输出 4,098,341 Token，Agent 时长合计约 24.85 分钟；这些指标不包含验收与 Judge 开销。第一题通过说明任务在该冻结环境下可完成，但 Claude Code 的 Token 更高，不能把单题结果泛化为整体性能优势。第二题双方 Token 接近，第三题 Claude Code 较快但并未减少 Token。当前样本不足以证明数据集整体有效或确定框架整体排名。

三份记录的 runtime worker 摘要均为 `af7fb3680c5ca523d967fef31a3ca7fbd0b1b5078a8e02b0d11c37c8610ff7b9`，安装锁均为 `8763a924f4faca308de083283878dfd64e883c8c592168cd23799d39c0de15de`，Judge 政策一致。最终 worker 在三道 Agent 执行全部结束后构建，并通过四框架联调；批次结束后重启平台，部署批次 worker 固定和流中断用量检查。新安装锁 `097889298b418b6a5bb9ef8f41d58f3a68cd03c52fc78bea7d3bb46a5505e87c` 固定了 DeepSeek 的统一依赖；本次原始记录未覆盖或迁移。完整审计位于 `evals/runs/dataset/web-192d98fc-35c4-4e82-badb-fdda5f618744/full-eval-audit.json`。

## 发现的问题与后续优先级

1. 过程 Judge 引用可靠性：严格校验已阻止虚假编号产生分数，但说明文字与结构化引用仍可能不一致。应改进引用输出约束、同时校验说明引用，并以独立重评记录校准；不能静默改写本轮成绩。
2. 验收覆盖仍不充分：CASE-001 的任务要求包括新增回归测试及普通参数行为，现有验收没有覆盖全部要求；CASE-002 还需用不做修改的负例检查验收是否过弱；CASE-003 只有一个必需验收项。3/3 通过不能替代题目和验收器的质量审查。
3. 证据规模与噪声：第一题记录约 20.93 MiB，第二题约 5.67 MiB；测试缓存进入补丁、原生事件和重复上下文增大证据规模。应保留不可变完整证据，另存轻量索引，详情按需读取；避免列表反复加载整份记录。
4. 对比条件：当前统计是产品原生配置比较，包含子 Agent、不同系统提示和工具集合。需要同一新执行协议下、多场景和重复运行后再生成正式对比；Pi、DeepSeek Harness、OpenCode 本轮仅完成模拟上游联调，未宣称真实数据集成绩。
