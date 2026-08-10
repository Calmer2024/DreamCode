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

export type StartTurnRequest = z.infer<typeof startTurnRequestSchema> & { mode: RunMode };
export interface DesktopRunEvent {
  runId: string;
  event: AgentEvent;
}
export interface DesktopError {
  code: string;
  message: string;
  recoverable: boolean;
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
}
export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  chooseWorkspace(): Promise<string | undefined>;
  saveProfile(request: SaveProfileRequest): Promise<DesktopBootstrap>;
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
