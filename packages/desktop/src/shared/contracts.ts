import type { AgentEvent, RunMode } from "@dreamcode/shared";
import type { ReplayedSessionState, SessionListItem } from "@dreamcode/store";
import { z } from "zod";

export const workspaceRootSchema = z.string().trim().min(1);

export const startTurnRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  workspaceRoot: workspaceRootSchema,
  mode: z.enum(["plan", "guided", "yolo", "full"]),
  profileId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
});

export type StartTurnRequest = z.infer<typeof startTurnRequestSchema> & { mode: RunMode };

const httpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"));
const environmentVariableSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const credentialActionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("preserve") }),
  z.object({ mode: z.literal("clear") }),
  z.object({ mode: z.literal("inline"), apiKey: z.string().trim().min(1) }),
  z.object({ mode: z.literal("environment"), apiKeyEnv: environmentVariableSchema }),
]);
const profileDraftSchema = z.object({
  alias: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  baseURL: httpUrlSchema.optional(),
  credential: credentialActionSchema,
});
export const createProfileRequestSchema = profileDraftSchema;
export const updateProfileRequestSchema = profileDraftSchema.extend({
  profileId: z.string().trim().min(1),
});
export const profileIdSchema = z.string().trim().min(1);
export const setDefaultProfileRequestSchema = z.object({ profileId: profileIdSchema });
export const testProfileRequestSchema = profileDraftSchema.extend({
  profileId: profileIdSchema.optional(),
});
export const webSearchCredentialRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("preserve") }),
  z.object({ mode: z.literal("clear") }),
  z.object({ mode: z.literal("inline"), apiKey: z.string().trim().min(1) }),
]);
export type WebSearchCredentialRequest = z.infer<typeof webSearchCredentialRequestSchema>;

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
export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export const sessionPinRequestSchema = z.object({
  sessionId: sessionIdSchema,
  pinned: z.boolean(),
});
export const sessionRenameRequestSchema = z.object({
  sessionId: sessionIdSchema,
  title: z.string().trim().min(1).max(80),
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
export interface DesktopTerminalOutput {
  terminalId: string;
  stream: "stdout" | "stderr";
  text: string;
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
  profile_alias_conflict: "A model profile with this alias already exists.",
  profile_validation_failed: "Model profile is invalid.",
  profile_connection_failed: "Model connection test failed.",
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
export type CredentialAction = z.infer<typeof credentialActionSchema>;
export interface ProfileDraftRequest {
  alias: string;
  provider: string;
  model: string;
  baseURL?: string;
  credential: CredentialAction;
}
export type CreateProfileRequest = ProfileDraftRequest;
export type UpdateProfileRequest = ProfileDraftRequest & { profileId: string };
export type TestProfileRequest = ProfileDraftRequest & { profileId?: string };
export type ProfileConnectionResult =
  | { ok: true; message: string }
  | {
      ok: false;
      code:
        | "credential_missing"
        | "credential_invalid"
        | "model_not_found"
        | "network_error"
        | "timeout"
        | "server_error"
        | "empty_response"
        | "profile_not_found";
      message: string;
    };
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
  webSearch?: {
    provider: "exa";
    credentialSource: "inline" | "environment" | "none";
    credentialAvailable: boolean;
  };
  profiles: Array<{
    id: string;
    alias: string;
    provider: string;
    model?: string;
    baseURL?: string;
    credentialSource: "inline" | "environment" | "none";
    apiKeyEnv?: string;
    credentialAvailable: boolean;
  }>;
  currentProfileId?: string;
  presets: Array<{
    id: string;
    displayName: string;
    defaultModel: string;
    defaultBaseURL?: string;
    requiresBaseURL?: boolean;
    models?: ReadonlyArray<{ id: string; label?: string; contextWindowTokens?: number }>;
  }>;
  sessions: SessionListItem[];
  projects?: Array<{ workspaceRoot: string; name: string; pinned?: boolean; createdAt: string }>;
  pinnedSessionIds?: string[];
}
export interface DesktopSessionDetail extends ReplayedSessionState {
  events?: AgentEvent[];
}
export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  chooseWorkspace(): Promise<string | undefined>;
  openWorkspace(workspaceRoot: string): Promise<void>;
  createProfile(request: CreateProfileRequest): Promise<DesktopBootstrap>;
  updateProfile(request: UpdateProfileRequest): Promise<DesktopBootstrap>;
  deleteProfile(profileId: string): Promise<DesktopBootstrap>;
  setDefaultProfile(profileId: string): Promise<DesktopBootstrap>;
  testProfile(request: TestProfileRequest): Promise<ProfileConnectionResult>;
  updateWebSearchCredential(request: WebSearchCredentialRequest): Promise<DesktopBootstrap>;
  saveProject(request: {
    workspaceRoot: string;
    name: string;
    pinned?: boolean;
  }): Promise<DesktopBootstrap>;
  createProject(request: {
    name: string;
  }): Promise<{ bootstrap: DesktopBootstrap; workspaceRoot: string }>;
  deleteProject(workspaceRoot: string): Promise<DesktopBootstrap>;
  deleteSession(sessionId: string): Promise<DesktopBootstrap>;
  renameSession(request: { sessionId: string; title: string }): Promise<DesktopBootstrap>;
  setSessionPinned(request: { sessionId: string; pinned: boolean }): Promise<DesktopBootstrap>;
  startTurn(request: StartTurnRequest): Promise<{ runId: string }>;
  stopTurn(runId: string): Promise<void>;
  startTerminal(cwd: string): Promise<{ terminalId: string }>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, columns: number, rows: number): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  readSession(sessionId: string): Promise<DesktopSessionDetail>;
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
  onTerminalOutput(listener: (output: DesktopTerminalOutput) => void): () => void;
}
