import type {
  EvalCase,
  Runtime,
  AcceptanceConfig,
  RunRecord,
  summarize,
  reevaluateProcess,
  DatasetAgent,
  datasetAgentCatalog,
} from "@dreamcode/evals/dataset";
export type DatasetSummary = ReturnType<typeof summarize>;
export interface DatasetGroup {
  id: string;
  name: string;
  description: string;
  caseIds: string[];
  builtin: boolean;
  createdAt?: string;
  updatedAt?: string;
}
export interface DatasetTask {
  id: string;
  instruction: string;
  instructionTranslated: boolean;
  instructionOriginal: string;
  environment: EvalCase["environment"];
  runtimeConfig: Runtime;
  acceptance: EvalCase["acceptance"];
  acceptanceConfig: AcceptanceConfig;
  case: EvalCase;
  runtime: string;
  evaluator: string;
  constraints?: EvalCase["constraints"];
  metadata?: EvalCase["metadata"];
}
export type DatasetRun = Pick<
  RunRecord,
  | "id"
  | "caseId"
  | "startedAt"
  | "configuration"
  | "acceptance"
  | "process"
  | "processError"
  | "processEvaluation"
  | "engineering"
  | "evaluation"
  | "missingEvidence"
> & { key: string };
export interface DatasetJob {
  id: string;
  group?: Pick<DatasetGroup, "id" | "name">;
  status: "queued" | "running" | "completed" | "interrupted" | "error";
  caseIds: string[];
  model: string;
  agent?: DatasetAgent;
  agentVersion?: string;
  workerSha256?: string;
  agentInstallationDigest?: string;
  progress?: {
    phase: string;
    modelRequests: number;
    toolsStarted: number;
    toolsCompleted: number;
    inputTokens: number;
    outputTokens: number;
    lastEventAt?: string;
  };
  judgeModel: string;
  repeats: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts?: { caseId: string; repetition: number; key?: string; error?: string }[];
  currentCase?: string;
  currentRepetition?: number;
  currentCaseStartedAt?: string;
  completed: number;
  total: number;
  datasetVersion: string;
  datasetDigest: string;
  records: string[];
  errors: { caseId: string; repetition: number; reason: string }[];
  summary?: DatasetSummary;
}
export interface DatasetConfig {
  version: string;
  cases: number;
  models: string[];
  agents: Array<Awaited<ReturnType<typeof datasetAgentCatalog>>[number] & { models: string[] }>;
  ready: boolean;
  budget: { timeoutMs: number; maxModelRequests: number };
}
export type ProcessReview = Awaited<ReturnType<typeof reevaluateProcess>>;
export type ProcessReviewSummary = Omit<ProcessReview, "transcript">;
