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
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
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
  usage?: ToolUsage;
}

export interface ToolModelSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  sessionDir: string;
  mode: RunMode;
  toolCallId: string;
  signal?: AbortSignal;
  questionHandler?: (question: string) => Promise<string>;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  risk: ToolRiskProfile;
  timeoutMs?: number;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: NormalizedToolCall }
  | { type: "usage"; usage: ModelUsage }
  | { type: "done" };

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ModelStreamInput {
  messages: ChatMessage[];
  tools: ToolModelSpec[];
  model: string;
  mode: RunMode;
  workspaceRoot: string;
}

export interface ModelProvider {
  name: string;
  stream(input: ModelStreamInput): AsyncIterable<ModelEvent>;
}

export type AgentEventType =
  | "session.created"
  | "turn.started"
  | "user.message"
  | "context.built"
  | "context.compressed"
  | "model.started"
  | "model.delta"
  | "model.tool_call"
  | "permission.decided"
  | "tool.started"
  | "tool.completed"
  | "file.changed"
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
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
}

export interface ContextBuildInput {
  prompt: string;
  mode: RunMode;
  workspaceRoot: string;
  conversationSummary?: string;
  observations: ToolCallObservation[];
  todoItems: TodoItem[];
}

export interface ContextBuildResult {
  messages: ChatMessage[];
  summary: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}

export interface FinalSummary {
  status: "completed" | "failed" | "stopped";
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
