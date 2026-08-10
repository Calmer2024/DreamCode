# DreamCode Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, test, and package a Windows x64 Electron desktop application that reproduces the approved Codex desktop layout while reusing DreamCode's existing agent runtime.

**Architecture:** Add an isolated `@dreamcode/desktop` package with an Electron Main process, a context-isolated preload bridge, and a React Renderer. Main owns configuration, sessions, provider construction, active-run lifecycle, approvals, questions, and native dialogs; Renderer consumes a typed IPC API and reduces existing `AgentEvent` values into the approved UI.

**Tech Stack:** TypeScript 5.9, React 19, Electron 43.3, Vite 8.2, Electron Builder 26.15, Lucide React 1.31, Vitest 3.2, React Testing Library 16.3, Playwright 1.62, pnpm workspace.

## Global Constraints

- Target Windows 10/11 x64.
- Preserve the existing CLI and all existing runtime package behavior.
- Expose only capabilities already implemented by DreamCode.
- Match the approved Codex reference layout, spacing, hierarchy, surfaces, timeline, and floating composer while retaining DreamCode branding.
- Use only `lucide-react` for functional icons; prohibit Emoji, Unicode pictograms, icon fonts, and ad hoc glyph icons.
- Use Lucide `Bot` for “模型与配置” and `ShieldCheck` for the run-mode control.
- Keep `contextIsolation: true` and `nodeIntegration: false` for every production BrowserWindow.
- Never return stored API key plaintext to Renderer or include it in logs, snapshots, or errors.
- Permit only one active Turn per application instance.
- Produce both an NSIS per-user installer and a portable Windows x64 executable.

---

## File Structure

Create the following focused units:

```text
packages/desktop/
  package.json                       desktop scripts, dependencies, builder metadata
  tsconfig.json                      package type-check configuration
  tsup.config.ts                     Main and preload bundles
  vite.config.ts                     Renderer build and dev server
  playwright.config.ts               packaged Electron E2E configuration
  electron-builder.yml               NSIS and portable Windows targets
  index.html                         Vite Renderer entry document
  src/shared/contracts.ts            IPC request/response/event schemas and types
  src/main/provider.ts               profile-to-ModelProvider construction
  src/main/run-manager.ts            single active Turn lifecycle
  src/main/app-service.ts            configuration/session/diff/rollback facade
  src/main/ipc.ts                    validated Electron IPC registration
  src/main/window.ts                 secure BrowserWindow creation
  src/main/index.ts                  Electron lifecycle entrypoint
  src/preload/index.ts               narrow contextBridge API
  src/renderer/global.d.ts           typed window.dreamcode declaration
  src/renderer/main.tsx               React root
  src/renderer/app/App.tsx            screen composition and orchestration
  src/renderer/app/app.css            approved Codex-style layout and tokens
  src/renderer/state/desktop-state.ts pure event reducer and selectors
  src/renderer/components/Sidebar.tsx workspace/session navigation
  src/renderer/components/TaskHeader.tsx title and detail controls
  src/renderer/components/Timeline.tsx event timeline and cards
  src/renderer/components/Composer.tsx prompt, mode, model, send/stop
  src/renderer/components/DetailDrawer.tsx diff, terminal, event details
  src/renderer/components/ConfigDialog.tsx provider/profile configuration
  src/renderer/components/ApprovalDialog.tsx permission and question responses
  src/renderer/components/ErrorBoundary.tsx Renderer recovery screen
  src/test/setup.ts                    DOM test setup
  src/**/*.test.ts(x)                 colocated unit/component tests
  e2e/desktop.e2e.ts                  built Electron end-to-end scenarios
  scripts/packaged-chain-test.mjs     isolated packaged-app acceptance runner
```

Modify:

```text
package.json                          root desktop/dev/dist/e2e scripts
tsconfig.json                         @dreamcode/desktop path and project reference
tsconfig.typecheck.json               include TSX sources
vitest.config.ts                      include TSX tests and setup
README.md                             desktop launch, install, and verification guidance
```

---

### Task 1: Desktop Package and Typed IPC Contracts

**Files:**
- Create: `packages/desktop/package.json`
- Create: `packages/desktop/tsconfig.json`
- Create: `packages/desktop/tsup.config.ts`
- Create: `packages/desktop/vite.config.ts`
- Create: `packages/desktop/index.html`
- Create: `packages/desktop/src/shared/contracts.ts`
- Create: `packages/desktop/src/shared/contracts.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `tsconfig.typecheck.json`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `DesktopApi`, `DesktopBootstrap`, `StartTurnRequest`, `SaveProfileRequest`, `DesktopRunEvent`, `ApprovalResponse`, and `QuestionResponse` types.
- Consumes: `AgentEvent`, `RunMode`, `SessionListItem`, `ReplayedSessionState`, and provider preset metadata.

- [ ] **Step 1: Write the failing contract validation test**

```ts
import { describe, expect, it } from "vitest";
import { startTurnRequestSchema } from "./contracts";

describe("desktop IPC contracts", () => {
  it("rejects a start request without a workspace", () => {
    expect(() =>
      startTurnRequestSchema.parse({ prompt: "Fix tests", workspaceRoot: "", mode: "yolo" }),
    ).toThrow();
  });

  it("accepts the four existing run modes", () => {
    for (const mode of ["plan", "guided", "yolo", "full"] as const) {
      expect(startTurnRequestSchema.parse({ prompt: "Fix tests", workspaceRoot: "D:/repo", mode }).mode).toBe(mode);
    }
  });
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm vitest run packages/desktop/src/shared/contracts.test.ts`

Expected: FAIL because `contracts.ts` and `startTurnRequestSchema` do not exist.

- [ ] **Step 3: Add the desktop package configuration and minimal schemas**

Use exact runtime versions resolved on 2026-08-10: `electron@43.3.0`, `electron-builder@26.15.3`, `vite@8.2.1`, `@vitejs/plugin-react@6.0.5`, `lucide-react@1.31.0`, `@testing-library/react@16.3.2`, `@playwright/test@1.62.1`, plus React 19.2.7, `react-dom@19.2.7`, `zod@3.25.76`, `jsdom`, and `@testing-library/jest-dom`.

```ts
import type { AgentEvent, RunMode } from "@dreamcode/shared";
import type { ReplayedSessionState, SessionListItem } from "@dreamcode/store";
import { z } from "zod";

export const startTurnRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  workspaceRoot: z.string().trim().min(1),
  mode: z.enum(["plan", "guided", "yolo", "full"]),
  profileName: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
});

export type StartTurnRequest = z.infer<typeof startTurnRequestSchema>;
export interface DesktopRunEvent { runId: string; event: AgentEvent }
export interface DesktopError { code: string; message: string; recoverable: boolean }
export interface DesktopApprovalRequest { runId: string; requestId: string; tool: string; input: unknown; reason: string }
export interface DesktopQuestionRequest { runId: string; requestId: string; question: string }
export interface DesktopRunStatus { runId: string; status: "running" | "completed" | "failed" | "interrupted"; error?: DesktopError }
export interface SaveProfileRequest {
  name: string;
  provider: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}
export interface ApprovalResponse { runId: string; requestId: string; approved: boolean }
export interface QuestionResponse { runId: string; requestId: string; answer: string }
export interface RollbackRequest { sessionId: string; filePath: string }
export interface DesktopBootstrap {
  profiles: Array<{ name: string; provider: string; model?: string; baseURL?: string; apiKeyConfigured: boolean }>;
  currentProfile?: string;
  presets: Array<{ id: string; displayName: string; defaultModel: string; models?: ReadonlyArray<{ id: string; label?: string }> }>;
  sessions: SessionListItem[];
}
export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  chooseWorkspace(): Promise<string | undefined>;
  saveProfile(request: SaveProfileRequest): Promise<DesktopBootstrap>;
  startTurn(request: StartTurnRequest): Promise<{ runId: string }>;
  stopTurn(runId: string): Promise<void>;
  readSession(sessionId: string): Promise<ReplayedSessionState>;
  readDiff(request: RollbackRequest): Promise<string>;
  rollback(request: RollbackRequest): Promise<{ rolledBackFiles: string[]; failedFiles: Array<{ path: string; reason: string }> }>;
  respondApproval(response: ApprovalResponse): Promise<void>;
  respondQuestion(response: QuestionResponse): Promise<void>;
  onRunEvent(listener: (message: DesktopRunEvent) => void): () => void;
  onApprovalRequest(listener: (request: DesktopApprovalRequest) => void): () => void;
  onQuestionRequest(listener: (request: DesktopQuestionRequest) => void): () => void;
  onRunStatus(listener: (status: DesktopRunStatus) => void): () => void;
}
```

- [ ] **Step 4: Run contract and repository type tests**

Run: `pnpm vitest run packages/desktop/src/shared/contracts.test.ts && pnpm typecheck`

Expected: contract tests PASS and TypeScript reports zero errors.

- [ ] **Step 5: Commit**

```powershell
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.typecheck.json vitest.config.ts packages/desktop
git commit -m "feat(desktop): scaffold typed desktop package"
```

---

### Task 2: Provider Resolution and Secret-Redacted Configuration Service

**Files:**
- Create: `packages/desktop/src/main/provider.ts`
- Create: `packages/desktop/src/main/provider.test.ts`
- Create: `packages/desktop/src/main/app-service.ts`
- Create: `packages/desktop/src/main/app-service.test.ts`

**Interfaces:**
- Consumes: `DreamCodeConfig`, `DreamCodeLlmProfile`, `loadDreamCodeConfig`, `saveDreamCodeConfig`, `upsertLlmProfile`, `listSessions`, `readReplayedSession`, `rollbackSession`, model preset APIs.
- Produces: `createDesktopProvider(prompt, profile)`, `redactProfiles(config)`, and `DesktopAppService` methods `bootstrap`, `saveProfile`, `listSessions`, `readSession`, `rollback`, and `readChangedFileDiff`.

- [ ] **Step 1: Write failing redaction and Fake Provider tests**

```ts
it("never returns persisted API key plaintext", async () => {
  await saveDreamCodeConfig(upsertLlmProfile(emptyConfig(), "deepseek", {
    provider: "deepseek", model: "deepseek-v4-pro", apiKey: "secret-value",
  }), home);
  const bootstrap = await service.bootstrap();
  expect(JSON.stringify(bootstrap)).not.toContain("secret-value");
  expect(bootstrap.profiles[0]?.apiKeyConfigured).toBe(true);
});

it("constructs the deterministic Fake Provider without an API key", () => {
  const result = createDesktopProvider("Fix tests", { provider: "fake" });
  expect(result.provider.name).toBe("fake");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run packages/desktop/src/main/provider.test.ts packages/desktop/src/main/app-service.test.ts`

Expected: FAIL because the desktop provider and service do not exist.

- [ ] **Step 3: Implement provider construction and redacted bootstrap**

```ts
export function createDesktopProvider(prompt: string, profile: DreamCodeLlmProfile) {
  if (profile.provider === "fake") {
    return { provider: createDefaultFakeProvider(prompt), model: profile.model };
  }
  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv]?.trim() || profile.apiKey : profile.apiKey;
  const resolved = resolveModelProviderConfig({
    provider: profile.provider,
    apiKey,
    baseURL: profile.baseURL,
    model: profile.model,
  });
  return { provider: createModelProvider(resolved), model: resolved.model };
}

export function redactProfiles(config: DreamCodeConfig): DesktopBootstrap["profiles"] {
  return Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    provider: profile.provider,
    model: profile.model,
    baseURL: profile.baseURL,
    apiKeyConfigured: Boolean(profile.apiKey || (profile.apiKeyEnv && process.env[profile.apiKeyEnv])),
  }));
}
```

Implement `DesktopAppService` with constructor injection for `home` so every test uses a temporary directory. `readChangedFileDiff(sessionId, filePath)` must find the exact path in `readReplayedSession(...).changedFiles` and return its stored `diff`; it must not read arbitrary filesystem paths.

- [ ] **Step 4: Verify service tests and the existing Store tests**

Run: `pnpm vitest run packages/desktop/src/main packages/store/src/config.test.ts`

Expected: all selected tests PASS; serialized bootstrap contains no stored secret.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/main/provider.ts packages/desktop/src/main/provider.test.ts packages/desktop/src/main/app-service.ts packages/desktop/src/main/app-service.test.ts
git commit -m "feat(desktop): add redacted desktop application service"
```

---

### Task 3: Single-Run Manager, Streaming Events, Approval, Questions, and Stop

**Files:**
- Create: `packages/desktop/src/main/run-manager.ts`
- Create: `packages/desktop/src/main/run-manager.test.ts`

**Interfaces:**
- Consumes: `runTurn`, `createDesktopProvider`, `createDefaultToolRegistry`, and `StartTurnRequest`.
- Produces: `DesktopRunManager.start(request)`, `stop(runId)`, `respondApproval(response)`, `respondQuestion(response)`, `dispose()`, plus `emitEvent`, `emitApproval`, `emitQuestion`, and `emitStatus` callbacks.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it("streams a complete Fake Provider Turn and releases the active run", async () => {
  const events: DesktopRunEvent[] = [];
  const manager = createManager({ home, emit: (event) => events.push(event) });
  const { runId, completion } = await manager.start({
    prompt: "Update README", workspaceRoot, profileName: "fake", mode: "yolo",
  });
  await completion;
  expect(events.every((item) => item.runId === runId)).toBe(true);
  expect(events.some((item) => item.event.type === "turn.completed")).toBe(true);
  expect(manager.activeRunId).toBeUndefined();
});

it("rejects a second active Turn", async () => {
  const manager = createBlockingManager();
  await manager.start(validRequest);
  await expect(manager.start(validRequest)).rejects.toMatchObject({ code: "run_already_active" });
});

it("aborts only the matching run id", async () => {
  const manager = createBlockingManager();
  const { runId, completion } = await manager.start(validRequest);
  await expect(manager.stop("stale-run")).rejects.toMatchObject({ code: "stale_run" });
  await manager.stop(runId);
  await completion;
  expect(receivedTypes).toContain("turn.interrupted");
});
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `pnpm vitest run packages/desktop/src/main/run-manager.test.ts`

Expected: FAIL because `DesktopRunManager` does not exist.

- [ ] **Step 3: Implement the minimal state machine**

```ts
interface ActiveRun {
  runId: string;
  abortController: AbortController;
  approvals: Map<string, Deferred<boolean>>;
  questions: Map<string, Deferred<string>>;
  completion: Promise<void>;
}

export class DesktopRunManager {
  #active?: ActiveRun;
  get activeRunId() { return this.#active?.runId; }

  async stop(runId: string): Promise<void> {
    if (!this.#active || this.#active.runId !== runId) throw desktopError("stale_run", "Run is no longer active.");
    this.#active.abortController.abort("Stopped by user.");
  }
}
```

Approval and question request IDs must be created independently from `toolCall.id`, emitted to Renderer, and resolved only when both `runId` and request ID match. `finally` must reject unresolved deferred requests, clear the active run, and emit a final run-status message.

- [ ] **Step 4: Verify manager and existing core interruption tests**

Run: `pnpm vitest run packages/desktop/src/main/run-manager.test.ts packages/core/src/core.test.ts`

Expected: all selected tests PASS, including interruption persistence.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/main/run-manager.ts packages/desktop/src/main/run-manager.test.ts
git commit -m "feat(desktop): stream agent runs through desktop manager"
```

---

### Task 4: Secure IPC Registration and Preload Bridge

**Files:**
- Create: `packages/desktop/src/main/ipc.ts`
- Create: `packages/desktop/src/main/ipc.test.ts`
- Create: `packages/desktop/src/preload/index.ts`
- Create: `packages/desktop/src/renderer/global.d.ts`

**Interfaces:**
- Consumes: `DesktopAppService`, `DesktopRunManager`, contract schemas, Electron `ipcMain`, `ipcRenderer`, and `contextBridge`.
- Produces: allowlisted `window.dreamcode` implementing `DesktopApi`.

- [ ] **Step 1: Write a failing test for channel allowlisting and cleanup**

```ts
it("registers only declared channels and removes handlers during disposal", () => {
  const dispose = registerDesktopIpc({ ipcMain, dialog, service, runManager, getWindow });
  expect(ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual([
    "desktop:bootstrap", "desktop:choose-workspace", "desktop:save-profile",
    "desktop:read-session", "desktop:read-diff", "desktop:rollback",
    "desktop:start-turn", "desktop:stop-turn", "desktop:approval-response",
    "desktop:question-response",
  ]);
  dispose();
  expect(ipcMain.removeHandler).toHaveBeenCalledTimes(10);
});
```

- [ ] **Step 2: Run IPC test and verify RED**

Run: `pnpm vitest run packages/desktop/src/main/ipc.test.ts`

Expected: FAIL because IPC registration is missing.

- [ ] **Step 3: Implement validated handlers and narrow preload API**

```ts
contextBridge.exposeInMainWorld("dreamcode", {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  startTurn: (request) => ipcRenderer.invoke("desktop:start-turn", request),
  stopTurn: (runId) => ipcRenderer.invoke("desktop:stop-turn", runId),
  onRunEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: DesktopRunEvent) => listener(message);
    ipcRenderer.on("desktop:run-event", wrapped);
    return () => ipcRenderer.removeListener("desktop:run-event", wrapped);
  },
} satisfies DesktopApi);
```

Implement the `DesktopApi` interface from Task 1 exactly. Validate every object request through its Zod schema before calling a service. Convert thrown values into `{ code, message, recoverable }` and never include stack traces.

- [ ] **Step 4: Run IPC and contract tests**

Run: `pnpm vitest run packages/desktop/src/main/ipc.test.ts packages/desktop/src/shared/contracts.test.ts`

Expected: all selected tests PASS and the preload contains no generic `invoke(channel)` or `on(channel)` escape hatch.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/main/ipc.ts packages/desktop/src/main/ipc.test.ts packages/desktop/src/preload/index.ts packages/desktop/src/renderer/global.d.ts
git commit -m "feat(desktop): expose secure typed Electron IPC"
```

---

### Task 5: Pure Renderer State and Agent Event Mapping

**Files:**
- Create: `packages/desktop/src/renderer/state/desktop-state.ts`
- Create: `packages/desktop/src/renderer/state/desktop-state.test.ts`

**Interfaces:**
- Consumes: `DesktopBootstrap`, `DesktopRunEvent`, `AgentEvent`, `ReplayedSessionState`.
- Produces: `DesktopState`, `desktopReducer(state, action)`, `selectWorkspaceGroups`, `selectTimeline`, `selectActiveChangedFile`, and `selectTerminalEntries`.

- [ ] **Step 1: Write failing reducer tests**

```ts
it("maps streamed events to the active timeline without losing raw evidence", () => {
  let state = createDesktopState(bootstrap);
  state = desktopReducer(state, { type: "run.started", runId: "run_1", request });
  state = desktopReducer(state, { type: "run.event", message: { runId: "run_1", event: toolStarted } });
  state = desktopReducer(state, { type: "run.event", message: { runId: "run_1", event: fileChanged } });
  expect(selectTimeline(state).some((entry) => entry.kind === "tool")).toBe(true);
  expect(state.rawEvents).toEqual([toolStarted, fileChanged]);
  expect(state.changedFiles[0]?.path).toBe("src/math.js");
});

it("ignores events from a stale run", () => {
  const state = desktopReducer(runningState("run_2"), {
    type: "run.event", message: { runId: "run_1", event: modelDelta },
  });
  expect(state.rawEvents).toHaveLength(0);
});
```

- [ ] **Step 2: Run reducer tests and verify RED**

Run: `pnpm vitest run packages/desktop/src/renderer/state/desktop-state.test.ts`

Expected: FAIL because the desktop reducer does not exist.

- [ ] **Step 3: Implement the reducer and selectors**

Use discriminated actions for bootstrap, workspace selection, session loading, run start, run event, run status, drawer selection, dialog state, and recoverable error. Preserve all raw events while deriving compact timeline items. Reuse concepts from `packages/cli/src/tui-state.ts`, but do not import CLI/Ink code into desktop.

```ts
export function desktopReducer(state: DesktopState, action: DesktopAction): DesktopState {
  if (action.type === "run.event" && action.message.runId !== state.activeRunId) return state;
  switch (action.type) {
    case "run.event": return reduceAgentEvent(state, action.message.event);
    case "drawer.open": return { ...state, drawer: action.drawer };
    case "error": return { ...state, error: action.error };
    default: return reduceNonEventAction(state, action);
  }
}
```

- [ ] **Step 4: Run reducer tests and CLI reducer regression tests**

Run: `pnpm vitest run packages/desktop/src/renderer/state/desktop-state.test.ts packages/cli/src/tui-state.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/renderer/state
git commit -m "feat(desktop): reduce agent events into desktop state"
```

---

### Task 6: Codex-Style Application Shell and Timeline

**Files:**
- Create: `packages/desktop/src/renderer/main.tsx`
- Create: `packages/desktop/src/renderer/app/App.tsx`
- Create: `packages/desktop/src/renderer/app/App.test.tsx`
- Create: `packages/desktop/src/renderer/app/app.css`
- Create: `packages/desktop/src/renderer/components/Sidebar.tsx`
- Create: `packages/desktop/src/renderer/components/TaskHeader.tsx`
- Create: `packages/desktop/src/renderer/components/Timeline.tsx`
- Create: `packages/desktop/src/renderer/components/Composer.tsx`
- Create: `packages/desktop/src/renderer/components/ErrorBoundary.tsx`
- Create: `packages/desktop/src/test/setup.ts`

**Interfaces:**
- Consumes: `window.dreamcode`, desktop reducer/selectors, and Lucide icons.
- Produces: the default app shell, streaming timeline, model/mode controls, send/stop behavior, empty/configuration states, and recovery screen.

- [ ] **Step 1: Write failing component behavior tests**

```tsx
it("renders only supported navigation and semantic icons", async () => {
  render(<App api={fakeDesktopApi({ bootstrap })} />);
  expect(await screen.findByText("新对话")).toBeVisible();
  expect(screen.getByText("会话历史")).toBeVisible();
  expect(screen.getByText("模型与配置")).toBeVisible();
  expect(screen.queryByText("拉取请求")).not.toBeInTheDocument();
  expect(screen.getByTestId("model-config-icon")).toHaveAttribute("data-lucide", "bot");
  expect(screen.getByTestId("run-mode-icon")).toHaveAttribute("data-lucide", "shield-check");
});

it("switches send to stop while a run is active", async () => {
  const api = fakeDesktopApi({ bootstrap, startTurn: vi.fn().mockResolvedValue({ runId: "run_1" }) });
  render(<App api={api} />);
  await user.type(screen.getByRole("textbox"), "Fix tests");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("button", { name: "停止" })).toBeVisible();
});
```

- [ ] **Step 2: Run component tests and verify RED**

Run: `pnpm vitest run packages/desktop/src/renderer/app/App.test.tsx`

Expected: FAIL because the React shell does not exist.

- [ ] **Step 3: Implement the minimal interactive shell**

Build components from reducer selectors and use Lucide `SquarePen`, `History`, `Bot`, `Settings`, `Folder`, `Search`, `Bell`, `MoreHorizontal`, `List`, `TerminalSquare`, `PanelRight`, `Plus`, `ShieldCheck`, `ChevronDown`, `Send`, and `Square` icons. No functional icon may be represented by text.

Do not render the attachment `Plus` action in this release because the existing runtime has no attachment input contract. Keep the composer limited to prompt, mode, model, send, and stop controls.

Define exact CSS tokens and layout:

```css
:root {
  color: #242424; background: #fff; font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
  --dc-brand: #a855f7; --dc-brand-dark: #7c3aed; --dc-sidebar: #f4f4f4;
  --dc-border: #dedede; --dc-muted: #777; --dc-warning: #d65a2f;
}
.app-shell { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100vh; }
.conversation { max-width: 760px; margin: 0 auto; padding: 64px 28px 150px; }
.composer { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%);
  width: min(760px, calc(100% - 48px)); border: 1px solid var(--dc-border);
  border-radius: 18px; background: #fff; box-shadow: 0 9px 30px rgb(0 0 0 / 10%); }
@media (max-width: 1100px) { .app-shell { grid-template-columns: 220px minmax(0, 1fr); } }
```

Use accessible labels, keyboard submission with Ctrl+Enter, focus-visible states, and `aria-live="polite"` for run status. Disable submission when workspace/profile/prompt is invalid.

- [ ] **Step 4: Verify component tests and Renderer production build**

Run: `pnpm vitest run packages/desktop/src/renderer && pnpm --filter @dreamcode/desktop build:renderer`

Expected: component tests PASS and Vite exits 0 with built Renderer assets.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/renderer packages/desktop/src/test packages/desktop/index.html packages/desktop/vite.config.ts
git commit -m "feat(desktop): build Codex-style DreamCode shell"
```

---

### Task 7: Configuration, Approval, Session, Diff, Terminal, and Rollback UI

**Files:**
- Create: `packages/desktop/src/renderer/components/ConfigDialog.tsx`
- Create: `packages/desktop/src/renderer/components/ConfigDialog.test.tsx`
- Create: `packages/desktop/src/renderer/components/ApprovalDialog.tsx`
- Create: `packages/desktop/src/renderer/components/ApprovalDialog.test.tsx`
- Create: `packages/desktop/src/renderer/components/DetailDrawer.tsx`
- Create: `packages/desktop/src/renderer/components/DetailDrawer.test.tsx`
- Modify: `packages/desktop/src/renderer/app/App.tsx`
- Modify: `packages/desktop/src/renderer/app/App.test.tsx`

**Interfaces:**
- Consumes: profile presets, redacted profiles, pending approvals/questions, replayed sessions, changed-file Diffs, and command summaries.
- Produces: complete UI access to every in-scope existing feature.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it("saves a profile without rendering an existing secret", async () => {
  render(<ConfigDialog api={api} bootstrap={bootstrapWithConfiguredSecret} open onClose={vi.fn()} />);
  expect(screen.queryByDisplayValue("secret-value")).not.toBeInTheDocument();
  expect(screen.getByText("API Key 已配置")).toBeVisible();
  await user.type(screen.getByLabelText("新的 API Key"), "replacement-key");
  await user.click(screen.getByRole("button", { name: "保存配置" }));
  expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "replacement-key" }));
});

it("requires explicit confirmation before rollback", async () => {
  render(<DetailDrawer api={api} session={session} changedFile={changedFile} />);
  await user.click(screen.getByRole("button", { name: "回滚文件" }));
  expect(api.rollback).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认回滚" }));
  expect(api.rollback).toHaveBeenCalledWith({ sessionId: session.id, filePath: changedFile.path });
});
```

- [ ] **Step 2: Run interaction tests and verify RED**

Run: `pnpm vitest run packages/desktop/src/renderer/components`

Expected: FAIL because the dialogs and drawer do not exist.

- [ ] **Step 3: Implement all in-scope dialogs and drawer tabs**

`ConfigDialog` lists `listModelProviderPresets()`, supports existing model IDs and custom model text, shows the plaintext-storage warning, and never pre-fills stored keys. `ApprovalDialog` renders tool name, normalized input, policy reason, and Allow/Deny actions. Question UI returns a non-empty text response. `DetailDrawer` has Diff, terminal, event, and session tabs and limits visible output to 200 KB.

Use a modal confirmation with exact file path before rollback. After rollback, reload the session and display success/failure evidence.

- [ ] **Step 4: Run all Renderer tests**

Run: `pnpm vitest run packages/desktop/src/renderer`

Expected: all Renderer tests PASS with no API keys present in DOM snapshots or error output.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/renderer
git commit -m "feat(desktop): add configuration and review workflows"
```

---

### Task 8: Secure Electron Window and Application Lifecycle

**Files:**
- Create: `packages/desktop/src/main/window.ts`
- Create: `packages/desktop/src/main/window.test.ts`
- Create: `packages/desktop/src/main/index.ts`
- Create: `packages/desktop/src/main/lifecycle.test.ts`

**Interfaces:**
- Consumes: built preload/Renderer paths, IPC registration, `DesktopRunManager`.
- Produces: secure main window, dev-server loading, packaged asset loading, close confirmation, Renderer recovery, and app lifecycle.

- [ ] **Step 1: Write failing BrowserWindow security test**

```ts
it("creates a context-isolated window without Node integration", () => {
  createMainWindow({ BrowserWindow: FakeBrowserWindow, preloadPath, rendererUrl });
  expect(FakeBrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
    minWidth: 1024,
    minHeight: 700,
    webPreferences: expect.objectContaining({
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    }),
  }));
});
```

- [ ] **Step 2: Run window test and verify RED**

Run: `pnpm vitest run packages/desktop/src/main/window.test.ts packages/desktop/src/main/lifecycle.test.ts`

Expected: FAIL because window and lifecycle modules do not exist.

- [ ] **Step 3: Implement window creation and lifecycle**

```ts
const win = new BrowserWindow({
  width: 1440, height: 900, minWidth: 1024, minHeight: 700,
  backgroundColor: "#ffffff", show: false,
  webPreferences: { preload: input.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
});
win.once("ready-to-show", () => win.show());
```

Use `VITE_DEV_SERVER_URL` only in development and `loadFile(rendererIndexPath)` when packaged. Intercept `will-navigate` and `setWindowOpenHandler`; deny navigation and allow only validated `http:`/`https:` URLs through `shell.openExternal`. Before close, if a run is active, show a native confirmation; on confirmation call `runManager.stop`, wait for completion, then destroy the window.

- [ ] **Step 4: Verify Main tests and build bundles**

Run: `pnpm vitest run packages/desktop/src/main && pnpm --filter @dreamcode/desktop build:main`

Expected: Main tests PASS and tsup emits Main and preload bundles without warnings.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/main packages/desktop/tsup.config.ts
git commit -m "feat(desktop): add secure Electron lifecycle"
```

---

### Task 9: Electron End-to-End Tests

**Files:**
- Create: `packages/desktop/playwright.config.ts`
- Create: `packages/desktop/e2e/desktop.e2e.ts`
- Create: `packages/desktop/e2e/fixtures.ts`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Consumes: built Electron Main/Renderer, isolated `DREAMCODE_HOME`, copied eval fixtures.
- Produces: deterministic UI-level evidence for startup, full Fake task, Diff, approval, stop, restart, and resume.

- [ ] **Step 1: Write the failing Electron smoke test**

```ts
test("launches the built desktop app with supported navigation", async () => {
  const app = await electron.launch({
    args: [desktopMainPath],
    env: { ...process.env, DREAMCODE_HOME: testHome, DREAMCODE_E2E: "1" },
  });
  const page = await app.firstWindow();
  await expect(page.getByText("DreamCode")).toBeVisible();
  await expect(page.getByText("新对话")).toBeVisible();
  await expect(page.getByText("拉取请求")).toHaveCount(0);
  await app.close();
});
```

- [ ] **Step 2: Run E2E and verify RED**

Run: `pnpm --filter @dreamcode/desktop e2e`

Expected: FAIL because the built Electron test entry or E2E support is not complete.

- [ ] **Step 3: Complete deterministic E2E scenarios**

Add scenarios that select a copied fixture workspace, save/select Fake Provider, submit the existing failing-test prompt, wait for `turn.completed`, assert the file change and Diff, exercise an approval allow and deny test provider, stop a blocking provider, close/relaunch with the same temporary home, open the Session, and continue it.

Expose deterministic Fake/E2E provider variants only when `DREAMCODE_E2E=1`; production UI must still show only the normal Fake Provider entry.

- [ ] **Step 4: Run all Electron E2E tests twice**

Run: `pnpm --filter @dreamcode/desktop build && pnpm --filter @dreamcode/desktop e2e && pnpm --filter @dreamcode/desktop e2e`

Expected: both E2E runs PASS, demonstrating isolation and restart reliability.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/e2e packages/desktop/playwright.config.ts packages/desktop/package.json
git commit -m "test(desktop): cover Electron task workflows"
```

---

### Task 10: Windows Packaging and Packaged Chain Test

**Files:**
- Create: `packages/desktop/electron-builder.yml`
- Create: `packages/desktop/scripts/packaged-chain-test.mjs`
- Create: `packages/desktop/scripts/write-checksums.mjs`
- Modify: `packages/desktop/package.json`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: production desktop build, eval fixtures, isolated temp home.
- Produces: `release/DreamCode-Setup-0.1.0-x64.exe`, `release/DreamCode-Portable-0.1.0-x64.exe`, `release/SHA256SUMS.txt`, and `release/chain-test-report.json`.

- [ ] **Step 1: Add packaging configuration and run a failing package command**

```yaml
appId: com.dreamcode.desktop
productName: DreamCode
directories:
  output: release
files:
  - dist-main/**
  - dist-renderer/**
asar: true
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  deleteAppDataOnUninstall: false
  artifactName: "DreamCode-Setup-${version}-${arch}.${ext}"
portable:
  artifactName: "DreamCode-Portable-${version}-${arch}.${ext}"
```

Run: `pnpm desktop:dist`

Expected: initial FAIL until desktop build paths, metadata, and required assets are complete.

- [ ] **Step 2: Complete package scripts and README guidance**

Root scripts must include:

```json
{
  "desktop:dev": "pnpm --filter @dreamcode/desktop dev",
  "desktop:build": "pnpm --filter @dreamcode/desktop build",
  "desktop:e2e": "pnpm --filter @dreamcode/desktop e2e",
  "desktop:dist": "pnpm --filter @dreamcode/desktop dist"
}
```

README must document development launch, Fake Provider acceptance, NSIS installation, portable launch, output paths, config location, plaintext API-key warning, and uninstall data retention.

- [ ] **Step 3: Implement packaged chain-test assertions**

The script must create a temporary DreamCode home and fixture copy, call Playwright Electron with `electron.launch({ executablePath: portableExe, env: { ...process.env, DREAMCODE_HOME: testHome, DREAMCODE_E2E: "1" } })`, drive the same task, verify the fixture file changed, verify command exit code `0`, close, relaunch, resume the Session, and write a JSON report containing timestamps, executable SHA-256, assertions, and pass/fail status.

`write-checksums.mjs` must hash both `.exe` files using Node `createHash("sha256")` and write two deterministic lines to `release/SHA256SUMS.txt`.

- [ ] **Step 4: Run complete verification and package**

Run in this exact order:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm desktop:e2e
pnpm desktop:dist
pnpm --filter @dreamcode/desktop chain-test
pnpm --filter @dreamcode/desktop checksums
```

Expected: every command exits `0`; Vitest and Playwright report zero failures; both x64 executables, chain-test report, and checksum file exist under `packages/desktop/release`.

- [ ] **Step 5: Inspect deliverables and verify signatures/checksums**

Run:

```powershell
Get-ChildItem packages\desktop\release\*.exe | Select-Object Name,Length,LastWriteTime
Get-Content packages\desktop\release\SHA256SUMS.txt
Get-Content packages\desktop\release\chain-test-report.json
Get-FileHash packages\desktop\release\*.exe -Algorithm SHA256
```

Expected: two non-empty executables; reported hashes match `Get-FileHash`; chain report has `"status": "passed"` and all required assertions are true.

- [ ] **Step 6: Commit**

```powershell
git add package.json pnpm-lock.yaml packages/desktop/electron-builder.yml packages/desktop/scripts README.md
git commit -m "build(desktop): package verified Windows executables"
```

---

## Plan Self-Review Checklist

- Every approved specification section maps to at least one task.
- The Renderer never imports Electron Main or runtime filesystem APIs.
- Secret redaction is tested before configuration UI implementation.
- Active-run and stale-response behavior is tested before IPC/UI integration.
- Existing CLI and core regression tests remain in the verification commands.
- All icon requirements map to explicit Lucide components.
- Installer, portable executable, chain report, and checksums have exact output contracts.
