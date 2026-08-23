# DreamCode 运行时工具与 Token 计量优化——确认设计

日期：2026-08-23

状态：已由用户批准并完成首版实施

## 1. 分类与实施关卡

本需求分类为**架构级变更（Architectural）**。

它同时影响共享工具协议、进程与 Shell 执行模型、权限判断、Agent 主循环、工具暴露与缓存策略、Provider usage 归一化、上下文压缩及评测指标。它不是只回答可行性的 Spike，也不是局限于单个文件或单一接口的 Bounded 变更。

本文件是需求确认、最终批准与实施范围记录。用户已于 2026-08-23 明确批准按本文件实施。后续若发现会扩大接口、引入新子系统或改变已确认语义的隐藏复杂度，仍必须停止、说明原因并重新确认。

## 2. 目标

本次改造需要同时达成以下目标：

1. 模型能够通过统一、低成本的 `runtime.info` 工具取得当前平台、命令方言、路径规则、执行语义和安全约束，减少跨平台试错。
2. 普通进程执行与真正需要 Shell 能力的执行分层，避免把参数、cwd、环境变量和复杂流程全部交给模型拼接成一条字符串。
3. 工具执行结果在 schema 层表达可判断的状态，使 Agent 无需解析 stderr 就能区分校验失败、权限拒绝、启动失败、非零退出、超时和中止。
4. 降低低信息密度调用造成的模型往返与上下文重复，包括重复只读结果、未使用工具 schema 和过量命令输出。
5. 修正 Token 计量：上下文估算覆盖消息、工具定义和 Provider 协议开销；usage 保留缓存命中输入 Token，并区分上下文占用与成本明细。
6. 保持历史事件和会话向后可读，并以可重复测试证明行为及降本效果。

## 3. 明确不做的事项

首版不包含以下功能：

- 不新增独立 runtime package。
- 不实现有状态 Shell session，不跨调用保留 cwd、变量或 Shell 状态。
- 不实现 pipeline/workflow DSL 或结构化多步骤执行器。
- 不扫描 git、node、pnpm、python、rg 等开发工具及其版本。
- 不根据 stderr 猜测缺依赖、测试失败、编译失败等业务原因。
- 不自动重试进程或 Shell 命令。
- 不建立跨用户回合或持久化的工具结果缓存。
- 不引入工具搜索/启用往返。
- 不内置模型价格表，也不新增价格配置或成本 UI。
- 不对现有持久化事件做破坏性迁移。

## 4. 总体方案

采用“契约优先、在现有包边界内演进”的方案：

- `packages/shared` 定义稳定的运行时、执行结果、错误分类、Token 估算和 usage 契约。
- `packages/tools` 实现运行时探测、`process.run`、受约束的 `shell.run`、输出外置与结构化执行结果。
- `packages/models` 的 Provider adapter 实现请求感知的 Token 估算与 Provider usage 归一化。
- `packages/core` 负责工具分层暴露、回合内缓存与失效、权限协调及执行路径。
- `packages/context` 使用本次实际发送的工具集合和 Provider 估算回调完成预算判断与压缩。

依赖方向保持为 `shared <- tools/models/context <- core`。Context 不依赖具体 Provider 包；Provider 能力以 shared 中的接口或回调注入，避免形成依赖环。

## 5. 运行时信息工具

### 5.1 调用语义

`runtime.info` 是模型可显式调用的只读工具。它不自动注入每轮上下文，结果可在当前用户回合复用。

模型未先调用 `runtime.info` 时，`process.run` 和 `shell.run` 仍可执行。工具说明应建议模型在首次需要平台相关 Shell 语法时查询运行时信息，但运行时不得通过人为失败强制增加一次调用。

### 5.2 返回内容

返回结构至少覆盖：

- 平台：操作系统、CPU 架构、路径分隔符、换行风格。
- 执行器：默认 Shell 方言、由运行配置确定为可用的 Shell 方言、进程参数风格。
- 语法提示：路径引用、环境变量引用和命令示例采用的方言。
- 作用域：每次调用无状态、默认 workspace、cwd 与 env 必须显式提供。
- 限制：timeout 上限、Shell 单表达式/管道约束、workspace 边界和外部 cwd 的审批语义。
- 能力：`process.run` 适用于普通可执行程序，`shell.run` 只适用于管道、重定向、通配符或 Shell 内建能力。

默认 Shell 必须来自 DreamCode 实际执行器配置，而不是假定为启动 DreamCode 的交互终端。该工具不扫描开发程序或版本，也不返回宿主环境变量的名称或值。显式请求未声明为可用的 Shell 时，执行工具返回结构化 `unsupported_shell`，不得先用错误方言试跑。

## 6. 两层命令执行协议

### 6.1 `process.run`

`process.run` 是默认命令执行工具，输入由独立字段组成：

- `program`：可执行程序名或路径。
- `args[]`：逐项参数，不进行 Shell 插值。
- `cwd`：可选工作目录。
- `env`：可选的本次调用环境覆盖。
- `timeoutMs`：受统一上限约束的超时值。

执行必须使用 `shell: false`。工具继承 DreamCode 进程的宿主环境以保留 PATH、代理、SDK 和包管理器兼容性，再应用本次调用的 `env` 覆盖。模型和工具结果不得回显未显式提供的宿主环境变量值。

### 6.2 `shell.run`

`shell.run` 只用于明确需要 Shell 能力的情况。它保留字符串 `command`，并增加可选 `shell`、`cwd`、`env`、`timeoutMs`：

- 省略 `shell` 时使用 `runtime.info` 报告的默认方言。
- 可显式选择运行配置支持的 `powershell`、`cmd`、`bash` 或 `sh`。
- 允许单个命令、单个 Shell 表达式或一个管道。
- 允许该方言的管道、重定向、通配符和必要内建语法。
- 拒绝引号外的 `;`、`&&`、`||`、多行步骤等多步骤连接方式。
- 拒绝以 `cd` 或变量赋值表达期望跨调用保留的状态；分别提示使用 `cwd` 和 `env` 字段。

校验器必须按最终选择的方言运行，并对引号和转义进行感知，避免把字符串字面量中的连接符误判为流程控制。首版不把多步骤命令自动拆分或重写。

### 6.3 无状态与目录边界

每次 `process.run` 和 `shell.run` 都是独立进程。前一次调用的 cwd、变量和 Shell 状态不会被后续调用继承，工具 schema 和说明必须明确这一事实。

`cwd` 可以位于 workspace 外，但必须进入权限引擎的外部路径判断。外部 cwd 的允许、询问或拒绝遵循当前运行模式及安全配置：guided 等模式可以要求用户审批，yolo/full 可以在现有规则允许时自动放行。路径必须先解析为规范绝对路径后再判断边界，不能依赖未经解析的变量或相对路径字符串。

## 7. 结构化工具结果

### 7.1 通用层

保留现有 `ToolResult.status`：`success | error | cancelled | denied`。新增字段采用可选形式，使旧事件和旧会话仍可读取。

标准错误至少包含：

- `category`：`validation | permission | environment | execution | timeout | cancelled | internal`。
- `reason`：稳定、机器可读的细分代码。
- `message`：供人阅读的简短说明。
- `retryable`：仅根据确定性事实赋值，不依据 stderr 猜测。
- `details`：可选结构化细节，例如校验违规列表。

现有 `ToolError.code` 为兼容字段，不能删除。新产生的结果必须令 `code` 与 `reason` 使用同一个稳定代码；旧事件只有 `code` 时，读取层将它作为 reason 使用，但不得虚构 category 或 retryable。

### 7.2 执行层

`ToolResult` 在顶层新增可选的 `execution`、`streams`、`warnings` 和 `cache` 结构；不把这些标准状态埋入各工具自由定义的 `data`。非执行类工具可以不提供 `execution` 和 `streams`，非缓存命中可以不提供 `cache`。

`process.run` 与 `shell.run` 的顶层 `execution` 包含：

- `outcome`：`validation_failed`、`permission_denied`、`unsupported_shell`、`program_not_found`、`spawn_failed`、`exited_zero`、`exited_nonzero`、`timed_out`、`aborted` 或内部失败对应值。
- `started`：进程是否确实开始执行。
- `exitCode`、`signal`、`timedOut`：存在时返回。
- 当超时或中止后无法确认所有子进程已终止时，明确标记可能存在未确认副作用。

顶层映射固定为：

- 参数/语义校验失败、启动失败、非零退出使用 `error`。
- 超时、用户中止或 AbortSignal 使用 `cancelled`。
- 安全规则或审批拒绝使用 `denied`。
- 退出码 0 使用 `success`。

Shell 语义校验失败返回 `violations[]`，每项包含稳定代码、说明及能够可靠取得时的位置。确定性 reason 包括但不限于 `multiple_shell_steps`、`stateful_shell_construct`、`workspace_boundary`、`unsupported_shell`、`program_not_found`、`spawn_failed`、`nonzero_exit`、`timed_out` 和 `aborted`。

### 7.3 输出控制

stdout 与 stderr 各自最多内联约 4 KiB，采用首尾预览而不是只保留开头。每个流同时返回：

- 总字节数。
- 是否截断。
- 内联预览。
- 截断时的完整 artifact 引用。

以上信息位于顶层 `streams.stdout` 与 `streams.stderr`。现有 `stdoutRef`、`stderrRef` 在兼容期继续填写；其值与对应 stream 的 artifact 引用指向同一内容。新增警告统一位于顶层 `warnings[]`。

模型不能通过输入参数无限提高内联上限。stderr/stdout 是证据，不参与业务失败分类。

进程已经执行但 artifact 保存失败时，必须保留真实的执行 outcome，并通过 `warnings[]` 报告持久化问题，不能把它改写为“命令执行失败”，也不能触发自动重试。

## 8. 工具暴露与回合内缓存

### 8.1 工具分层

每轮请求不再无条件发送全部工具 schema。

核心工具固定为：

`runtime.info`、`file.read`、`artifact.read`、`file.write`、`file.patch`、`file.list`、`search.grep`、`search.glob`、`process.run`、`shell.run`、`git.status`、`git.diff`、`todo.write`、`question.ask`。

可选工具族为 `web.*`、`skill.*`、`mcp.*`。可选工具必须同时满足“对应功能已配置”和“用户请求明确涉及该能力”才暴露。明确意图由 Core 的确定性暴露策略判断，例如请求中直接要求 Web、指定 Skill，或点名已配置 MCP 能力；策略不通过额外模型调用判断。某工具族在当前用户回合启用后，本回合后续模型请求保持可见，避免工具集合反复变化。新用户回合重新判断。

### 8.2 只读缓存

缓存只存在于当前用户回合。缓存键由工具名、规范化输入和当前工作区修订标识组成。

在工作区未变化时重复调用完全相同的只读工具，返回紧凑缓存命中结果，而不是重放完整数据。命中结果至少包含：

- `outcome: cache_hit`。
- 原结果的 tool call/event 引用。
- 简短摘要。
- 工作区修订标识。

缓存元数据位于顶层 `cache`；`outcome: cache_hit` 只表达结果来源，不替代通用顶层 `status: success`。

原始结果仍保留在当前结构化消息历史或 artifact 中。缓存命中结果的序列化载荷必须比原完整结果至少减少 90%。

任何可能产生副作用的工具在通过校验和权限判断并开始执行后，都使工作区相关缓存失效，无论最终成功、失败还是状态不确定。校验阶段拒绝、权限拒绝且未执行时不产生无意义的失效。用户回合结束后清空缓存。

### 8.3 重试策略

运行时不自动重试 `process.run` 或 `shell.run`，也不接受模型提供的自动重试次数。结果提供 `retryable`、是否已启动和可能副作用等事实，由 Agent 决定是否安全地发起新的调用。

## 9. Token 与上下文计量

### 9.1 两种不同语义

缓存命中的输入 Token 仍占用模型上下文窗口，因此不能从上下文容量中扣除。计量字段定义为：

- `inputTokens`：本次请求的全部输入 Token。
- `cachedInputTokens`：其中由 Provider 报告为缓存命中的子集。
- `uncachedInputTokens`：当 input 与 cached 均已知时由两者相减得到。
- `outputTokens`：输出 Token。
- `totalTokens`：Provider 实报优先；缺失时仅由已知组成项推导，并标记来源。
- `costUsd`：只透传 Provider 明确返回的数据，本项目不维护价格表。

Provider 未返回缓存明细时，`cachedInputTokens` 和 `uncachedInputTokens` 保持 `undefined`，不得把未知值写成 0。若 Provider 返回的字段彼此不一致，保留原始实报总量并记录归一化警告，不静默用估算覆盖。

### 9.2 请求前估算

采用 Provider 感知的请求估算器。估算输入必须与实际请求使用相同的 messages 和工具集合，覆盖：

- `messageTokens`。
- `toolDefinitionTokens`，包含工具描述和完整 input schema。
- `providerOverheadTokens`，包含 Provider 的消息模板、角色、工具协议等开销。
- `inputTokens`，为上述组成的合计。
- `exact` 与 `estimationMethod`，说明计数器和准确性来源。

支持精确 tokenizer 和请求编码规则时使用精确估算；不支持时使用明确标记的近似回退。不得把近似结果标成精确。

### 9.3 Context 构建顺序

Core 必须先确定本回合实际工具集合，再调用 ContextBuilder。ContextBuilder 接收实际 `ToolModelSpec[]` 和 Provider 估算回调：

1. 构建 system message、历史消息和 todo。
2. 对完整请求估算输入 Token。
3. 超预算时按 assistant tool call 与对应 tool result 的原子组选择可压缩历史。
4. 生成 checkpoint 后，使用同一工具集合重新估算。
5. 满足预算后才发给 Provider；若没有可安全压缩的完整旧交互，则返回明确的预算状态，不假装已经满足限制。

发送前估算与请求后 Provider 实报分别持久化，不能相互覆盖。事件应能计算估算误差，并区分消息、工具 schema 与协议开销的成本来源。

## 10. 完整数据流

一个用户回合按以下顺序运行：

1. Core 根据用户请求、运行配置和已启用能力生成稳定的本回合工具集合。
2. Core 把实际工具集合与 Provider 估算回调交给 ContextBuilder。
3. ContextBuilder 构建、估算并在需要时压缩上下文。
4. Provider 收到与估算完全一致的 messages/tools，并流式返回文本、工具调用和 usage。
5. Provider adapter 归一化实报 usage，保留缓存输入明细。
6. Core 对工具调用执行 schema 校验、动态风险判断和权限决策。
7. `runtime.info` 返回当前回合可复用的稳定环境事实；执行工具完成方言校验、cwd 解析、环境合并和进程启动。
8. 结构化结果写入事件日志与下一轮 tool message；大输出仅提供首尾预览和 artifact。
9. 只读重复调用返回紧凑引用；执行副作用工具后相关缓存失效。
10. 回合结束后清空临时缓存和可选工具启用状态，历史事件继续用于会话恢复。

## 11. 兼容性

- `ToolResult`、`ModelUsage` 与事件载荷只新增可选字段。
- 旧事件缺少执行细分、估算组成或缓存 Token 时按未知处理，不能推断为 0 或成功。
- 旧会话恢复和投影逻辑必须继续工作。
- 仓库内部 `ContextBuilder`、Provider、Tool Registry 与 Core 的 TypeScript 调用接口允许同步迁移。
- `shell.run.command` 继续存在，但新语义校验会拒绝多步骤串联；普通无 Shell 需求的既有调用应迁移到 `process.run`。

## 12. 测试与验收

### 12.1 测试层次

单元测试覆盖：

- `runtime.info` 的 Windows/Linux 平台映射和默认执行器方言。
- `process.run` 参数、cwd、env、timeout 传递。
- PowerShell、cmd、bash、sh 的引号、转义、管道和连接符校验。
- 错误 category/reason、顶层 status 和 execution outcome 映射。
- stdout/stderr 4 KiB 首尾预览与 artifact 外置。
- 工具暴露策略、缓存键、紧凑命中和失效边界。

契约与兼容测试覆盖：

- 新工具的 JSON schema 和顶层 object 兼容性。
- 旧 `ToolResult`、旧 `ModelUsage`、旧事件与旧会话的读取。
- 外部 cwd 进入现有权限模式与安全配置的决策链。

集成测试使用 Node 自身作为跨平台子进程，覆盖退出码 0、非零退出、stdout/stderr、program not found、超时、中止和 artifact 外置，不依赖真实付费模型。Shell 方言校验使用确定性夹具；仅在对应执行器可用的 CI 平台执行实际方言集成测试。

Provider/Context 测试覆盖：

- OpenAI-compatible usage 夹具中的缓存 Token 字段归一化。
- Provider 未返回缓存字段时保持未知。
- 消息、工具 schema 和 Provider 开销全部进入请求前估算。
- 精确 tokenizer 与近似 fallback 的标记。
- 压缩前后使用同一实际工具集合重新估算。

Core 与 Eval 覆盖：

- 未启用 Web/Skill/MCP 时不发送其 schema。
- 相同只读调用返回紧凑缓存引用。
- 潜在副作用执行后缓存失效。
- `runtime.info` 未调用时执行工具仍可工作。
- Windows/Linux 命令选择、重复探测、长工具 schema 和缓存 usage 定向场景。
- 现有 tools、safety、core、context、models、evals 测试无回归。

### 12.2 硬性验收指标

1. Windows/Linux 定向用例中，错误平台命令试探次数为 0。
2. 相同只读调用的缓存命中载荷相较原完整结果减少至少 90%。
3. 未启用 Web/Skill/MCP 时，其工具 schema Token 为 0。
4. 有精确 tokenizer 与确定请求编码的测试夹具中，请求前估算误差不超过 5%。
5. Provider 返回的缓存 Token 字段无损归一化。
6. 现有工具、安全、Core、Context、Models 和 Evals 测试无回归。

## 13. 实施顺序

最终批准后按以下顺序实施，每一步完成契约测试后再进入下一步：

1. 共享契约与向后兼容解析。
2. `runtime.info`、`process.run`、`shell.run` 校验及统一执行结果。
3. Core 工具暴露、回合缓存与失效策略。
4. Provider 请求估算与 usage 归一化。
5. Context 预算和压缩数据流迁移。
6. 集成测试、定向 eval、全量回归与文档同步。

该顺序只表达构建依赖，不授权在设计未批准时开始任何一步。

## 14. 最终批准记录

用户已明确回复“是，批准按该文档实施”。该批准覆盖本文件中的目标、范围、架构、组件、数据流、错误语义、兼容策略、测试和验收指标，不允许实施过程中自行扩大范围。

## 15. 首版实施结果

首版已在原有包边界内完成：

- 新增 `runtime.info` 与结构化、无 Shell 的 `process.run`。
- 保留 `shell.run.command`，增加方言、cwd、env 和单表达式/管道语义校验。
- 执行结果增加标准错误分类、execution outcome、4 KiB 首尾流预览和 artifact 引用。
- Core 按核心/可选工具族分层发送 schema，并使用仅限当前用户回合的紧凑只读缓存。
- Provider usage 保留缓存输入与未缓存输入，Context 以实际工具 schema 和 Provider 估算回调计算请求预算。
- Eval 指标保留缓存 Token 完整性，桌面状态能够累计新增 usage 字段。
- README 与针对性测试已同步。

验证结果：类型检查和全仓构建通过；新增及相关的 65 项定向/回归测试通过，其中 eval runner 覆盖 52 个隔离任务，并新增运行时选择、只读缓存、工具暴露和缓存 usage 四类效率场景。全量 Vitest 中其余 225 项通过，`packages/core/src/core.test.ts` 的 10 项旧测试因工作树在本次实施前已删除 `failing-test-js`、`safety`、`readme-update` 三组旧 fixture 而无法启动；本次实施未恢复或覆盖这些用户删除项。
