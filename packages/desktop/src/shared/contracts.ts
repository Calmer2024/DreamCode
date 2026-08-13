import type { AgentEvent, RunMode } from "@dreamcode/shared";
import type { ReplayedSessionState, SessionListItem } from "@dreamcode/store";
import { z } from "zod";

export const workspaceRootSchema = z.string().trim().min(1);

export const startTurnRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  workspaceRoot: workspaceRootSchema,
  mode: z.enum(["plan", "guided", "yolo", "full"]),
  profileName: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
});

export type StartTurnRequest = z.infer<typeof startTurnRequestSchema> & { mode: RunMode };

export const saveProfileRequestSchema = z.object({
  name: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  baseURL: z.string().trim().url().optional(),
  apiKey: z.string().trim().min(1).optional(),
  apiKeyEnv: z.string().trim().min(1).optional(),
});

export const sessionIdSchema = z.string().trim().min(1);
export const runIdSchema = z.string().trim().min(1);

export const rollbackRequestSchema = z.object({
  sessionId: sessionIdSchema,
  filePath: z.string().trim().min(1),
});

export const projectRequestSchema = z.object({
  workspaceRoot: workspaceRootSchema,
  name: z.string().trim().min(1),
  pinned: z.boolean().optional(),
});
export const sessionPinRequestSchema = z.object({
  sessionId: sessionIdSchema,
  pinned: z.boolean(),
});

export const approvalResponseSchema = z.object({
  runId: runIdSchema,
  requestId: z.string().trim().min(1),
  approved: z.boolean(),
});

export const questionResponseSchema = z.object({
  runId: runIdSchema,
  requestId: z.string().trim().min(1),
  answer: z.string().trim().min(1),
});

export interface DesktopRunEvent {
  runId: string;
  event: AgentEvent;
}
export interface DesktopError {
  code: string;
  message: string;
  recoverable: boolean;
}
export type DesktopIpcResponse<T> = { ok: true; value: T } | { ok: false; error: DesktopError };

const safeDesktopErrorMessages: Record<string, string> = {
  invalid_request: "Request is invalid.",
  run_already_active: "Another turn is already active.",
  stale_request: "Request is no longer pending.",
  stale_run: "Run is no longer active.",
  run_interrupted: "Run was interrupted.",
  config_load_failed: "Failed to load DreamCode configuration.",
  provider_setup_failed: "Provider could not be configured.",
  profile_not_found: "No matching model profile is configured.",
  run_failed: "Run failed.",
  status_delivery_failed: "Run status could not be delivered.",
};

export function sanitizeDesktopError(error: unknown): DesktopError {
  if (error && typeof error === "object") {
    const candidate = error as Partial<DesktopError>;
    const message =
      typeof candidate.code === "string" ? safeDesktopErrorMessages[candidate.code] : undefined;
    if (message && typeof candidate.recoverable === "boolean") {
      return { code: candidate.code as string, message, recoverable: candidate.recoverable };
    }
  }
  return { code: "internal_error", message: "Request failed.", recoverable: true };
}

export interface DesktopApprovalRequest {
  runId: string;
  requestId: string;
  tool: string;
  input: unknown;
  reason: string;
}
export interface DesktopQuestionRequest {
  runId: string;
  requestId: string;
  question: string;
}
export interface DesktopRunStatus {
  runId: string;
  status: "running" | "completed" | "failed" | "interrupted";
  error?: DesktopError;
}
export interface SaveProfileRequest {
  name: string;
  provider: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}
export interface ApprovalResponse {
  runId: string;
  requestId: string;
  approved: boolean;
}
export interface QuestionResponse {
  runId: string;
  requestId: string;
  answer: string;
}
export interface RollbackRequest {
  sessionId: string;
  filePath: string;
}
export interface DesktopBootstrap {
  profiles: Array<{
    name: string;
    provider: string;
    model?: string;
    baseURL?: string;
    apiKeyConfigured: boolean;
  }>;
  currentProfile?: string;
  presets: Array<{
    id: string;
    displayName: string;
    defaultModel: string;
    models?: ReadonlyArray<{ id: string; label?: string }>;
  }>;
  sessions: SessionListItem[];
  projects?: Array<{ workspaceRoot: string; name: string; pinned?: boolean; createdAt: string }>;
  pinnedSessionIds?: string[];
}
export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  chooseWorkspace(): Promise<string | undefined>;
  openWorkspace(workspaceRoot: string): Promise<void>;
  saveProfile(request: SaveProfileRequest): Promise<DesktopBootstrap>;
  saveProject(request: {
    workspaceRoot: string;
    name: string;
    pinned?: boolean;
  }): Promise<DesktopBootstrap>;
  deleteProject(workspaceRoot: string): Promise<DesktopBootstrap>;
  deleteSession(sessionId: string): Promise<DesktopBootstrap>;
  setSessionPinned(request: { sessionId: string; pinned: boolean }): Promise<DesktopBootstrap>;
  startTurn(request: StartTurnRequest): Promise<{ runId: string }>;
  stopTurn(runId: string): Promise<void>;
  readSession(sessionId: string): Promise<ReplayedSessionState>;
  readDiff(request: RollbackRequest): Promise<string>;
  rollback(
    request: RollbackRequest,
  ): Promise<{ rolledBackFiles: string[]; failedFiles: Array<{ path: string; reason: string }> }>;
  respondApproval(response: ApprovalResponse): Promise<void>;
  respondQuestion(response: QuestionResponse): Promise<void>;
  onRunEvent(listener: (message: DesktopRunEvent) => void): () => void;
  onApprovalRequest(listener: (request: DesktopApprovalRequest) => void): () => void;
  onQuestionRequest(listener: (request: DesktopQuestionRequest) => void): () => void;
  onRunStatus(listener: (status: DesktopRunStatus) => void): () => void;
}
