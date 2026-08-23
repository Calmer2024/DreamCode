# DreamCode Provider Usage 校准与权限能力契约——确认设计

## 1. 文档状态

- 任务分类：架构级（Architectural）。
- 方案选择：方案 1——最终请求估算、Provider 实报校准与权限能力契约自动注入。
- 设计状态：架构、组件、数据流、错误处理和测试设计已逐节获得用户确认；已获用户最终审阅和实施批准。
- 实施状态：执行中（批准日期：2026-08-23）。

## 2. 背景与问题定义

本轮只处理以下两个问题：

1. Provider 实报 usage 已用于请求后的真实统计，但请求前的上下文预算仍依赖通用的字符数 `/4` 近似。该近似被用于压缩触发点和剩余上下文判断，在 Mimo 真实评测中稳定低估输入 Token。
2. 模型虽然可以通过 `runtime.info` 获取平台、命令风格和当前 mode，但现有信息没有表达该 mode 下命令类别的实际 allow、ask、deny 范围；并且模型需要主动调用工具才能获得这些信息，导致命令猜测和权限拒绝。

本轮不处理拒绝后的强制停止、调用预算、信息密度评分或其他收敛机制。权限系统继续负责最终授权，本设计只让模型在规划前获得与真实权限规则同源的能力信息。

## 3. 目标

1. Token 估算和 Provider 实际请求使用同一个最终请求构造结果，消除序列化对象不一致。
2. 使用 Provider 实报 `inputTokens` 校准后续请求前估算，同时保持实报 usage 为请求后统计的唯一真实来源。
3. 缓存命中 Token 继续计入完整上下文占用，仅作为成本明细拆分，不从请求前上下文估算中扣除。
4. 从 Safety 的唯一规则来源生成当前平台、当前 mode 的权限能力契约。
5. 在第一次模型请求前自动注入紧凑的 runtime 与权限快照，不产生额外工具调用。
6. 保留 `runtime.info` 工具，使其返回与自动注入快照同源的完整运行时和权限信息。

## 4. 非目标与 YAGNI 边界

本轮明确不实现：

- 自研或逆向 Mimo tokenizer。
- 按语言、工具数量、消息长度建立多维校准模型。
- Provider token-count 额外网络请求。
- `permission.preview` 工具。
- 权限预测模型。
- 拒绝后的强制 synthesis 或工具类别冷却。
- 全局调用预算、信息密度评分和其他收敛控制器。
- 为所有 Provider 同时承诺统一的估算误差。
- 将权限摘要作为授权凭证或允许其绕过 PermissionEngine。

## 5. 总体架构

系统分为四层：

```text
Safety
  └─ PermissionRuleCatalog
       ├─ PermissionEngine 实际判定
       └─ PermissionCapabilityBuilder 权限能力契约

Models
  ├─ ProviderRequestBuilder 最终请求构造
  ├─ RequestTokenEstimator 基础请求估算
  └─ UsageCalibrator Provider 实报校准

Core
  ├─ 选择本轮实际工具集合
  ├─ RuntimeContextInjector 自动注入紧凑快照
  └─ 协调 Context、Provider 和 usage 事件

Context
  └─ 使用校准后输入估算决定预算和压缩
```

架构约束：

- Token estimator 与 Provider adapter 不得各自维护请求序列化逻辑。
- Provider 实报 usage 始终优先进入最终统计，估算值只用于请求前预算或 Provider 缺失 usage 时的显式 fallback。
- Safety 规则是权限判定和模型能力摘要的唯一事实来源。
- 自动注入内容只用于模型规划；每次实际工具调用仍由 PermissionEngine 独立复核。
- 本轮不改变权限拒绝后的主循环控制流。

## 6. 组件设计

### 6.1 ProviderRequestBuilder

Models 层新增统一的最终请求构造器，将内部消息和工具定义转换为实际发送的 OpenAI-compatible 请求结构。它必须覆盖：

- user、system、assistant 和 tool 消息转换；
- assistant tool calls 序列化；
- tool result message 序列化；
- 工具名称清洗和反向映射；
- function tool 的 description 与 parameters 包装；
- Provider 请求所需的固定协议字段。

Provider adapter 和 RequestTokenEstimator 必须消费同一构造结果。最终请求构造失败时不得回退到旧的独立序列化路径。

### 6.2 RequestTokenEstimator

估算器接收最终请求结构并返回：

```ts
interface RequestTokenEstimate {
  messageTokens: number;
  toolDefinitionTokens: number;
  providerOverheadTokens: number;
  baseInputTokens: number;
  calibratedInputTokens: number;
  correctionRatio: number;
  sampleCount: number;
  coldStart: boolean;
  exact: boolean;
  estimationMethod: string;
}
```

`baseInputTokens` 表示 tokenizer 或字符近似对最终请求的基础估算；`calibratedInputTokens` 表示应用 Provider/model 校准后的结果，并作为 Context 的上下文预算输入。

### 6.3 UsageCalibrator

校准状态按以下键隔离：

```text
provider + model + requestClass + estimatorVersion
```

第一阶段的 `requestClass` 只有：

- `with_tools`：本次请求包含至少一个工具定义。
- `messages_only`：本次请求不包含工具定义。

每次收到合法的 Provider 实报 `inputTokens` 后，计算 `inputTokens / baseInputTokens`，并用平滑方式更新校准比例。校准状态只保存 Provider、模型、请求类别、估算算法版本、样本数、比例、Token 统计和更新时间，不保存消息正文、工具参数、文件内容或命令内容。

样本不足时使用 Provider/model 的冷启动保守系数。Mimo 初始系数以已捕获的真实评测数据为依据；后续合法实报样本逐步替代冷启动值。

校准统计保存在 DreamCode 本地配置目录的独立文件中，采用原子替换写入并跨会话复用。Provider、模型、请求类别或估算算法版本变化时使用新的校准键，旧样本不参与新估算。

### 6.4 PermissionRuleCatalog

将现有命令匹配规则整理为声明式条目。每条规则至少包括：

```ts
interface PermissionRule {
  id: string;
  matcher: CommandMatcher;
  risk: RiskTag[];
  decisions: Record<RunMode, PermissionDecisionKind>;
  capability: {
    category: string;
    summary: string;
    examples: Partial<Record<RuntimePlatform, string[]>>;
  };
}
```

`matcher` 继续由 Safety 内部使用，不进入模型上下文。`capability` 只负责生成面向模型的规划摘要。缺少某个 mode 决策的规则按 `deny` 处理，并由测试视为契约错误。

### 6.5 PermissionCapabilityBuilder

根据当前平台和 mode 从 PermissionRuleCatalog 生成：

```ts
interface PermissionCapabilityContract {
  schemaVersion: number;
  rulesVersion: string;
  generatedFor: { platform: string; currentMode: RunMode };
  defaultDecision: PermissionDecisionKind;
  modes: Record<RunMode, {
    allow: CapabilityCategory[];
    ask: CapabilityCategory[];
    deny: CapabilityCategory[];
  }>;
  currentModeSummary: {
    allow: CapabilityCategory[];
    ask: CapabilityCategory[];
    deny: CapabilityCategory[];
  };
  shellRun: {
    allowPipelines: boolean;
    allowMultipleSteps: boolean;
    guidance: string;
  };
}
```

能力类别包含稳定 ID、简短说明和少量当前平台示例。契约不返回原始正则表达式，也不穷举所有命令；未匹配命令必须明确展示当前 mode 的默认决策。

### 6.6 RuntimeContextInjector

Core 在每个用户回合的第一次模型请求前，自动注入紧凑的 runtime 与权限快照。快照包括：

- 当前平台、路径和命令风格；
- 当前 mode；
- `process.run` 与 `shell.run` 的使用边界；
- allow、ask、deny 命令类别；
- 未分类命令的默认决策；
- 少量当前平台代表性示例；
- 权限 schema 和 rules 版本。

自动注入不表现为工具调用，不增加一次模型—工具往返。快照包含四种 mode 的能力矩阵，并突出当前 mode。相同用户回合内复用同一快照；若 mode 或运行环境发生变化则重新生成。

为提高 Provider 前缀缓存命中率，固定的 Agent 指令、能力矩阵和当前运行时快照位于 Context system 消息的前部；workspace 摘要、项目规则、todo、历史消息和工具结果位于其后。动态内容不得插入固定前缀中间。

`runtime.info` 继续保留，并调用同一个 PermissionCapabilityBuilder 返回完整版本，避免自动注入内容与工具返回内容漂移。

## 7. 数据流

### 7.1 请求前估算

```text
Core 选择实际工具集合
  → RuntimeContextInjector 注入 runtime 与权限快照
  → Context 组装候选 messages
  → ProviderRequestBuilder 构造最终请求
  → RequestTokenEstimator 计算 baseInputTokens
  → UsageCalibrator 读取匹配校准状态
  → 生成 calibratedInputTokens
  → Context 判断是否需要压缩
  → 如发生压缩，重新构造最终请求并重新估算
  → Provider adapter 发送同一最终请求结构
```

压缩前后必须各自重新估算，不能沿用压缩前的 Token 结果。

### 7.2 请求后 usage 与校准

```text
Provider 实报 usage
  → 归一化 input/cached/uncached/output/total
  → 最终统计直接使用实报值
  → 校验 inputTokens 与 baseInputTokens
  → 计算 observedRatio
  → 更新对应校准状态
```

校准目标是完整 `inputTokens`。`cachedInputTokens` 和 `uncachedInputTokens` 仅用于成本与缓存明细；缓存命中内容仍占用上下文窗口，因此不得从校准目标中扣除。

Provider 未返回 `inputTokens` 时，本次不更新校准器。若 Provider 完全没有返回 usage，可保留现有显式估算 fallback，但必须标记 `estimated: true`，不能作为校准样本。

### 7.3 权限能力

```text
PermissionRuleCatalog
  ├─ PermissionEngine.decide(actualCommand, mode)
  └─ PermissionCapabilityBuilder.build(platform, mode)
       ├─ RuntimeContextInjector
       └─ runtime.info
```

模型收到能力契约后仍不能自行授权。实际的 `process.run`、`shell.run` 和其他受控工具调用继续走现有校验、权限判断和执行流程。

## 8. 错误处理

### 8.1 Token 与校准错误

- Provider 未返回 `inputTokens`：保留其他实报字段，本次不更新校准状态。
- `cachedInputTokens > inputTokens`：保留 Provider 原始实报并记录警告，不推导未缓存输入，不采纳为校准样本。
- 比例非有限值、基础估算非正数或明显超出合理边界：丢弃样本并记录警告，不影响本次模型响应。
- 校准文件不存在、损坏或版本不兼容：使用冷启动保守系数，不阻止请求。
- 校准状态写入失败：请求继续完成，记录非致命警告。
- 最终请求构造失败：终止 Provider 请求，不回退到另一套序列化路径。
- Provider 未实报 usage：统计明确标记为估算，不能与实报值混合为相同可信等级。

### 8.2 权限能力错误

- 能力摘要构建失败：不注入摘要，PermissionEngine 继续工作，权限不得放宽。
- 规则缺少模型说明或当前平台示例：仍参与实际权限判定，但不进入模型摘要。
- 规则缺少 mode 决策：实际判定按 `deny`，同时使契约测试失败。
- 平台无法识别：使用通用运行时描述和最保守的默认命令决策。
- 自动注入摘要与 `runtime.info` 的版本不一致：记录内部一致性错误；实际判定仍以 PermissionEngine 为准。
- 模型依据摘要提出不允许的命令：PermissionEngine 正常拒绝；本轮不改变拒绝后的收敛行为。

### 8.3 可观测性

`context.built` 增加或保留以下字段：

- message、tool-definition 和 provider-overhead 基础估算；
- `baseInputTokens` 与 `calibratedInputTokens`；
- 校准比例、样本数和是否冷启动；
- 估算方法和算法版本；
- 权限契约 schema 与 rules 版本。

日志和校准状态不得记录 API key、完整提示内容、文件内容、工具参数或完整命令历史。

## 9. 测试设计

### 9.1 Models 单元测试

- 最终请求构造器输出与 Provider adapter 实际消费结构一致。
- `messages_only` 与 `with_tools` 使用独立校准状态。
- 合法 Provider 实报更新正确校准键。
- 缺失或异常 `inputTokens` 不污染校准状态。
- cached token 不从上下文占用中扣除。
- 校准文件损坏时回退冷启动系数。
- 估算算法版本变化后不复用旧样本。

### 9.2 Safety 单元测试

- 每条规则在全部 mode 下具有明确决策。
- PermissionEngine 与能力契约对所有代表性示例的决策一致。
- 未分类命令默认决策一致。
- Windows 和 Linux 示例不交叉暴露。
- 摘要构建失败不会放宽实际权限。

### 9.3 Core 与 Context 单元测试

- 第一次模型请求已包含 runtime 与权限摘要。
- 自动注入不生成额外工具调用。
- 相同回合后续请求复用同一快照。
- mode 或运行环境变化时生成新快照。
- 压缩前后均通过最终请求结构重新估算。
- `context.built` 包含基础估算、校准结果和契约版本。

### 9.4 集成测试

- Mimo usage 回放覆盖冷启动、实报更新、后续收敛和跨会话复用。
- `messages_only` 样本不污染 `with_tools` 校准。
- 模型第一次请求即可看到当前平台、mode 和命令范围。
- `runtime.info` 完整信息与自动注入摘要同源。
- allow、ask、deny 代表性命令与 PermissionEngine 判定一致。
- 实际工具调用不能凭能力摘要绕过 PermissionEngine。

### 9.5 Mimo 真实评测

- 第一次模型请求前不需要 `runtime.info` 探测调用。
- 模型直接选择当前平台命令。
- 契约明确标为 deny 的命令试探次数为 0。
- `process.run` 与 `shell.run` 的选择符合契约说明。
- Provider 实报 usage 与最终统计一致。
- 校准后的 `with_tools` 输入估算误差不超过 10%。
- 连续三个有效样本后，不再稳定出现超过 20% 的低估。

本轮不要求模型忽略契约后立即停止，也不以拒绝后的强制收敛作为验收条件。

## 10. 硬性验收标准

1. Token 估算和实际 Provider 请求使用同一最终请求构造结果。
2. Provider 实报 usage 始终优先于估算进入最终统计。
3. Provider 缺失 usage 时的 fallback 明确标记为估算，且不进入校准样本。
4. 缓存 Token 保留为输入子集，不从上下文占用中扣除。
5. 连续三个有效 Mimo `with_tools` 样本后，输入估算误差不超过 10%，且不再稳定低估 20% 以上。
6. PermissionEngine 与能力契约由同一 PermissionRuleCatalog 生成。
7. 模型第一次请求即可获得当前 runtime、mode 和权限摘要，无需工具探测调用。
8. 能力契约不能绕过实际权限判断；摘要失败或规则不完整不得放宽权限。
9. Mimo 定向用例中，契约明确标为 deny 的命令试探次数为 0。
10. 本轮改动涉及的 Models、Context、Safety、Core、Tools 和 Evals 测试无新增回归。

## 11. 实施边界与升级条件

实施仅限本文档描述的两个问题。若实施中发现以下情况，必须停止并重新确认范围：

- Mimo 必须依赖新的远程 token-count 服务才能满足误差目标；
- 需要改变拒绝后的主循环、调用预算或 synthesis 策略才能通过验收；
- PermissionRuleCatalog 重构会改变现有命令的真实 allow、ask、deny 语义；
- 需要保存用户提示、工具参数、文件内容或命令内容才能完成校准；
- 需要修改外部消费者依赖的公共接口且无法保持兼容。

## 12. 实施顺序

收到用户对本文档的明确实施批准后，按以下顺序执行：

1. 扩展共享估算、校准和权限能力契约类型。
2. 提取 ProviderRequestBuilder，并使估算与发送共用最终请求构造结果。
3. 实现 UsageCalibrator、持久化状态和 usage 更新路径。
4. 将 Safety 命令规则迁移为 PermissionRuleCatalog，并保持现有判定语义不变。
5. 实现 PermissionCapabilityBuilder、RuntimeContextInjector 和扩展后的 `runtime.info`。
6. 迁移 Context 预算到 `calibratedInputTokens`。
7. 补齐单元、集成和 Mimo 定向评测。
