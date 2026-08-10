# DreamCode Desktop Design Specification

**Date:** 2026-08-10

**Status:** Approved

**Target:** Windows 10/11 x64 desktop application

## 1. Objective

Turn the existing DreamCode CLI agent into an immediately usable Windows desktop product without replacing or expanding the existing agent runtime. The desktop application must reproduce the current Codex desktop application's primary layout and interaction model while retaining DreamCode branding and exposing only capabilities that DreamCode already implements.

The deliverables are:

- A production Electron desktop application.
- A Windows x64 NSIS installer executable.
- A Windows x64 portable executable for acceptance testing.
- Automated unit, integration, and Electron end-to-end tests.
- A packaged-application chain test report and SHA-256 checksums.

## 2. Scope

### 2.1 Included capabilities

The desktop UI must expose the existing DreamCode capabilities:

- Create a new agent session.
- Select a workspace directory.
- Submit prompts and continue the active session.
- Select and persist an existing model provider/profile.
- Select `plan`, `guided`, `yolo`, or `full` execution mode.
- Stream model output and Agent events.
- Display tool calls, tool results, Todo items, commands, file changes, warnings, and final summaries.
- Allow or deny permission requests.
- Answer `question.ask` prompts.
- Stop an active Turn.
- List, open, resume, and inspect historical sessions.
- Display session file diffs.
- Invoke the existing rollback operation after explicit confirmation.
- Display existing MCP and Skill information where supported by current runtime APIs.

### 2.2 Excluded capabilities

The desktop application must not add Codex-only product capabilities that DreamCode does not currently implement. The first desktop release therefore excludes cloud accounts, pull request management, hosted sites, schedules/automations, plugins marketplace, remote environments, parallel agent execution, voice input, and cloud synchronization.

Codex labels for excluded capabilities must not appear as inactive or misleading navigation items.

### 2.3 Meaning of “1:1 Codex UI”

“1:1” applies to the primary desktop layout, spatial proportions, visual hierarchy, surfaces, spacing, border treatment, scroll behavior, timeline composition, floating composer, and interaction patterns shown in the approved Codex reference screenshot. It does not require use of the Codex name, OpenAI branding, unavailable Codex functionality, or copied proprietary assets.

## 3. Product and Visual Design

### 3.1 Window structure

The default light theme uses the following structure:

1. Native Windows window chrome and application menu.
2. A fixed left sidebar for DreamCode identity, primary navigation, workspace groups, and session history.
3. A task header containing the workspace icon, task title, overflow menu, model/runtime control, event list button, terminal button, and detail-panel button.
4. A centered conversation timeline with wide horizontal whitespace matching the approved Codex reference.
5. A floating prompt composer anchored near the bottom of the main content area.
6. An optional right-side drawer for file Diff, command output, event details, or session metadata. It is closed by default and never permanently reduces the main conversation area.

The application must remain usable at a minimum window size of 1024 by 700 CSS pixels. At narrower sizes, the sidebar may collapse and the right drawer must overlay the timeline.

### 3.2 Sidebar information architecture

The sidebar contains only:

- New conversation.
- Session history.
- Model and configuration.
- Settings.
- Workspace folders, each containing its DreamCode sessions.
- A local user/application footer and help entry.

The selected session uses a subtle neutral background and a DreamCode purple leading indicator. Session titles come from the existing session index.

### 3.3 Timeline presentation

Existing `AgentEvent` values map to visual timeline entries:

- `user.message` becomes a right-aligned neutral message bubble.
- Model text becomes the primary assistant response.
- Model/tool lifecycle events become compact progress sections and expandable tool cards.
- `permission.decided` is associated with the corresponding tool card.
- `file.changed` becomes a file-change card with additions/deletions and a Diff action.
- `todo.updated` becomes a progress checklist.
- Shell results display command, exit code, duration where available, and expandable output.
- Completion/failure/interruption events become a final summary or actionable error card.

The UI may combine adjacent low-level events into a single readable card, but it must not discard the underlying event data required by the detail panel.

### 3.4 Prompt composer

The floating composer contains:

- A multiline prompt field.
- An attachment affordance reserved for selecting a workspace-relevant path; it must be hidden if no existing runtime path input can safely consume it.
- A run-mode control.
- A model/profile control.
- A send button while idle.
- A stop button while a Turn is running.

The composer is disabled until a valid workspace and provider configuration exist. The empty state links directly to the missing configuration action.

### 3.5 Color and icon system

The visual base matches the approved light Codex reference: white content surface, light neutral sidebar, low-contrast borders, dark primary text, muted secondary text, and restrained shadows.

DreamCode brand tokens remain:

- Brand: `#a855f7`.
- Brand light: `#c084fc`.
- Brand dark: `#7c3aed`.
- Success: `#6ee7b7` or an accessible darker foreground equivalent on light surfaces.
- Warning/high-permission: orange.
- Danger: `#f472b6` or an accessible darker foreground equivalent on light surfaces.

All functional icons must come from `lucide-react`. Emoji, Unicode pictograms, ad hoc text glyphs, and icon fonts are prohibited in product UI. Default icons use 16–18 pixel dimensions, 1.75–2 pixel stroke width, and consistent optical alignment.

The “Model and configuration” entry uses Lucide `Bot`. The run-mode control uses Lucide `ShieldCheck`; `yolo` and `full` use an orange foreground to communicate elevated execution authority.

## 4. Architecture

### 4.1 Package structure

Add `packages/desktop` to the existing pnpm workspace. It contains three isolated units:

- Electron Main: application lifecycle, BrowserWindow creation, native dialogs, configuration/session access, agent execution, and packaging entrypoint.
- Preload bridge: the only API exposed to the Renderer, with context isolation enabled.
- React Renderer: screens, components, reducer-based state, routing, and visual presentation.

The existing `packages/core`, `packages/models`, `packages/tools`, `packages/store`, `packages/safety`, `packages/context`, and `packages/shared` remain the runtime source of truth. The CLI remains supported and continues to use the same runtime.

### 4.2 Electron security boundary

Every production BrowserWindow must use:

- `contextIsolation: true`.
- `nodeIntegration: false`.
- A fixed preload script.
- No unrestricted IPC passthrough.
- No Renderer access to Node.js, the shell, environment variables, or arbitrary file paths.

The preload bridge exposes a typed, allowlisted DreamCode API. Main validates every request at the IPC boundary. External links open through the operating system only after validating the URL protocol.

### 4.3 Desktop application service

Electron Main owns a desktop application service that:

- Loads and saves DreamCode configuration.
- Returns redacted provider profiles to the Renderer.
- Lists and reads sessions.
- Starts, resumes, stops, and tracks a Turn.
- Converts `runTurn()` output to serializable desktop events.
- Resolves approval and question Promises from Renderer responses.
- Reads safe session artifacts and diffs through existing Store APIs.
- Performs rollback through the existing rollback API after UI confirmation.

This service is independent of BrowserWindow so it can be integration-tested without rendering the full UI.

### 4.4 IPC contract

IPC uses two patterns:

- Request/response for configuration, native folder selection, session queries, diff reads, rollback, start, stop, approval responses, and question responses.
- Subscription events for agent event streaming, run status, and recoverable desktop errors.

Every active run receives a unique `runId`. Renderer responses must include the matching `runId` and request identifier. Responses for stale or completed runs are rejected.

## 5. Runtime Data Flow

1. Electron Main starts and reads the local configuration and session index.
2. Renderer requests a redacted bootstrap snapshot containing settings, profiles, workspaces derived from sessions, and recent sessions.
3. The user selects a valid workspace, provider/profile, and run mode, then submits a prompt.
4. Main creates an `AbortController`, constructs the existing provider and tool registry, and invokes `runTurn()`.
5. Each `AgentEvent` is persisted by the existing runtime and sent to Renderer with its `runId`.
6. Renderer applies the event through a pure reducer and updates the timeline and detail drawer.
7. Approval and question callbacks wait for a validated IPC response from Renderer.
8. Stop aborts the active controller. The existing runtime emits the interrupted event and preserves the Session log.
9. Completion, failure, or interruption closes the active run record after all queued desktop events have been delivered.

The first release permits one active Turn per application instance. Users may inspect other session histories during execution, but may not start a second Turn.

## 6. Configuration and Secrets

Configuration continues to use `~/.dreamcode/config.json` to preserve current behavior. The UI must explicitly state that API keys are stored locally in plaintext.

Bootstrap and profile-read responses return only redacted values and an `apiKeyConfigured` boolean. API key plaintext may travel from the configuration form to Main only during an explicit save operation. It must never be sent back to Renderer, written to desktop logs, included in snapshots, or exposed in error text.

## 7. Error Handling and Lifecycle

- Missing configuration opens an actionable onboarding/empty state.
- Invalid workspaces produce an inline error and native folder re-selection action.
- Provider/network errors appear in the active timeline without destroying prior events.
- Tool errors remain associated with their tool cards and final risk summary.
- Corrupt session metadata is skipped in lists and reported as a recoverable desktop error.
- Renderer failure loads a recovery screen that can reload the Renderer without deleting local data.
- Closing a window during a Turn requires confirmation. Confirmation aborts the Turn, waits for event-log settlement, then closes the window.
- Large terminal output, Diffs, and timelines use bounded rendering, truncation, or virtualization.

## 8. Testing Strategy

### 8.1 Unit tests

Vitest covers:

- IPC request validation and response serialization.
- Profile redaction and API key non-disclosure.
- Desktop timeline reducer mappings for all existing Agent event types.
- Run state transitions and stale-response rejection.
- View-model derivation for navigation, timeline, Diff, terminal, and errors.

React Testing Library covers navigation, composer state, model configuration, approval, questions, stop, history, Diff, rollback confirmation, and error recovery.

### 8.2 Integration tests

Main-process integration tests use the existing Fake Provider and temporary DreamCode home/workspace directories to verify:

- Renderer-style start request to `runTurn()` event delivery.
- A real built-in tool operation in a temporary workspace.
- Approval allow and deny paths.
- Stop/interruption behavior.
- Session close, reload, and resume.
- Configuration persistence with redacted reads.

### 8.3 Electron end-to-end tests

Playwright launches the built Electron application and verifies:

- First startup and workspace selection.
- Model/profile selection using Fake Provider.
- A complete task from prompt submission through final summary.
- File-change and Diff presentation.
- Approval allow and deny interactions.
- Stop while running.
- Application restart followed by session reload and continuation.
- Configuration persistence after restart.

### 8.4 Packaged chain test

The final acceptance test installs or extracts the packaged Windows artifact and launches it with isolated temporary application data. Using Fake Provider, it must execute a deterministic task that reads a fixture, changes a file, runs a command, displays the resulting events and Diff, closes, relaunches, and resumes the session.

The repository-wide `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` commands must pass before packaging is declared complete.

## 9. Packaging and Delivery

Use Electron Builder to produce:

- A Windows x64 NSIS per-user installer.
- A Windows x64 portable executable.

The installer creates Start Menu integration and supports standard uninstall. Uninstalling the application must not remove `~/.dreamcode` configuration, sessions, snapshots, or artifacts.

The release output includes:

- Installer executable.
- Portable executable.
- SHA-256 checksum file.
- Chain-test report containing exact commands, environment, assertions, and results.
- Known-limitations document if any acceptance item remains unavailable.

## 10. Acceptance Criteria

The desktop release is accepted only when:

1. Its main window matches the approved Codex reference layout and DreamCode color/icon rules.
2. It exposes all in-scope existing DreamCode capabilities without adding misleading unsupported navigation.
3. The Renderer cannot directly access Node.js or secrets.
4. The complete Fake Provider task chain succeeds in the packaged application.
5. File changes, command output, approval, interruption, history, Diff, and resume are exercised by automated tests.
6. Existing CLI tests and commands remain operational.
7. The NSIS installer and portable executable both launch on Windows x64.
8. Deliverable checksums and test evidence are present alongside the artifacts.
