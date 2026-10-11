/** Public case format. Scores and authoring evidence deliberately live elsewhere. */
import type { DatasetAgent } from "./agents.js";
export interface EvalCase {
  id: string;
  instruction: string;
  environment: { workspace: string; runtime: string };
  acceptance: { evaluator: string; config: string };
  constraints?: { editable: string[]; protected?: string[] };
  metadata?: { project?: string; scenario?: string };
}
export interface Runtime {
  image: string;
  timeoutMs: number;
}
export interface LoadedCase {
  value: EvalCase;
  root: string;
  instruction: string;
  workspace: string;
  acceptance: AcceptanceConfig;
  runtime: Runtime;
}
export interface Criterion {
  id: string;
  description: string;
  method?: "program" | "judge";
}
export interface AcceptanceConfig {
  criteria: Criterion[];
  program?: { file: string; timeoutMs: number };
  rubric?: string;
}
export type Verdict = "passed" | "failed" | "error";
export interface CheckResult {
  id: string;
  status: Verdict;
  reason: string;
  evidence: string[];
}
export interface AcceptanceResult {
  status: Verdict;
  checks: CheckResult[];
  error?: string;
}
export interface Evidence {
  id: string;
  type: string;
  data: unknown;
}
export interface ProcessDimension {
  score: number | null;
  reason: string;
  evidence: string[];
}
export interface ProcessResult {
  toolAccuracy: ProcessDimension;
  pathEfficiency: ProcessDimension;
  score: number | null;
  judgeVersion: string;
}
export interface ProcessEvaluationState {
  status: "graded" | "insufficient_evidence" | "not_applicable" | "not_requested" | "judge_error";
  reason?: string;
  errorKind?: "model_error" | "output_format" | "retrieval_budget" | "timeout";
}
export interface EngineeringMetrics {
  agentLatencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
  usageCoverage: { requests: number; reported: number };
  toolCallCount?: number;
  toolErrorCount?: number;
  reportedSubtotal?: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    costUsd: number | null;
  };
}
export type EvaluationMetrics = Omit<
  EngineeringMetrics,
  "agentLatencyMs" | "toolCallCount" | "toolErrorCount"
> & { latencyMs: number };
export interface RunRecord {
  version: 1;
  id: string;
  caseId: string;
  startedAt: string;
  configuration?: {
    executionProtocolVersion?: string;
    datasetVersion: string;
    datasetDigest: string;
    model: string;
    provider: string;
    judgeModel: string | null;
    timeoutMs: number;
    maxModelRequests: number;
    agent?: DatasetAgent;
    agentVersion?: string;
    agentInstallationDigest?: string;
    modelProtocol?: "openai" | "anthropic" | "dreamcode-provider";
    workerSha256?: string;
  };
  evidence: Evidence[];
  missingEvidence: string[];
  execution?: {
    status: "completed" | "timeout" | "budget_exhausted" | "infrastructure_error";
    error?: string;
  };
  acceptance: AcceptanceResult;
  process: ProcessResult | null;
  processError?: string;
  processEvaluation?: ProcessEvaluationState;
  processJudgePolicy?: {
    model: string;
    version: string;
    promptDigest: string;
    evidenceProtocolVersion: string;
    maxRequests: number;
    maxFormatRepairs: number;
    previewCharacters: number;
    readCharacters: number;
    parameters: string;
  };
  engineering: EngineeringMetrics;
  evaluation?: { acceptance: EvaluationMetrics; processJudge: EvaluationMetrics };
}
