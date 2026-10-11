import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ModelProvider, ModelUsage } from "@dreamcode/shared";
import { createModelProvider, resolveModelProviderConfig } from "@dreamcode/models";
import { loadDreamCodeConfig } from "@dreamcode/store";
import { runContainerTurn } from "./container.js";
import { accept } from "./acceptance.js";
import { judgeProcess } from "./judge.js";
import {
  collectArtifacts,
  constraintViolations,
  changedFiles,
  prepareWorkspace,
  snapshot,
  workspaceDiff,
} from "./workspace.js";
import type { Evidence, LoadedCase, RunRecord } from "./types.js";
import { meterProvider, usageTotals } from "./usage.js";
import { traceJudgeProvider, processJudgePolicy, judgeErrorKind } from "./reevaluate.js";
import type { AgentInstallation, ExternalAgent, ModelEndpoint } from "./agents.js";
import { createModelBridge } from "./model-bridge.js";
import { configuredProfileEntries } from "./configured-profiles.js";

/** Safe model choices; credentials and endpoints remain server-side. */
export async function listSavedProfiles() {
  const config = await loadDreamCodeConfig();
  return configuredProfileEntries(config).map(({ id, model, profile }) => ({
    id,
    label: profile.alias,
    provider: profile.provider,
    model,
  }));
}

export async function savedModel(model: string) {
  const config = await loadDreamCodeConfig();
  const profiles = configuredProfileEntries(config).filter((entry) => entry.model === model);
  if (profiles.length !== 1)
    throw Error(
      `Expected one configured credential profile for ${model}, found ${profiles.length}`,
    );
  const profile = profiles[0]!.profile;
  return createModelProvider(
    resolveModelProviderConfig({
      provider: profile.provider,
      model,
      apiKey: profile.apiKey ?? process.env[profile.apiKeyEnv!],
      baseURL: profile.baseURL,
    }),
  );
}
export async function runCase(
  entry: LoadedCase,
  options: {
    directory: string;
    worker: string;
    provider: ModelProvider;
    model: string;
    judge?: { provider: ModelProvider; model: string };
    timeoutMs: number;
    maxModelRequests: number;
    /** Dataset calibration checks task acceptance without requesting process scores. */
    processJudge?: boolean;
    signal?: AbortSignal;
    dataset?: { version: string; digest: string };
    onProgress?: (event: AgentEvent) => void;
    external?: { agent: ExternalAgent; installation: AgentInstallation; endpoint: ModelEndpoint };
    onPhase?: (
      phase: "preparing" | "agent" | "acceptance" | "process_judge" | "completed",
    ) => void | Promise<void>;
  },
) {
  const id = randomUUID(),
    directory = path.resolve(options.directory, `${entry.value.id}-${id}`);
  await mkdir(directory, { recursive: true });
  await options.onPhase?.("preparing");
  const workspace = path.join(directory, "workspace"),
    home = path.join(directory, "agent-home");
  await mkdir(home);
  await prepareWorkspace(entry.workspace, workspace);
  const before = await snapshot(workspace),
    evidence: Evidence[] = [],
    missingEvidence: string[] = [];
  const add = (type: string, data: unknown) =>
    evidence.push({ id: `E${String(evidence.length + 1).padStart(6, "0")}`, type, data });
  const prompt = `${entry.instruction}\n\n${entry.value.constraints ? `Modification constraints: ${JSON.stringify(entry.value.constraints)}` : ""}`;
  add("task", { instruction: prompt });
  add("case.configuration", {
    value: entry.value,
    acceptance: entry.acceptance,
    runtime: entry.runtime,
  });
  let requests = 0;
  const usage: (ModelUsage | null)[] = [];
  const provider: ModelProvider = {
    name: options.provider.name,
    async *stream(input) {
      if (requests >= options.maxModelRequests) throw Error("Model request budget exhausted");
      requests++;
      add("model.request", {
        messages: input.messages.map(({ reasoningContent: _private, ...message }) => message),
        tools: input.tools,
      });
      let reported: ModelUsage | null = null;
      try {
        for await (const event of options.provider.stream(input)) {
          if (event.type === "usage") reported = event.usage;
          // Do not persist private reasoning tokens or hidden reasoning text.
          yield event;
        }
      } finally {
        usage.push(reported);
        add("provider.usage", {
          request: requests,
          usage: reported,
          source: reported ? "provider" : "unavailable",
        });
      }
    },
  };
  const startedAt = new Date().toISOString(),
    start = performance.now();
  let executionError: string | undefined,
    budgetFailure = false,
    ready = false;
  let workerSha256: string | undefined;
  const agentSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
    : AbortSignal.timeout(options.timeoutMs);
  const events: AgentEvent[] = [];
  const onEvent = (event: AgentEvent) => {
    if (event.type === "model.reasoning_delta") return;
    options.onProgress?.(event);
    events.push(event);
    const payload = structuredClone(event.payload) as Record<string, unknown>;
    if (
      event.type === "assistant.message" &&
      payload.message &&
      typeof payload.message === "object"
    )
      delete (payload.message as Record<string, unknown>).reasoningContent;
    add(event.type, { eventId: event.id, timestamp: event.timestamp, payload });
  };
  const http = options.external
    ? createModelBridge({
        endpoint: options.external.endpoint,
        maxModelRequests: options.maxModelRequests,
        signal: agentSignal,
        add,
        onEvent,
        usage,
      })
    : undefined;
  await options.onPhase?.("agent");
  try {
    await runContainerTurn({
      execution: { backend: "docker", image: entry.runtime.image, worker: options.worker },
      workspace,
      readOnlyWorkspace: entry.value.constraints?.editable.length === 0,
      home,
      runtimeDir: path.join(directory, "runtime"),
      prompt,
      environment: {},
      model: options.model,
      provider,
      signal: agentSignal,
      onReady: (runtime) => {
        ready = true;
        workerSha256 = typeof runtime.workerSha256 === "string" ? runtime.workerSha256 : undefined;
        add("runtime", runtime);
      },
      onEvent,
      ...(options.external
        ? {
            external: {
              agent: options.external.agent,
              installation: options.external.installation,
            },
            onHttp: http,
            onExternal: (data: unknown) => add("agent.native_event", data),
          }
        : {}),
      questionHandler: async () =>
        "No further clarification is available. Use the task requirements and repository.",
    });
  } catch (error) {
    executionError = String(error);
    budgetFailure =
      ready && (agentSignal.aborted || executionError.includes("Model request budget exhausted"));
    if (budgetFailure)
      executionError = `${agentSignal.aborted ? `Agent time budget exhausted (${options.timeoutMs}ms)` : `Agent model request budget exhausted (${options.maxModelRequests})`}: ${executionError}`;
    add("execution.error", executionError);
  }
  const agentLatencyMs = performance.now() - start;
  // Preserve complete referenced outputs from the isolated agent home.
  async function collect(directory: string) {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.isSymbolicLink()) continue;
      const absolute = path.join(directory, file.name);
      if (file.isDirectory()) await collect(absolute);
      else if (
        file.isFile() &&
        ["artifacts", "streams", "outputs"].some((component) =>
          path.relative(home, absolute).split(path.sep).includes(component),
        )
      ) {
        const bytes = await readFile(absolute);
        if (bytes.length > 32_000_000)
          missingEvidence.push(`Output exceeds evidence limit: ${path.relative(home, absolute)}`);
        else
          add("agent.output", {
            path: path.relative(home, absolute).split(path.sep).join("/"),
            content: bytes.toString("utf8"),
          });
      }
    }
  }
  await collect(home);
  const outputs = evidence
    .filter((item) => item.type === "agent.output")
    .map((item) => (item.data as { path: string }).path);
  for (const event of events.filter((item) => item.type === "tool.completed")) {
    const payload = event.payload as {
      stdoutRef?: string;
      stderrRef?: string;
      artifactRefs?: string[];
    };
    for (const ref of [
      payload.stdoutRef,
      payload.stderrRef,
      ...(payload.artifactRefs ?? []),
    ].filter((ref): ref is string => Boolean(ref))) {
      const found = ref.startsWith("artifact://")
        ? outputs.some((file) => path.posix.basename(file) === decodeURIComponent(ref.slice(11)))
        : ref.startsWith("/home/agent/") && outputs.includes(ref.slice(12));
      if (!found) missingEvidence.push(`Missing tool output: ${ref}`);
    }
  }
  // Core session state may include private provider reasoning. Persist only the
  // public evidence collected above, and remove the isolated transient home.
  if (path.dirname(home) !== directory || path.basename(home) !== "agent-home")
    throw Error("Invalid transient home path");
  await rm(home, { recursive: true, force: true });
  let after = before;
  try {
    after = await collectArtifacts(workspace, path.join(directory, "artifacts"));
    const files = changedFiles(before, after);
    const diff = await workspaceDiff(workspace);
    await writeFile(path.join(directory, "changes.patch"), diff);
    add("changes", { files, diff });
    for (const file of files)
      if (after[file]) {
        const content = await readFile(path.join(workspace, file));
        add("file", {
          path: file,
          encoding: content.includes(0) ? "base64" : "utf8",
          content: content.toString(content.includes(0) ? "base64" : "utf8"),
        });
      }
  } catch (error) {
    missingEvidence.push(`Artifacts: ${String(error)}`);
  }
  const violations = constraintViolations(entry.value, changedFiles(before, after));
  const acceptanceUsage: (ModelUsage | null)[] = [],
    processUsage: (ModelUsage | null)[] = [];
  const acceptanceJudge = options.judge
    ? {
        ...options.judge,
        provider: meterProvider(
          traceJudgeProvider(options.judge.provider, (item) => add(item.type, item.data)),
          acceptanceUsage,
        ),
      }
    : undefined;
  const acceptanceStart = performance.now();
  await options.onPhase?.("acceptance");
  const acceptance =
    missingEvidence.length || (executionError && !budgetFailure)
      ? {
          status: "error" as const,
          checks: [],
          error: executionError ?? missingEvidence.join("; "),
        }
      : budgetFailure
        ? {
            status: "failed" as const,
            checks: [
              {
                id: "execution:budget",
                status: "failed" as const,
                reason: executionError!,
                evidence: evidence
                  .filter((item) => item.type === "execution.error")
                  .map((item) => item.id),
              },
            ],
          }
        : violations.length
          ? {
              status: "failed" as const,
              checks: [
                {
                  id: "constraints",
                  status: "failed" as const,
                  reason: `Forbidden changes: ${violations.join(", ")}`,
                  evidence: evidence
                    .filter((item) => item.type === "changes")
                    .map((item) => item.id),
                },
              ],
            }
          : await accept(
              entry,
              workspace,
              evidence,
              acceptanceJudge,
              AbortSignal.timeout(entry.runtime.timeoutMs),
            );
  const acceptanceLatencyMs = performance.now() - acceptanceStart;
  const processStart = performance.now();
  if (options.processJudge !== false) await options.onPhase?.("process_judge");
  let process = null;
  let processError: string | undefined;
  const hasTools = events.some(
    (event) => event.type === "model.tool_call" || event.type === "tool.started",
  );
  if (options.processJudge === false) {
    // A calibration run is not a benchmark score or a Judge failure.
  } else if (!hasTools)
    processError = "No tool activity: process applicability policy is not determined";
  else if (options.judge && !missingEvidence.length) {
    try {
      process = await judgeProcess(
        meterProvider(
          traceJudgeProvider(options.judge.provider, (item) => add(item.type, item.data)),
          processUsage,
        ),
        options.judge.model,
        evidence,
        AbortSignal.timeout(entry.runtime.timeoutMs),
        (references) => add("judge.reference_map", references),
      );
    } catch (error) {
      processError = String(error);
    }
  }
  const processLatencyMs = performance.now() - processStart;
  const record: RunRecord = {
    version: 1,
    id,
    caseId: entry.value.id,
    startedAt,
    ...(options.dataset
      ? {
          configuration: {
            executionProtocolVersion: "dataset-run-v6",
            datasetVersion: options.dataset.version,
            datasetDigest: options.dataset.digest,
            model: options.model,
            provider: options.provider.name,
            judgeModel: options.judge?.model ?? null,
            timeoutMs: options.timeoutMs,
            maxModelRequests: options.maxModelRequests,
            agent: options.external?.agent ?? "dreamcode",
            agentVersion: options.external
              ? options.external.installation.agents[options.external.agent].version
              : "workspace",
            ...(options.external
              ? { agentInstallationDigest: options.external.installation.lockDigest }
              : {}),
            modelProtocol: options.external?.endpoint.protocol ?? "dreamcode-provider",
            ...(workerSha256 ? { workerSha256 } : {}),
          },
        }
      : {}),
    evidence,
    missingEvidence,
    execution: {
      status: !executionError
        ? "completed"
        : budgetFailure
          ? agentSignal.aborted
            ? "timeout"
            : "budget_exhausted"
          : "infrastructure_error",
      ...(executionError ? { error: executionError } : {}),
    },
    acceptance,
    process,
    processEvaluation: {
      status:
        options.processJudge === false
          ? "not_requested"
          : missingEvidence.length
            ? "insufficient_evidence"
            : !hasTools
              ? "not_applicable"
              : !options.judge
                ? "not_requested"
                : processError
                  ? "judge_error"
                  : process?.score === null
                    ? "insufficient_evidence"
                    : "graded",
      ...(options.processJudge === false
        ? { reason: "Dataset calibration: process scoring intentionally not requested" }
        : missingEvidence.length
          ? { reason: missingEvidence.join("; ") }
          : processError
            ? { reason: processError }
            : !options.judge
              ? { reason: "Process Judge not configured" }
              : process?.score === null
                ? {
                    reason: [process.toolAccuracy, process.pathEfficiency]
                      .filter((dimension) => dimension.score === null)
                      .map((dimension) => dimension.reason)
                      .join("; "),
                  }
                : {}),
      ...(processError && hasTools && !missingEvidence.length && options.judge
        ? { errorKind: judgeErrorKind(processError) }
        : {}),
    },
    ...(processError ? { processError } : {}),
    engineering: {
      agentLatencyMs,
      ...usageTotals(usage),
      toolCallCount: events.filter((event) => event.type === "model.tool_call").length,
      toolErrorCount: events.filter(
        (event) =>
          event.type === "tool.completed" &&
          ["error", "denied"].includes((event.payload as { status: string }).status),
      ).length,
    },
    evaluation: {
      acceptance: { latencyMs: acceptanceLatencyMs, ...usageTotals(acceptanceUsage) },
      processJudge: { latencyMs: processLatencyMs, ...usageTotals(processUsage) },
    },
    ...(options.judge && options.processJudge !== false
      ? { processJudgePolicy: processJudgePolicy(options.judge.model) }
      : {}),
  };
  await writeFile(path.join(directory, "record.json"), JSON.stringify(record, null, 2));
  await options.onPhase?.("completed");
  return { directory, record };
}
