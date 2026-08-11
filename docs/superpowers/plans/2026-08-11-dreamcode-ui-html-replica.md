# DreamCode 桌面 UI HTML 复刻实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个可在视觉伴侣中持续迭代的交互式 HTML Demo，完整复刻当前 DreamCode 桌面版的主要界面、覆盖层和运行状态。

**Architecture:** 在线程专属可视化目录维护一个 HTML Fragment 作为唯一设计源，通过根节点内的本地状态机渲染 DreamCode 产品画布和独立 Demo 控制区。视觉伴侣会加载每轮生成的版本；所有交互只修改页面内存状态，不连接 Electron、IPC、DreamCode Runtime 或文件系统。

**Tech Stack:** 原生 HTML、CSS、JavaScript、视觉伴侣 HTML Fragment、Lucide 图标、浏览器 DOM 断言与截图验证。

## Global Constraints

- 第一版只忠实复刻，不主动美化、重排或修正当前 UI。
- 默认产品画布为 `1440 × 900`，最小验证尺寸为 `1024 × 700`。
- 使用仿真示例数据，不复制本机真实会话、工作区、配置或凭据。
- 不修改现有 Electron/React 桌面端代码。
- Demo 不执行模型请求、工具调用、文件修改、配置保存或回滚。
- 产品界面样式全部限定在 `#dreamcode-ui-replica` 下，不复用视觉伴侣的通用卡片、按钮或主题类。
- 每个视觉伴侣版本使用新文件名，不覆盖已展示版本。

---

## File Structure

```text
C:/Users/28109/.codex/visualizations/2026/08/11/019fee7f-5de8-7380-84c2-b1f8f3b76ab7/
  dreamcode-current-ui.html          唯一可编辑 HTML Fragment，包含样式、示例数据和状态机

D:/Files/Github/DreamCode/.superpowers/brainstorm/$SESSION_ID/content/
  current-ui-baseline.html           视觉伴侣首轮展示副本
  current-ui-baseline-v2.html        首轮修正后的新版本
  waiting-*.html                     转回文字讨论时清除已完成画面

docs/superpowers/specs/
  2026-08-11-dreamcode-ui-html-replica-design.md

docs/superpowers/plans/
  2026-08-11-dreamcode-ui-html-replica.md
```

启动服务器后，将返回值中的会话目录名保存为 `$SESSION_ID`，将 `screen_dir` 保存为 `$SCREEN_DIR`，将 `state_dir` 保存为 `$STATE_DIR`。`dreamcode-current-ui.html` 是唯一设计源；视觉伴侣目录中的文件只是每轮展示快照，不在其中独立修改。

---

### Task 1: 启动视觉伴侣并建立页面骨架

**Files:**
- Create: `C:/Users/28109/.codex/visualizations/2026/08/11/019fee7f-5de8-7380-84c2-b1f8f3b76ab7/dreamcode-current-ui.html`
- Create: `$SCREEN_DIR/current-ui-baseline.html`

**Interfaces:**
- Consumes: `scripts/start-server.sh --project-dir D:/Files/Github/DreamCode --open`
- Produces: 根节点 `#dreamcode-ui-replica`、产品画布 `[data-dc-canvas]`、Demo 控制区 `[data-demo-controls]`、全局函数 `renderDreamCodeDemo()`。

- [ ] **Step 1: 启动视觉伴侣服务器**

运行 brainstorming skill 自带的 `scripts/start-server.sh`：

```text
scripts/start-server.sh --project-dir D:/Files/Github/DreamCode --open
```

记录返回的完整 `url`、`screen_dir` 和 `state_dir`。确认 `state_dir/server-info` 存在且 `state_dir/server-stopped` 不存在。

- [ ] **Step 2: 创建最小 HTML Fragment 骨架**

Fragment 必须以以下结构开始，不写 `<!doctype>`、`html`、`head` 或 `body`：

```html
<div id="dreamcode-ui-replica">
  <section data-demo-controls aria-label="Demo 状态控制"></section>
  <div class="dc-stage">
    <div class="dc-window" data-dc-canvas aria-label="DreamCode 桌面界面复刻"></div>
  </div>
</div>
```

在同一 Fragment 中加入根节点限定的 `<style>` 和 `<script>`。脚本通过 `document.getElementById("dreamcode-ui-replica")` 获取根节点，不使用 `document.currentScript`。

- [ ] **Step 3: 定义固定状态模型**

脚本定义：

```js
const demoState = {
  scene: "welcome",
  overlay: "none",
  drawerTab: "diff",
  runMode: "guided",
  profile: "deepseek-v4-pro",
  prompt: "",
};

const scenes = [
  "welcome",
  "no-workspace",
  "no-model",
  "history",
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "config-error",
];

const overlays = [
  "none",
  "config",
  "approval",
  "question",
  "drawer",
  "rollback",
  "error",
];
```

`renderDreamCodeDemo()` 必须完全由 `demoState` 派生 DOM，不读取浏览器存储或外部数据。

- [ ] **Step 4: 推送首个可连接画面**

将唯一设计源复制为 `screen_dir/current-ui-baseline.html`，确认视觉伴侣自动打开并显示空的产品画布和 Demo 控制区。

- [ ] **Step 5: 验证骨架**

检查：

```text
#dreamcode-ui-replica 存在
[data-demo-controls] 存在
[data-dc-canvas] 存在
页面无横向溢出
控制台无 JavaScript 错误
```

---

### Task 2: 忠实复刻基础应用外壳

**Files:**
- Modify: `C:/Users/28109/.codex/visualizations/2026/08/11/019fee7f-5de8-7380-84c2-b1f8f3b76ab7/dreamcode-current-ui.html`
- Create: `$SCREEN_DIR/current-ui-shell.html`

**Interfaces:**
- Consumes: `demoState.scene`、仿真工作区与会话数据。
- Produces: `renderSidebar()`、`renderTaskHeader()`、`renderComposer()`、`.dc-app-shell`。

- [ ] **Step 1: 定义当前桌面端视觉 Token**

在 `#dreamcode-ui-replica` 上定义并只在该根节点内使用：

```css
#dreamcode-ui-replica {
  --dc-brand: #a855f7;
  --dc-brand-dark: #7c3aed;
  --dc-sidebar: #f4f4f4;
  --dc-border: #dedede;
  --dc-muted: #777;
  --dc-warning: #d65a2f;
  color: #242424;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
}
```

- [ ] **Step 2: 实现 `1440 × 900` 产品窗口**

`.dc-window` 使用 `aspect-ratio: 1440 / 900` 和最大可用宽度缩放；内部 `.dc-app-shell` 使用 `grid-template-columns: 264px minmax(0, 1fr)`。产品窗口必须是不透明白色表面，外部舞台保持与产品分离。

- [ ] **Step 3: 实现侧栏**

复刻品牌行、三个主导航按钮、工作区标题、两个仿真工作区、五条会话、当前会话紫色强调和底部设置入口。使用 Lucide 对应图标：`square-pen`、`history`、`bot`、`folder`、`settings`。

- [ ] **Step 4: 实现任务标题栏**

复刻任务标题、工作区选择按钮和 `list`、`square-terminal`、`panel-right` 三个图标按钮。标题栏高度、底边框、左右间距必须与当前桌面 CSS 对齐。

- [ ] **Step 5: 实现悬浮输入框**

复刻三行 textarea、运行模式选择、模型选择、状态文字、发送/停止圆形按钮。选择器和输入仅更新 `demoState`；`Ctrl+Enter` 将场景切换到 `running`，不产生外部动作。

- [ ] **Step 6: 验证外壳**

在 `1440 × 900` 产品画布检查：左栏宽度为 `264px`，标题栏与左栏顶部对齐，输入框悬浮在主区域底部，主内容滚动区不会覆盖输入框。

---

### Task 3: 实现空状态、时间线和运行状态

**Files:**
- Modify: `C:/Users/28109/.codex/visualizations/2026/08/11/019fee7f-5de8-7380-84c2-b1f8f3b76ab7/dreamcode-current-ui.html`
- Create: `$SCREEN_DIR/current-ui-timeline.html`

**Interfaces:**
- Consumes: `demoState.scene`。
- Produces: `renderConversation()`、`renderTimelineEntry(entry)`、`sceneFixtures`。

- [ ] **Step 1: 定义仿真场景数据**

`sceneFixtures` 至少包含一条用户请求、一段助手回复、一个排队工具、一个运行工具、一个成功工具、一个文件变更、一个权限事件以及成功/失败/中断状态。路径统一使用 `D:/Projects/NebulaNotes`，不得引用本机真实路径。

- [ ] **Step 2: 实现三种空状态**

精确复刻：

```text
DreamCode Desktop / 准备好一起构建了吗？
工作区未选择 / 选择一个项目开始构建
模型未配置 / 先配置模型，再开始对话
```

后两种状态包含当前实现中的次要按钮。

- [ ] **Step 3: 实现时间线条目**

分别实现用户消息、助手消息、工具卡片、文件卡片、生命周期行和事件证据行。工具使用 `wrench`，文件使用 `file-code-2`，成功/失败/中断分别使用 `circle-check`、`circle-x`、`circle-stop`。

- [ ] **Step 4: 映射运行状态**

`starting` 显示“正在启动”和禁用发送按钮；`running` 显示“正在运行”和停止按钮；`completed`、`failed`、`interrupted` 分别显示对应时间线结尾与输入框状态。

- [ ] **Step 5: 验证时间线**

逐个切换全部 `scenes`，确认时间线可滚动、时间戳对齐、长路径换行、末条事件不被输入框遮挡，且没有虚构当前产品不存在的仪表盘或统计卡片。

---

### Task 4: 实现弹窗、抽屉、错误和回滚确认

**Files:**
- Modify: `C:/Users/28109/.codex/visualizations/2026/08/11/019fee7f-5de8-7380-84c2-b1f8f3b76ab7/dreamcode-current-ui.html`
- Create: `$SCREEN_DIR/current-ui-overlays.html`

**Interfaces:**
- Consumes: `demoState.overlay`、`demoState.drawerTab`。
- Produces: `renderOverlay()`、`renderConfigDialog()`、`renderApprovalDialog()`、`renderQuestionDialog()`、`renderDetailDrawer()`、`renderRollbackDialog()`。

- [ ] **Step 1: 实现配置弹窗**

包含配置名称、提供商、模型、自定义模型 ID、Base URL、API Key、环境变量、本地明文存储警告、取消和保存按钮。保存只关闭弹窗并显示本地成功状态。

- [ ] **Step 2: 实现审批与问题弹窗**

审批弹窗展示 `shell.run`、仿真命令输入和审批原因，提供拒绝与允许。问题弹窗展示问题、textarea 和提交按钮。按钮只关闭弹窗并在时间线追加仿真事件。

- [ ] **Step 3: 实现证据抽屉**

抽屉宽度使用当前规则 `min(720px, calc(100% - 280px))`，含 Diff、终端、事件、会话四个标签。标签切换更新 `demoState.drawerTab`。Diff 使用仿真补丁，终端使用仿真测试输出，事件与会话使用格式化 JSON。

- [ ] **Step 4: 实现回滚确认**

从 Diff 标签打开二次确认层，展示精确仿真路径和取消/确认回滚按钮。确认只显示“已回滚”演示提示，不改动任何文件。

- [ ] **Step 5: 实现错误状态**

普通错误使用输入框上方的错误横幅；`config-error` 使用当前配置载入失败空状态和“重新加载”按钮。

- [ ] **Step 6: 验证覆盖层层级**

检查普通弹窗、抽屉、抽屉内回滚确认和高优先级审批弹窗的遮罩层级。产品窗口内容不得穿透遮罩，键盘焦点必须能落到原生控件。

---

### Task 5: 完成 Demo 控制、响应式验证与首轮交付

**Files:**
- Modify: `C:/Users/28109/.codex/visualizations/2026/08/11/019fee7f-5de8-7380-84c2-b1f8f3b76ab7/dreamcode-current-ui.html`
- Create: `$SCREEN_DIR/current-ui-complete.html`

**Interfaces:**
- Consumes: `scenes`、`overlays`、`renderDreamCodeDemo()`。
- Produces: 可交付的第一版忠实复刻视觉伴侣页面。

- [ ] **Step 1: 实现独立 Demo 控制区**

控制区提供场景、覆盖层和抽屉标签选择，并显示当前产品画布尺寸。控制区必须在 `.dc-stage` 外，不使用 DreamCode 产品样式，不进入产品窗口截图范围。

- [ ] **Step 2: 验证全部交互**

通过浏览器依次验证：侧栏会话选择、输入文本、运行模式、模型选择、发送、停止、三个标题栏入口、四个抽屉标签、配置保存、审批允许/拒绝、问题提交和回滚确认。

- [ ] **Step 3: 验证 `1440 × 900`**

在产品画布等效 `1440 × 900` 尺寸截图检查：侧栏 `264px`、标题栏、时间线、悬浮输入框、弹窗居中、抽屉宽度和覆盖层层级。

- [ ] **Step 4: 验证 `1024 × 700`**

在产品画布等效 `1024 × 700` 尺寸检查：侧栏降为当前媒体规则的 `220px`，详情抽屉使用 `min(680px, calc(100% - 220px))`，关键控件无重叠、裁切或不可操作。

- [ ] **Step 5: 做静态完整性检查**

确认 HTML 小于 `1 MB`，不存在 `fetch`、XHR、WebSocket、外部业务 API、未定义标识符、重复根节点 ID、字面量 `\\"` 或字面量 `\\n`。确认每个查询的 DOM 元素存在，主要交互会重新渲染页面。

- [ ] **Step 6: 推送首轮完整版本**

将唯一设计源复制到 `screen_dir/current-ui-complete.html`，提醒用户通过完整视觉伴侣 URL 查看，并请用户指出第一轮需要调整的区域。不得在此阶段修改 Electron/React 桌面端代码。

---

### Task 6: 迭代并沉淀桌面端实现参照

**Files:**
- Modify: `C:/Users/28109/.codex/visualizations/2026/08/11/019fee7f-5de8-7380-84c2-b1f8f3b76ab7/dreamcode-current-ui.html`
- Create: `$SCREEN_DIR/current-ui-v1.html`，后续版本按整数递增
- Future Create after final user approval: `docs/ui/dreamcode-desktop-ui-reference.md`

**Interfaces:**
- Consumes: 用户终端反馈与 `state_dir/events` 点击记录。
- Produces: 经用户确认的最终 HTML 与桌面端 UI 实现参照。

- [ ] **Step 1: 读取每轮反馈**

终端文字是主要反馈；若 `state_dir/events` 存在，同时读取最后选择与点击轨迹。只修改用户指出的区域，并保留其他已确认部分。

- [ ] **Step 2: 每轮生成新视觉版本**

第一次修改复制为 `current-ui-v1.html`，以后依次使用 `current-ui-v2.html`、`current-ui-v3.html`。不得覆盖旧文件。若转回纯文字讨论，第一次使用 `waiting-1.html`，以后按整数递增。

- [ ] **Step 3: 重复尺寸与交互回归**

每轮至少回归受影响状态；涉及公共布局、字体、间距或颜色时，重新检查 `1440 × 900` 和 `1024 × 700`。

- [ ] **Step 4: 等待最终 Demo 确认**

在用户明确表示最终 Demo 已确认之前，不创建桌面端重构提交，不修改 `packages/desktop/src/renderer`。

- [ ] **Step 5: 提炼实现参照**

最终确认后，创建 `docs/ui/dreamcode-desktop-ui-reference.md`，记录确定的色彩、字体、间距、圆角、阴影、组件尺寸、交互状态、时间线规则、弹窗/抽屉行为和两个目标尺寸的响应式规则。
