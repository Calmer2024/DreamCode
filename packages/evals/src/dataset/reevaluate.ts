import { createHash } from "node:crypto";
import type { ModelProvider, ModelUsage } from "@dreamcode/shared";
import type { Evidence, RunRecord } from "./types.js";
import {
  anonymizeProcessEvidence,
  judgeProcess,
  processRubric,
  processJudgeProtocol,
} from "./judge.js";
import { meterProvider, usageTotals } from "./usage.js";
import { PROCESS_JUDGE_VERSION } from "./scoring.js";

export function judgeErrorKind(error: string) {
  return error.includes("invalid after two repairs")
    ? ("output_format" as const)
    : error.includes("retrieval budget exhausted")
      ? ("retrieval_budget" as const)
      : /abort|timeout/i.test(error)
        ? ("timeout" as const)
        : ("model_error" as const);
}

/** Persist public Judge requests/responses, excluding private reasoning and credentials. */
export function traceJudgeProvider(
  provider: ModelProvider,
  onTrace: (event: Evidence) => void,
): ModelProvider {
  let sequence = 0;
  return {
    ...provider,
    name: provider.name,
    async *stream(request) {
      const call = ++sequence;
      onTrace(
        anonymizeProcessEvidence([
          {
            id: `J${call}:request`,
            type: "judge.request",
            data: {
              model: request.model,
              messages: request.messages,
              tools: request.tools,
            },
          },
        ])[0]!,
      );
      let text = "";
      const calls: unknown[] = [];
      let error: string | null = null;
      const errorCodes: string[] = [];
      try {
        for await (const event of provider.stream(request)) {
          if (event.type === "text_delta") text += event.text;
          if (event.type === "tool_call") calls.push(event.toolCall);
          yield event;
        }
      } catch (failure) {
        error = String(failure);
        let cause: unknown = failure;
        const visited = new Set<unknown>();
        while (cause && typeof cause === "object" && !visited.has(cause) && visited.size < 8) {
          visited.add(cause);
          const detail = cause as { code?: unknown; cause?: unknown };
          if (typeof detail.code === "string") errorCodes.push(detail.code);
          cause = detail.cause;
        }
        throw failure;
      } finally {
        onTrace(
          anonymizeProcessEvidence([
            {
              id: `J${call}:response`,
              type: "judge.response",
              data: { text, toolCalls: calls, error, ...(errorCodes.length ? { errorCodes } : {}) },
            },
          ])[0]!,
        );
      }
    },
  };
}

export function processJudgePolicy(model: string) {
  return {
    model,
    version: PROCESS_JUDGE_VERSION,
    promptDigest: createHash("sha256")
      .update(processRubric)
      .update(JSON.stringify(processJudgeProtocol))
      .digest("hex"),
    evidenceProtocolVersion: "public-evidence-v3",
    maxRequests: processJudgeProtocol.maxRequests,
    maxFormatRepairs: processJudgeProtocol.maxFormatRepairs,
    previewCharacters: processJudgeProtocol.previewCharacters,
    readCharacters: processJudgeProtocol.readCharacters,
    protocol: processJudgeProtocol,
    parameters: "provider-defaults",
  };
}

/** A new evaluation of immutable Agent evidence. Never overwrite the original execution. */
export async function reevaluateProcess(
  record: RunRecord,
  provider: ModelProvider,
  model: string,
  timeoutMs: number,
  onTrace?: (event: Evidence) => void,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error("Invalid Judge timeout");
  const usage: (ModelUsage | null)[] = [],
    transcript: Evidence[] = [];
  const started = performance.now();
  let process: RunRecord["process"] = null,
    error: string | null = null;
  let evidenceReferences: Record<string, string> = {};
  const noTools = !record.evidence.some((item) =>
    ["tool.started", "tool.completed", "model.tool_call"].includes(item.type),
  );
  if (record.missingEvidence.length)
    error = `Missing evidence: ${record.missingEvidence.join("; ")}`;
  else if (noTools) error = "No tool activity: process applicability policy is not determined";
  else
    try {
      process = await judgeProcess(
        meterProvider(
          traceJudgeProvider(provider, (item) => {
            transcript.push(item);
            onTrace?.(item);
          }),
          usage,
        ),
        model,
        record.evidence,
        AbortSignal.timeout(timeoutMs),
        (references) => {
          evidenceReferences = references;
        },
      );
    } catch (failure) {
      error = String(failure);
    }
  return {
    kind: "process-reevaluation" as const,
    sourceRunId: record.id,
    sourceDataset: record.configuration
      ? { version: record.configuration.datasetVersion, digest: record.configuration.datasetDigest }
      : null,
    evidenceDigest: createHash("sha256").update(JSON.stringify(record.evidence)).digest("hex"),
    evidenceReferences,
    evaluatedAt: new Date().toISOString(),
    policy: processJudgePolicy(model),
    status: record.missingEvidence.length
      ? "insufficient_evidence"
      : noTools
        ? "not_applicable"
        : error
          ? "judge_error"
          : process?.score === null
            ? "insufficient_evidence"
            : "graded",
    process,
    error,
    errorKind: error && !record.missingEvidence.length && !noTools ? judgeErrorKind(error) : null,
    metrics: { latencyMs: performance.now() - started, ...usageTotals(usage) },
    transcript,
  };
}
