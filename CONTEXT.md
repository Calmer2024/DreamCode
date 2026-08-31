# DreamCode Skills

DreamCode Skills is the domain for discovering, selecting, loading, and managing reusable agent workflows while keeping their execution subject to DreamCode's normal tool permissions.

## Language

**Skill**:
A reusable workflow consisting of a `SKILL.md` instruction file and optional supporting resources.
_Avoid_: Command, tool, plugin

**Skill Metadata**:
The normalized identity, description, version, invocation policy, presentation, and declared capabilities of a **Skill**.
_Avoid_: Manifest, frontmatter

**Skill Instance**:
One concrete installation or discovered copy of a **Skill** at a specific source location.
_Avoid_: Skill, duplicate

**Resolved Skill**:
The enabled **Skill Instance** selected for an unqualified name after precedence and conflict rules are applied.
_Avoid_: Active copy, default Skill

**Skill Registry**:
The authoritative collection of discovered **Skill Instances**, resolution results, states, and diagnostics available to DreamCode.
_Avoid_: Skill list, scanner

**Skill Snapshot**:
An immutable generation of the **Skill Registry** used consistently for one model turn.
_Avoid_: Cache, current list

**Managed Skill**:
A **Skill Instance** installed into a DreamCode-owned directory whose lifecycle DreamCode may update, roll back, or uninstall.
_Avoid_: Imported Skill

**External Skill**:
A **Skill Instance** that DreamCode automatically discovers and can use but whose files remain owned by another tool or administrator.
_Avoid_: Unmanaged import, unsupported Skill

**Built-in Skill**:
A **Skill Instance** distributed with DreamCode and available to every user.

**System Skill**:
An administrator-provided **Skill Instance** installed at machine or environment scope.

**User Skill**:
A **Skill Instance** discovered from a user-scoped location and available across projects.
_Avoid_: Global Skill, personal copy

**Project Skill**:
A **Skill Instance** discovered from a project-scoped location and managed only by that project.
_Avoid_: Workspace override

**Plugin Skill**:
A **Skill Instance** exposed by a plugin source provider and lifecycle-managed by its owning plugin system.

**Convention Provider**:
The directory or metadata convention through which a **Skill Instance** was discovered, such as DreamCode, Agents, Claude, or Codex.
_Avoid_: Source scope

**Explicit Invocation**:
A user selection of a **Skill** by `/name` command or `$name` mention.

**Implicit Invocation**:
A model selection of a **Skill** by matching the user's task against its injected name and description.

**Declared Capability**:
A non-authoritative statement of the tool capability a **Skill** expects to use during its workflow.
_Avoid_: Permission grant

## Relationships

- A **Skill** can have zero or more supporting resources.
- A **Skill** can have one or more **Skill Instances**.
- A **Skill Instance** has exactly one source scope and one **Convention Provider**.
- A name group has at most one **Resolved Skill** for unqualified invocation.
- A **Skill Snapshot** contains zero or more **Skill Instances** and zero or more **Resolved Skills**.
- A **Managed Skill** is owned by DreamCode; an **External Skill** is owned outside DreamCode.
- A **Declared Capability** never grants permission to execute a tool.
- **Explicit Invocation** and **Implicit Invocation** load the same Skill content through the same runtime loader.

## Example dialogue

> **Dev:** "The project and user directories both contain a `diagnose` **Skill Instance**. Which one does `$diagnose` load?"
> **Domain expert:** "The project instance becomes the **Resolved Skill**. The user instance remains visible in the **Skill Registry** and can still be selected with a qualified **Explicit Invocation** if it is enabled."

## Flagged ambiguities

- "External Skill import" suggested that compatible Skills required copying before use — resolved: every supported location is discovered automatically, and copying/importing is not part of the first release.
- "Project state" was initially used for project overrides of global Skills — resolved: only **Project Skills** have project-local state; Built-in, System, User, and Plugin Skills use user-level state across projects.
- "Skill permission" could mean a permission grant — resolved: a **Declared Capability** is informational and auditable, while the existing DreamCode permission engine remains authoritative.
- "Provider" could mean both lifecycle scope and directory convention — resolved: Built-in/System/User/Project/Plugin are source scopes, while DreamCode/Agents/Claude/Codex are **Convention Providers**.
