# DreamCode Desktop UI

DreamCode 桌面端的唯一正式 Renderer 是 React + Vite 实现。

## UI 实现位置

- `src/renderer/app/App.tsx`：应用页面组合、状态连接和主要交互编排。
- `src/renderer/components/*.tsx`：侧栏、任务头部、时间线、输入框、详情抽屉和对话框。
- `src/renderer/app/app.css`：桌面端设计 token、布局、颜色、间距和组件样式。
- `src/renderer/state/desktop-state.ts`：Renderer 状态归约与选择器。
- `src/renderer/main.tsx`：React 根节点入口。
- `index.html`：仅提供 Vite 的 `#root` 挂载点和 CSP，不承载产品 UI。
- `../../docs/component-guidelines.html`：受维护的组件规范与交互展示页，为 React UI 提供设计依据，但不参与运行时构建。

## 架构边界

- 不要创建 `src/renderer.html` 或其他单文件 HTML 产品界面。
- 不要把 UI 结构、交互脚本或产品样式写入 `index.html`。
- UI/UX 变更应直接修改 React 组件和 `app.css`，并同步更新相应的 React Testing Library 测试。
- 组件规范可以使用独立 HTML 展示，但不能代替正式实现；确认后的设计需要落实到 Renderer 组件并通过测试和桌面构建验证。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm desktop:build
```
