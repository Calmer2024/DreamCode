import { z } from "zod";

export const runModeSchema = z.enum(["plan", "guided", "yolo", "full"]);
export type RunMode = z.infer<typeof runModeSchema>;

export type RiskTag =
  | "read_workspace"
  | "write_workspace"
  | "read_external_path"
  | "write_external_path"
  | "secret_access"
  | "delete_file"
  | "bulk_delete"
  | "shell_readonly"
  | "shell_mutating"
  | "network_access"
  | "web_fetch"
  | "mcp_tool"
  | "rollback"
  | "install_dependency"
  | "writes_config"
  | "external_side_effect"
  | "git_history_rewrite"
  | "long_running"
  | "costly";

export type PermissionDecisionKind = "allow" | "ask" | "deny";

export interface PermissionDecision {
  decision: PermissionDecisionKind;
  reason: string;
  risk: RiskTag[];
  reviewer: "rules" | "user";
  canRemember?: boolean;
}

export interface ToolRiskProfile {
  tags: RiskTag[];
  writesFiles?: boolean;
  readsFiles?: boolean;
  runsCommands?: boolean;
  externalSideEffects?: boolean;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
  rawProvider?: string;
  raw?: unknown;
}

export interface ToolCallObservation {
  toolCall: NormalizedToolCall;
  decision: PermissionDecision;
  result: ToolResult;
}

export interface ChangedFile {
  path: string;
  operation: "create" | "update" | "delete";
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  beforeSnapshotRef?: string;
  patchRef?: string;
}

export interface ToolError {
  code: string;
  category?:
    | "validation"
    | "permission"
    | "environment"
    | "execution"
    | "timeout"
    | "cancelled"
    | "internal";
  reason?: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export type ShellKind = "powershell" | "cmd" | "bash" | "sh";

export type ExecutionOutcome =
  | "validation_failed"
  | "permission_denied"
  | "unsupported_shell"
  | "program_not_found"
  | "spawn_failed"
  | "background_started"
  | "exited_zero"
  | "exited_nonzero"
  | "timed_out"
  | "aborted";

export interface ToolExecutionResult {
  outcome: ExecutionOutcome;
  started: boolean;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  sideEffectsUncertain?: boolean;
}

export interface ToolOutputStream {
  preview: string;
  bytes: number;
  truncated: boolean;
  artifactRef?: string;
}

export interface ToolCacheInfo {
  outcome: "cache_hit";
  sourceToolCallId: string;
  workspaceRevision: number;
}

export interface ToolUsage {
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface ToolResult<T = unknown> {
  toolCallId: string;
  status: "success" | "error" | "cancelled" | "denied";
  data?: T;
  summary: string;
  stdoutRef?: string;
  stderrRef?: string;
  artifactRefs?: string[];
  changedFiles?: ChangedFile[];
  error?: ToolError;
  execution?: ToolExecutionResult;
  streams?: {
    stdout: ToolOutputStream;
    stderr: ToolOutputStream;
  };
  warnings?: string[];
  cache?: ToolCacheInfo;
  usage?: ToolUsage;
}

export interface ToolModelSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SkillCatalogEntry {
  skillId: string;
  name: string;
  description: string;
  source: "built_in" | "system" | "user" | "project" | "plugin";
  path: string;
  allowImplicitInvocation: boolean;
}

export interface SkillLoadedContent {
  skillId: string;
  name: string;
  path: string;
  content: string;
  contentHash: string;
  version?: string;
  cacheHit: boolean;
}

export interface SkillResourceContent {
  skillId: string;
  resourcePath: string;
  content: string;
  truncated: boolean;
}

export interface SkillTurnContext {
  generation: number;
  catalog: readonly SkillCatalogEntry[];
  load(skillId: string): Promise<SkillLoadedContent>;
  readResource(
    skillId: string,
    resourcePath: string,
    maxBytes?: number,
  ): Promise<SkillResourceContent>;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  sessionDir: string;
  sessionId?: string;
  mode: RunMode;
  toolCallId: string;
  signal?: AbortSignal;
  questionHandler?: (question: string) => Promise<string>;
  skills?: SkillTurnContext;
}

export type ToolExecutionMode = "parallel" | "exclusive";

export interface ToolResourceClaim {
  key: string;
  access: "read" | "write";
}

export interface ToolSchedulePlan {
  mode: ToolExecutionMode;
  resources?: ToolResourceClaim[];
  concurrencyGroup?: string;
  maxConcurrency?: number;
  /** Logical operations consumed from the turn budget, including items inside a batch tool. */
  actionCost?: number;
}

export type ToolSchedulePolicy =
  | ToolSchedulePlan
  | ((input: unknown, context: ToolExecutionContext) => ToolSchedulePlan);

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  risk: ToolRiskProfile;
  /** Defaults to exclusive so tools must opt in to concurrent execution. */
  schedule?: ToolSchedulePolicy;
  timeoutMs?: number;
  preflight?(
    input: unknown,
    context: ToolExecutionContext,
  ): ToolResult | undefined | Promise<ToolResult | undefined>;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

export interface ChatMessage {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: NormalizedToolCall[];
}

export interface CompactionCheckpoint {
  boundaryMessageId?: string;
  createdAt: string;
  summary: {
    objective: string;
    confirmedFacts: string[];
    decisions: string[];
    completed: string[];
    active: string[];
    blocked: string[];
    nextSteps: string[];
    relevantFiles: string[];
  };
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: NormalizedToolCall }
  | { type: "usage"; usage: ModelUsage }
  | { type: "done" };

export interface ModelUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  warnings?: string[];
}

export interface RequestTokenEstimate {
  messageTokens: number;
  toolDefinitionTokens: number;
  providerOverheadTokens: number;
  inputTokens: number;
  baseInputTokens?: number;
  calibratedInputTokens?: number;
  correctionRatio?: number;
  sampleCount?: number;
  coldStart?: boolean;
  exact: boolean;
  estimationMethod: string;
}

export interface RequestTokenEstimateInput {
  messages: ChatMessage[];
  tools: ToolModelSpec[];
  model: string;
  providerId?: string;
}

export interface PermissionCapabilityCategory {
  id: string;
  summary: string;
  examples?: string[];
}

export interface PermissionCapabilityContract {
  schemaVersion: number;
  rulesVersion: string;
  generatedFor: { platform: string; currentMode: RunMode };
  defaultDecision: PermissionDecisionKind;
  modes: Record<
    RunMode,
    {
      allow: PermissionCapabilityCategory[];
      ask: PermissionCapabilityCategory[];
      deny: PermissionCapabilityCategory[];
    }
  >;
  currentModeSummary: {
    allow: PermissionCapabilityCategory[];
    ask: PermissionCapabilityCategory[];
    deny: PermissionCapabilityCategory[];
  };
  shellRun: { allowPipelines: boolean; allowMultipleSteps: boolean; guidance: string };
}

export interface ModelStreamInput {
  messages: ChatMessage[];
  tools: ToolModelSpec[];
  model: string;
  mode: RunMode;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface ModelProvider {
  name: string;
  estimateInputTokens?(input: RequestTokenEstimateInput): Promise<RequestTokenEstimate>;
  stream(input: ModelStreamInput): AsyncIterable<ModelEvent>;
}

export type AgentEventType =
  | "session.created"
  | "session.resumed"
  | "session.summarized"
  | "session.indexed"
  | "turn.started"
  | "turn.interrupted"
  | "user.message"
  | "context.built"
  | "context.compressed"
  | "model.started"
  | "model.delta"
  | "model.tool_call"
  | "assistant.message"
  | "model.usage"
  | "permission.decided"
  | "approval.remembered"
  | "tool.schedule.planned"
  | "tool.started"
  | "tool.completed"
  | "artifact.created"
  | "web.source.saved"
  | "skill.loaded"
  | "skill.resource.loaded"
  | "skill.capability.undeclared"
  | "mcp.server.started"
  | "mcp.server.stopped"
  | "mcp.tool.discovered"
  | "file.snapshot.created"
  | "file.changed"
  | "file.rollback.started"
  | "file.rollback.completed"
  | "file.rollback.failed"
  | "todo.updated"
  | "turn.completed"
  | "turn.failed";

export interface AgentEvent<TPayload = unknown> {
  id: string;
  sessionId: string;
  turnId?: string;
  type: AgentEventType;
  timestamp: string;
  payload: TPayload;
}

export interface Session {
  id: string;
  workspaceRoot: string;
  sessionDir: string;
  createdAt: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  prompt: string;
  mode: RunMode;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  completedAt?: string;
}

export interface ContextBuildInput {
  mode: RunMode;
  workspaceRoot: string;
  messages: ChatMessage[];
  todoItems: TodoItem[];
  tools?: ToolModelSpec[];
  model?: string;
  estimateInputTokens?: (input: RequestTokenEstimateInput) => Promise<RequestTokenEstimate>;
  skillCatalog?: string;
}

export interface ContextBuildResult {
  messages: ChatMessage[];
  summary: string;
  estimatedTokens: number;
  tokenEstimate?: RequestTokenEstimate;
  maxTokens: number;
  compressed: boolean;
  checkpoint?: CompactionCheckpoint;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}

export interface FinalSummary {
  status: "completed" | "completed_partial" | "budget_exhausted" | "failed" | "stopped";
  message: string;
  changedFiles: ChangedFile[];
  commands: Array<{
    command: string;
    exitCode?: number;
    summary: string;
  }>;
  risks: string[];
  eventLogPath: string;
}

export const todoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
});

export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeEvent<TPayload>(
  type: AgentEventType,
  input: {
    sessionId: string;
    turnId?: string;
    payload: TPayload;
  },
): AgentEvent<TPayload> {
  return {
    id: createId("evt"),
    sessionId: input.sessionId,
    turnId: input.turnId,
    type,
    timestamp: nowIso(),
    payload: input.payload,
  };
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
