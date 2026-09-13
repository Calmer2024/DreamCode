# Permission and sandbox architecture

## Decision

DreamCode separates capability authorization from resource enforcement:

```text
tool call -> Permission Engine -> sandbox policy compiler -> OS sandbox -> process tree
```

The Permission Engine authorizes declared capabilities and explicit elevation requests. It does not parse Shell source to predict side effects. Compound expressions and pipelines are passed intact to the platform shell.

The compiled sandbox policy is the resource boundary for local process execution. Network access remains enabled in every mode.

## Canonical modes

| Mode | Local reads | Persistent writes | Process execution | Elevation |
| --- | --- | --- | --- | --- |
| `read-only` | All local paths | Denied by the managed file sandbox | Sandboxed process tree | May request `require-escalated` |
| `workspace-write` | All local paths | Workspace and designated session temp only | Sandboxed process tree | May request `require-escalated` |
| `danger-full-access` | All local paths | Unrestricted | Direct argv, no sandbox wrapper | Not required |

Legacy mode names are not part of the internal model or UI.

## Enforcement backends

Linux uses Bubblewrap with a read-only host root and explicit writable binds. The network namespace is shared intentionally.

Windows uses a native restricted-token launcher. Each workspace receives a deterministic capability SID that is granted only on its writable roots. The launcher applies a write-restricted token, puts the suspended child into a kill-on-close Job Object, and then resumes it. Descendants inherit the restricted token and Job Object. Network access is not restricted.

If a managed backend is unavailable, execution fails closed with `sandbox_unavailable`.

Shell result normalization is an observability layer, not an authorization boundary. The runtime preserves compound Shell execution, captures shell-native error state after execution, and reports managed-sandbox resource denials as `sandbox.denied`. Authorization never depends on parsing the submitted Shell source.

Every `permission.decided` event records both the Permission Engine's `policyDecision` and the final user-resolved `decision`. A sandbox denial returns `status: denied`, `execution.outcome: sandbox_denied`, and structured retry guidance that patches `sandbox_permissions` to `require-escalated`; retrying still requires explicit user approval outside `danger-full-access`.

## Runtime context

The model receives one concise `Current DreamCode file policy` sentence. It does not receive permission rules, command allowlists, scanner contracts, or instructions about Shell composition. A tool can explicitly request elevation through its normal input schema; the runtime then asks the user before executing that process outside the sandbox.

## Non-boundaries

Secret-path filtering in broad search is output hygiene, not authorization. Tool descriptions, risk tags, command strings, and parser classifications are not security boundaries.

Configured remote services and MCP approval remain an external-side-effect decision handled by the Permission Engine. The local process sandbox boundary applies to DreamCode-managed command execution; mode-aware lifecycle isolation for long-lived stdio MCP servers remains a separate integration concern.
