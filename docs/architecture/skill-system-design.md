# DreamCode Skill System Design

Status: approved and implemented
Classification: Architectural
Delivery strategy: one coherent architecture implemented as three independently testable vertical phases

## 1. Purpose

DreamCode currently discovers Skills through a small helper inside `@dreamcode/tools`. It scans only the workspace `.dreamcode/skills` directory and a session-derived global `skills` directory, reads minimal descriptions, and exposes `skill.list`, `skill.read`, and `skill.read_resource`. Core exposes that tool family only when the prompt literally mentions a Skill. There is no authoritative registry, normalized metadata model, lifecycle manager, persistent enablement model, complete RPC surface, or Skill management UI.

The new system must make Skills a first-class DreamCode domain. It must discover compatible Skills already installed on the computer, resolve sources predictably, maintain state and diagnostics, progressively disclose instructions to the model, support explicit user invocation, and manage DreamCode-owned installations without modifying files owned by other agents.

The execution philosophy remains unchanged: a Skill gives the LLM a workflow instruction set, after which the LLM freely ReActs with DreamCode's existing tools. A Skill is not an executable command, a nested agent, or a permission grant.

## 2. Confirmed scope

The complete design covers:

1. A Skill Registry with scanning, metadata parsing, registration, deduplication, querying, enablement, conflict resolution, diagnostics, immutable snapshots, caching, and refresh.
2. Convention-compatible discovery across Built-in, System, User, Project, and Plugin sources.
3. DreamCode-managed installation, enablement, disablement, capability declaration, versioning, updating, overwriting, rollback, and uninstall.
4. Model-facing catalog injection and tool-based loading, plus explicit `/name` and `$name` invocation.
5. Desktop RPC and a low-density Skill settings interface visually aligned with the supplied Codex screenshot.
6. A Plugin Skill source-provider contract without a complete plugin system.

The first implementation does not include a Skill marketplace, ratings, publishing, account sync, a central version service, or a complete Plugin Manager.

## 3. Standards and compatibility policy

DreamCode uses the Open Agent Skills shape as its canonical base. A Skill is a directory containing `SKILL.md`, optionally accompanied by `scripts/`, `references/`, `assets/`, and vendor-specific supporting metadata.

Valid Skills require YAML frontmatter containing non-empty `name` and `description`. Legacy files that omit required metadata are retained as invalid instances with actionable diagnostics; DreamCode does not silently infer identity from a directory name, heading, or first paragraph.

The parser is strict about required base fields and tolerant about extensions:

- Common fields are normalized into the DreamCode metadata model.
- Claude, OpenAI/Codex, and DreamCode extensions are interpreted through adapters.
- Unknown extension fields are preserved under their namespace.
- Unknown fields do not invalidate an otherwise valid Skill.
- YAML executable tags and unsafe custom types are never evaluated.

OpenAI's optional `agents/openai.yaml` presentation, invocation-policy, and dependency metadata is mapped where understood and preserved where not understood. `allow_implicit_invocation` defaults to true.

References:

- [OpenAI Build skills](https://developers.openai.com/codex/skills)
- [Open Agent Skills](https://agentskills.io)

## 4. Architecture choice

A new `@dreamcode/skills` package owns the domain rather than expanding the existing `@dreamcode/tools` implementation.

- `packages/skills` owns domain types, metadata adapters, scanning, registry snapshots, resolution, diagnostics, loading, installation, updating, and rollback.
- `packages/store` persists user-level Skill state, project-local Skill state, custom roots, and managed installation records.
- `packages/tools` exposes `skill.load` and `skill.read_resource` as adapters over a turn-scoped Skill context; it does not scan directories.
- `packages/context` renders a supplied compact Skill catalog within its context budget; it does not depend on the Registry.
- `packages/core` obtains a Snapshot for a turn, constructs `ctx.skills`, parses explicit invocations, injects preloaded Skill content, and coordinates audit events.
- Desktop Main owns long-lived workspace Skill services and exposes them through validated IPC.
- Desktop Renderer consumes RPC data and never scans or mutates Skill directories directly.

The package starts as one cohesive domain package. Splitting registry, installer, or runtime into additional packages is deferred until an independently deployable boundary is demonstrated.

## 5. Domain model

### 5.1 Core entities

- `SkillCandidate`: a physical directory discovered by a scanner before metadata validation.
- `SkillInstance`: one normalized installation or discovered copy, including invalid and overridden instances.
- `ResolvedSkill`: the enabled instance selected for an unqualified name.
- `SkillMetadata`: normalized identity, description, optional version, display information, invocation policy, declared capabilities, and vendor extensions.
- `SkillLocator`: source scope, convention provider, canonical path, real path, and optional plugin identity.
- `SkillSnapshot`: an immutable Registry generation containing instances, resolved entries, conflicts, and diagnostics.

### 5.2 Source scopes

- `built_in`: distributed with DreamCode.
- `system`: supplied by an administrator or system environment.
- `user`: available to the user across projects.
- `project`: discovered for one project and managed only by that project.
- `plugin`: registered by a Plugin Skill source provider.

DreamCode, Agents, Claude, and Codex are convention providers rather than source scopes. For example, `~/.claude/skills/foo` is a User Skill discovered through the Claude convention.

### 5.3 Identity

Each instance receives a stable `skillId` derived from its source and normalized locator. Built-ins use an explicit stable ID; User and System instances use provider plus canonical absolute path; Project instances use provider plus project-relative path; Plugin instances use plugin ID plus plugin-relative path.

Logical name resolution uses a Unicode-normalized, case-insensitive `nameKey` derived from metadata `name`. Directory names do not define identity.

## 6. Default discovery scope

DreamCode automatically scans supported locations. Use never requires importing or copying an external Skill.

### 6.1 Built-in

- DreamCode's packaged Built-in Skill root.

### 6.2 User

- `~/.dreamcode/skills`
- `~/.agents/skills`
- `~/.claude/skills`
- `~/.codex/skills` as a legacy compatibility location

### 6.3 Project

From the current working directory through each ancestor up to the repository root:

- `.dreamcode/skills`
- `.agents/skills`
- `.claude/skills`

### 6.4 System and custom

- Linux: `/etc/dreamcode/skills` and the compatible `/etc/codex/skills`.
- macOS: `/Library/Application Support/DreamCode/skills` and the compatible `/etc/codex/skills`.
- Windows: `%ProgramData%\DreamCode\skills`.
- User-configured additional read-only roots, categorized as external User Skills unless a future source provider explicitly assigns another scope.

### 6.5 Plugin

Plugin roots are not guessed from cache layouts. A future Plugin Manager registers explicit single-Skill paths or roots through the Plugin Skill provider contract.

All home and system locations use platform path APIs and work on Windows, macOS, and Linux. Missing locations are skipped. DreamCode does not recursively search an entire home directory or disk.

## 7. Scanning and metadata parsing

A configured path containing `SKILL.md` is treated as one Skill. Otherwise, the scanner checks only its direct child directories. It does not recursively crawl arbitrary nested folders.

Directory symlinks are supported. The scanner resolves real paths before registration, deduplicates identical targets, detects cycles, and retains both the configured locator and resolved target for diagnostics.

The parser:

1. Reads `SKILL.md` within the 256 KiB limit.
2. Parses safe YAML frontmatter.
3. Validates `name` and `description`.
4. Normalizes base metadata.
5. Applies convention-specific adapters.
6. Records unknown extensions without executing them.
7. Produces an instance or a structured invalid-instance diagnostic.

One malformed Skill or unreadable root does not fail the entire scan.

## 8. Deduplication, precedence, and conflict resolution

Resolution proceeds in this order:

1. Deduplicate canonical and real paths.
2. Exclude invalid instances from callable candidates.
3. Apply effective enablement.
4. Group by normalized `nameKey`.
5. Apply source precedence: `Project > User > Plugin > System > Built-in`.
6. Within Project, prefer the root closest to the working directory.
7. Within the same Project directory, prefer `.dreamcode` over `.agents` over `.claude`.
8. Within User, prefer `.dreamcode` over `.agents` over `.claude` over legacy `.codex`.
9. Within Plugin, apply provider-supplied deterministic ordering.
10. If candidates remain indistinguishable, mark the group conflicted and select none rather than making a filesystem-order choice.

All candidates remain visible in Registry management data. Overridden instances cannot be invoked implicitly. An enabled overridden instance can be explicitly addressed through a qualified invocation.

Examples:

- If Project and User both provide `diagnose`, the Project instance is the unqualified `diagnose`.
- If two Plugin Skills have the same name and identical priority without a provider tie-break, unqualified invocation returns a conflict.

## 9. Enablement and ownership

There is no project override for a Built-in, System, User, or Plugin Skill. Their user-level enabled/disabled state applies across all projects.

Project Skills do not enter user-level Skill configuration. Their state is stored and managed within the owning project only.

- Built-in: may be enabled or disabled; cannot be uninstalled.
- System: may be enabled or disabled in DreamCode; files remain administrator-owned.
- User external: may be enabled or disabled; files remain owned by the external convention manager.
- User managed: may be enabled, disabled, updated, rolled back, or uninstalled by DreamCode.
- Project: may be enabled, disabled, or removed from the project.
- Plugin: may be enabled or disabled; lifecycle operations belong to the future Plugin Manager.

Disabled Skills do not enter the implicit catalog and cannot be loaded explicitly. Exact invocation returns a disabled-state error rather than silently enabling or substituting another instance.

## 10. Persistence

Skill persistence is separated from the existing general `config.json`.

### 10.1 User-level file

`~/.dreamcode/skills.json` contains:

- schema version;
- Built-in, System, User, and Plugin instance states;
- custom scan roots;
- DreamCode-managed installation sources;
- declared and observed version, revision, and content hash;
- update and rollback records.

### 10.2 Project-local file

`<project>/.dreamcode/skills.local.json` contains only project-owned data: Project Skill states keyed by convention provider and project-relative locator, plus lifecycle records for Project Skills installed into `.dreamcode/skills`. It never stores state for Built-in, System, User, or Plugin Skills. A missing file means Project Skills are enabled by default.

The local filename is documented as uncommitted state. The first implementation does not modify `.gitignore` or Git internal configuration automatically.

Both files use schema versions, queued writes, temporary files, and atomic replacement. A failed toggle write causes the Desktop UI to restore the previous state and report the failure. Stale records for temporarily missing Skills are retained so that state is restored if the Skill reappears; an explicit maintenance action may remove orphaned records.

## 11. Registry lifecycle, refresh, and caching

Desktop Main creates one long-lived Skill service for each open workspace. Startup completes an initial scan before the model can receive a Skill catalog; Desktop shows a loading state during this scan.

The service publishes immutable Snapshots with monotonically increasing generations. Core pins one Snapshot for the full model turn. Directory changes can publish a later generation for Desktop and subsequent turns without changing instructions midway through an active turn.

Existing roots are watched with a debounced refresh. A validated RPC supports manual rescan. Metadata caches use canonical path, real path, mtime, size, and content hash so unchanged Skills are not reparsed.

When a previously valid Skill becomes invalid, the new generation marks it invalid and stops exposing it; the loader does not execute a stale cached instruction file. Deleted Skills are removed in the next generation, and their load/resource caches are invalidated.

Registry-wide failures prevent publication of a corrupt replacement Snapshot. Root- or Skill-level failures publish an otherwise valid Snapshot with isolated diagnostics.

## 12. Turn-scoped runtime and context flow

At turn start, Core obtains one Snapshot and constructs a turn-scoped service conceptually equivalent to:

```ts
ctx.skills = {
  generation,
  catalog,
  resolve,
  load,
  readResource,
};
```

Tool implementations receive this context. They do not rescan, rediscover home directories, or resolve a different generation.

The runtime flow is:

```text
Skill roots
  -> candidates
  -> metadata adapters and validation
  -> instances
  -> state and precedence resolution
  -> immutable SkillSnapshot
       -> Desktop management RPC
       -> Core ctx.skills
            -> compact catalog -> ContextBuilder
            -> skill.load -> <skill_content>
            -> skill.read_resource
```

## 13. Compact catalog injection

Every model turn receives basic information for currently resolved, enabled, implicitly invocable Skills. This replaces the existing keyword heuristic that exposes Skill tools only when the prompt contains `skill` or `技能`.

The catalog contains only:

- stable `skillId`;
- name;
- concise description;
- source scope;
- path;
- necessary invocation policy.

It does not contain full `SKILL.md`, scripts, references, or assets.

For known model context windows, the catalog uses no more than 2% of the model context. When the context window is unknown, it uses no more than 8,000 characters. On overflow, the renderer shortens descriptions first and then omits the lowest-precedence entries, emitting an explicit truncation warning. Explicit-only Skills do not consume implicit catalog budget.

## 14. Loading and resource access

`skill.load({ skillId })` is always available to the model. It resolves only within the turn's Snapshot, rechecks state, reads the complete instruction file, and renders a canonical block:

```xml
<skill_content id="..." name="..." source="..." version="..." path="...">
  ...complete Skill instructions...
</skill_content>
```

Attributes and any body text that could forge the closing boundary are escaped. The complete `SKILL.md` is loaded or rejected; DreamCode never truncates instructions and then executes a partial workflow. `SKILL.md` is limited to 256 KiB.

Full Skill content is tool-context guidance, not a system or developer instruction. It remains subordinate to DreamCode policy, the user's request, the current run mode, and permission decisions.

`skill.read_resource` reads UTF-8 text only from within the resolved real Skill root. The default response limit is 40 KiB and the maximum requested limit is 200 KiB. Path traversal, symlink escape, binary content, missing resources, and generation mismatch return structured errors. Loader operations never execute scripts automatically.

Load caching uses generation, real path, and content hash. Repeated loads within a generation return the same content with a cache-hit marker.

## 15. Explicit and implicit invocation

Implicit invocation occurs when the model matches the task to catalog metadata and calls `skill.load`.

Explicit invocation supports:

- `/name task text`: one command-style Skill at the beginning of a message;
- `$name`: one or more Skill mentions anywhere in a normal message.

Composer completion appears for both `/` and `$`. A command's remaining text remains the user's task; the runtime preloads the selected Skill through the same resolver, loader, and `<skill_content>` renderer used by implicit invocation.

DreamCode built-in slash commands win on name collision. `/skill:name` forces a Skill interpretation. Ordinary names use the Resolved Skill; qualified forms such as `/project:name`, `/user:name`, and `/plugin-id:name` can address another enabled instance.

Disabled, invalid, or overridden Skills are omitted from default completion. An exact qualified invocation produces the relevant state or diagnostic instead of silently selecting a different Skill. `allow_implicit_invocation: false` prevents only implicit catalog inclusion and does not block explicit invocation.

## 16. Skill execution and permissions

Loading a Skill does not execute it. The LLM follows the loaded workflow and calls ordinary DreamCode tools as needed. No nested agent, script runner, or Skill-specific sandbox is introduced.

Capabilities normalize to:

- `filesystem.read`
- `filesystem.write`
- `process.execute`
- `network.access`
- `mcp.use`

Capability metadata is declarative. It supports installation risk presentation, settings details, and audit. It never grants authority. Every resulting tool call continues through DreamCode's existing Permission Engine and current run-mode rules.

Core records the Skill IDs loaded during a turn. Their declared capabilities form an audit-only union: if no loaded Skill declares the capability required by a later tool call, Core emits an `undeclared_capability` audit event. The call is still allowed, denied, or presented for approval by the existing Permission Engine. Source trust never bypasses approval.

## 17. DreamCode-managed lifecycle

DreamCode installs only into directories it owns:

- User: `~/.dreamcode/skills/<safe-name>`
- Project: `<project>/.dreamcode/skills/<safe-name>`

External Skills in `.agents`, `.claude`, `.codex`, system, or administrator-managed locations are automatically discovered and usable but cannot be updated or uninstalled by DreamCode. There is no required import or copy step. The first implementation does not expose an optional copy-to-DreamCode action.

Supported managed installation sources are:

- local directory;
- local ZIP;
- Git URL with optional ref/tag and repository subpath.

Sources are staged outside the destination. Git uses argument-based process execution, not composed shell commands. ZIP inspection rejects absolute paths, traversal, device files, escaping symlinks, and archive bombs. Default package limits are 1,000 files, 50 MiB total expanded data, 10 MiB per file, and 256 KiB for `SKILL.md`.

After validation, installation records store source, declared version, source revision/tag, content hash, and installation time.

## 18. Versions, updates, overwrite, and rollback

`version` is optional. Valid SemVer values use semantic comparison. Skills without declared versions remain installable and use source revision or content hash to detect changes; the UI labels them as having no declared version.

The system never relies on declared version alone:

- Same version with different content is an explicit content-change condition.
- A changed source is distinct from an update from the same source.
- Local content differing from the recorded installed hash is treated as a local modification.

Updates stage and validate a complete replacement before mutation. Destination comparison produces an added/changed/deleted summary. Overwrite, downgrade, source change, same-version content change, and loss of local modifications require explicit confirmation.

Successful update moves the prior installation into a rollback area, atomically installs the new directory, and retains exactly one previous snapshot. A later successful update replaces that previous snapshot. Failure restores the old directory and installation record. Rollback follows the same validation and atomic replacement path.

No marketplace or central update service is built. Update sources are Git, the recorded local directory/ZIP, and eventually the owning Plugin Manager.

## 19. Plugin Skill boundary

The new domain exposes a stable Skill source-provider interface that can register:

- plugin ID and display name;
- plugin version;
- individual Skill paths or Skill roots;
- deterministic source ordering;
- an optional management-action reference.

Registered Skills are categorized as Plugin Skills and participate in scanning, conflict resolution, state, catalog injection, explicit invocation, and diagnostics. Tests use a fake provider to exercise this path.

The current project contains no Plugin Manager. This work does not implement plugin manifests, installation, connectors, MCP bundling, signatures, markets, or plugin updates. The settings Plugin filter can exist with an empty state until a provider is present.

## 20. RPC and Desktop boundary

Desktop uses validated request and response contracts for:

- list/query the latest Skill management view;
- read one Skill's details;
- enable or disable an instance;
- rescan roots;
- manage custom roots;
- install, update, overwrite, roll back, uninstall, or remove where ownership permits;
- subscribe to generation/progress changes where needed.

`skill.list` is a Desktop management RPC, not a model discovery tool. The model already has the compact catalog. Existing model-facing `skill.list` and `skill.read` behavior is replaced by catalog injection and `skill.load`; compatibility migration must update their tests and documentation.

IPC schemas reject arbitrary paths and invalid action/source combinations. Renderer receives safe diagnostics and user-facing error messages, not raw exception stacks or unrelated sensitive paths.

## 21. Desktop Skill management UI

The Skill settings page follows the supplied Codex screenshot's visual direction: generous whitespace, a low-density single-column list, subtle separators, concise source labels, and right-aligned switches. It must not become a dense metadata form or table.

### 21.1 List view

The header contains a title, short explanation, search, Scan Locations, Install, and manual Rescan. Lightweight filters cover source and state.

Each row shows:

- circular icon treatment;
- Skill name;
- at most two lines of description;
- source label;
- meaningful version or diagnostic state when present;
- enable switch.

States include enabled, disabled, invalid, overridden, conflicted, and update available.

### 21.2 Details

Selecting a row opens a dedicated detail view rather than expanding a large form in the list. Details group Overview, Source and Version, Declared Capabilities, Diagnostics, and Management Actions. Actions are derived from ownership:

- DreamCode-managed User: enable, disable, check update, update, rollback, uninstall.
- Project: enable, disable, remove from project.
- External User/System: enable, disable, open containing directory.
- Plugin: enable, disable, view owning plugin.
- Built-in: enable, disable, inspect.

Destructive or replacement actions require confirmation. Install, scan, and update operations present non-blocking progress and explicit results.

### 21.3 Composer

The `/` and `$` menus reuse DreamCode's established select/popover interaction, augmented with Skill description and source. They support keyboard navigation, Enter, Escape, visible focus, and accessible labels.

### 21.4 Required states

The UI includes initial loading, empty Registry, empty search, partial root failure, full scan failure, operation progress, operation failure, and stale-generation refresh states. It supports narrow windows without collapsing into a dense control layout.

## 22. Errors and diagnostics

Errors use three layers:

1. Stable machine-readable code.
2. Safe actionable message for the user or model.
3. Internal diagnostic data for logs and tests.

Expected categories include:

- root unreadable;
- metadata missing or invalid;
- duplicate path;
- unresolved name conflict;
- Skill disabled;
- Skill not found;
- stale generation;
- instruction too large;
- resource missing, binary, or outside root;
- unsafe installation package;
- update conflict;
- source unavailable;
- state write failure;
- rollback failure.

A single instance failure never hides unrelated valid Skills. A state write failure rolls UI state back. A failed update restores the previous installation. No error path silently substitutes a different Skill or uses stale instruction content.

## 23. Delivery phases

### Phase 1: Core callable loop

- `@dreamcode/skills` domain package.
- Metadata parsing and diagnostics.
- Default root discovery.
- Deduplication, precedence, enablement reads, and conflict resolution.
- Snapshot generations, cache, watchers, and refresh.
- Compact catalog injection.
- `skill.load` and `skill.read_resource`.
- Canonical `<skill_content>` rendering.
- Explicit invocation parser and Core integration tests.

### Phase 2: Lifecycle management

- Managed local directory/ZIP/Git installation.
- Version, revision, content hash, update, overwrite, rollback, uninstall, and project removal.
- User state and project-local state persistence.
- Capability declarations, risk presentation data, and audit events.
- Custom roots.
- Plugin Skill source-provider contract.

### Phase 3: Desktop experience

- Management RPC and IPC contracts.
- Low-density settings list and detail views.
- Search, filtering, toggles, scan locations, and lifecycle actions.
- `/name` and `$name` completion and preload behavior.
- Desktop and Playwright regression coverage.

Phase 3 was completed and acceptance-tested on August 28, 2026. The production Electron test exercises convention discovery, source filtering and details, enablement persistence across restart, `/name` and `$name` preloading, manual refresh after a real directory change, and managed install/update/rollback/uninstall. Registry tests additionally cover a 500-Skill cold/warm scan, real watcher publication, and Windows path identity. Warm refresh reparses zero unchanged Skill files and reports all 500 as metadata-cache hits.

Each phase must be runnable and independently testable before the next phase begins.

## 24. Test plan

### 24.1 Domain unit tests

- Required and optional metadata.
- Vendor adapters and preserved unknown extensions.
- Invalid YAML and unsafe tags.
- Direct-root and child-directory scanning.
- Symlink support, cycles, real-path deduplication, and path normalization.
- Windows case and separator behavior plus POSIX path abstraction behavior.
- Source and within-source precedence.
- Conflicts, overrides, enablement, and qualified resolution.
- Snapshot generations, cache hits, refresh, deletion, and invalidation.

### 24.2 Lifecycle tests

- Local directory, ZIP, and local Git repository installation.
- Git ref and subpath selection.
- Traversal, absolute paths, symlink escape, unsafe entries, file count, and size limits.
- SemVer and undeclared versions.
- Same-version content changes and local modifications.
- Required confirmations.
- Atomic replacement, simulated failure restoration, and one-version rollback.

### 24.3 Core and context integration tests

- `skill.load` is always exposed.
- Catalog contains only eligible Skills and respects the 2%/8,000-character budget.
- A turn retains one generation while the next turn observes refresh.
- Explicit and implicit paths produce equivalent `<skill_content>`.
- Resource boundaries and binary rejection.
- Loaded-Skill attribution and undeclared-capability audit events.
- Skill content remains subordinate to system policy and user intent.

### 24.4 Store tests

- User and project schema defaults.
- Stable instance keys.
- Concurrent queued writes.
- Atomic replacement.
- Corrupt file behavior and actionable errors.
- Stale state retention and cleanup.

### 24.5 Desktop tests

- Contract validation, IPC registration, preload exposure, and error sanitization.
- Search, filters, row states, enablement, detail actions, and failed-toggle rollback.
- Confirmation flows and ownership-specific controls.
- `/` and `$` completion keyboard behavior.
- Loading, empty, partial-error, and operation-progress states.

### 24.6 End-to-end tests

A temporary workspace exercises automatic discovery, Registry display, enable/disable, explicit invocation, directory change refresh, managed installation, and the primary settings flow.

## 25. Acceptance criteria

The work is complete when:

1. Each phase's unit and integration tests pass before proceeding.
2. Final repository typecheck, relevant lint, unit/integration tests, and Desktop E2E tests pass.
3. A 500-Skill fixture verifies that warm refresh does not reparse unchanged files and records a non-flaky scan benchmark.
4. Catalog budget tests prove the 2%/8,000-character ceiling.
5. Windows path behavior is directly tested, with POSIX behavior covered through path abstraction tests.
6. Compatible Skills are usable automatically without import or copying.
7. External files are never modified by update or uninstall actions.
8. Disabled, invalid, conflicted, and stale Skills cannot be silently loaded.
9. Existing uncommitted Desktop changes are preserved.
10. No incomplete section, unresolved requirement, silent fallback, or test-only production branch remains.

## 26. Explicitly deferred work

- Complete Plugin Manager.
- Plugin manifests, signing, connector or MCP packaging, and plugin update orchestration.
- Skill marketplace, ratings, publishing, and central update service.
- Account synchronization of Skill state.
- Recursive whole-home or whole-disk discovery.
- Automatic copying/importing of external Skills.
- Automatic edits to `.gitignore` or Git internal configuration.
- Nested agents or direct Skill script execution.
- A second permission engine or strict blocking based solely on capability declarations.

## 27. Implementation approval gate

This document records the agreed requirements and design. It does not authorize implementation. Code changes, package scaffolding, behavior changes, configuration migrations, and implementation tests begin only after the user reviews this document and gives explicit final approval.
