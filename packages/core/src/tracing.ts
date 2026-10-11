import type {
  AgentEvent,
  ChatMessage,
  ModelUsage,
  NormalizedToolCall,
  ToolModelSpec,
} from "@dreamcode/shared";
import { type DreamCodeConfig, loadDreamCodeConfig } from "@dreamcode/store";
import { Client } from "langsmith";
import { RunTree } from "langsmith/run_trees";

export interface TraceOptions {
  enabled?: boolean;
  apiKey?: string;
  endpoint?: string;
  workspaceId?: string;
  redactValues?: readonly string[];
  projectName?: string;
  client?: Client;
  hideInputs?: boolean;
  hideOutputs?: boolean;
  flushTimeoutMs?: number;
}

export function resolveTraceOptions(
  config: Pick<DreamCodeConfig, "langsmith" | "profiles" | "exaApiKey">,
  overrides: TraceOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): TraceOptions {
  const stored = config.langsmith ?? {};
  const string = (value: string | undefined) => value?.trim() || undefined;
  const boolean = (value: string | undefined): boolean | undefined => {
    const normalized = value?.trim().toLowerCase();
    return normalized === "true" ? true : normalized === "false" ? false : undefined;
  };
  const apiKey =
    string(env.LANGSMITH_API_KEY) ??
    (stored.apiKeyEnv ? string(env[stored.apiKeyEnv]) : undefined) ??
    stored.apiKey;
  return {
    enabled: overrides.enabled ?? boolean(env.LANGSMITH_TRACING) ?? stored.enabled ?? false,
    apiKey: overrides.apiKey ?? apiKey,
    projectName:
      overrides.projectName ?? string(env.LANGSMITH_PROJECT) ?? stored.projectName ?? "DreamCode",
    endpoint: overrides.endpoint ?? string(env.LANGSMITH_ENDPOINT) ?? stored.endpoint,
    workspaceId: overrides.workspaceId ?? string(env.LANGSMITH_WORKSPACE_ID) ?? stored.workspaceId,
    hideInputs:
      overrides.hideInputs ?? boolean(env.LANGSMITH_HIDE_INPUTS) ?? stored.hideInputs ?? false,
    hideOutputs:
      overrides.hideOutputs ?? boolean(env.LANGSMITH_HIDE_OUTPUTS) ?? stored.hideOutputs ?? false,
    flushTimeoutMs: overrides.flushTimeoutMs ?? stored.flushTimeoutMs ?? 3000,
    client: overrides.client,
    redactValues: [
      ...(overrides.redactValues ?? []),
      stored.apiKey,
      apiKey,
      config.exaApiKey,
      ...Object.values(config.profiles).flatMap((profile) => [
        profile.apiKey,
        profile.apiKeyEnv ? env[profile.apiKeyEnv] : undefined,
      ]),
    ].filter((value): value is string => Boolean(value?.trim())),
  };
}

export async function loadTraceOptions(
  home: string | undefined,
  overrides?: TraceOptions,
): Promise<TraceOptions> {
  try {
    return resolveTraceOptions(await loadDreamCodeConfig(home), overrides);
  } catch {
    console.warn(
      "[DreamCode] Could not read LangSmith configuration; using environment configuration.",
    );
    return resolveTraceOptions({ profiles: {} }, overrides);
  }
}

type Values = Record<string, unknown>;
interface Span {
  run: RunTree;
  posted: Promise<void>;
}

function traceMessage(message: ChatMessage): Values {
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.toolCallId,
    reasoning_content: message.reasoningContent,
    tool_calls: message.toolCalls?.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    })),
    // Keep references and media metadata; do not read or upload attachment bytes.
    attachments: message.attachments?.map(({ id, name, kind, mimeType, size }) => ({
      id,
      name,
      kind,
      mimeType,
      size,
    })),
  };
}

/** Explicit parents keep async generators and concurrent tool waves in the same trace. */
export class TurnTrace {
  private root?: Span;
  private model?: Span;
  private usage?: ModelUsage;
  private modelText = "";
  private modelReasoning = "";
  private modelRunId?: string;
  private tools = new Map<string, Span>();
  private active = new Set<Span>();
  private pending = new Set<Promise<void>>();
  private terminal = false;
  private warned = false;
  private client?: Client;
  private readonly secrets: string[];
  private readonly hideInputs: boolean;
  private readonly hideOutputs: boolean;

  constructor(
    private readonly options: TraceOptions = {},
    inputs: Values = {},
  ) {
    this.hideInputs = options.hideInputs ?? process.env.LANGSMITH_HIDE_INPUTS === "true";
    this.hideOutputs = options.hideOutputs ?? process.env.LANGSMITH_HIDE_OUTPUTS === "true";
    this.secrets = [
      ...(options.redactValues ?? []),
      ...(options.apiKey ? [options.apiKey] : []),
      ...Object.entries(process.env)
        .filter(
          ([key, value]) =>
            /API_?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION/i.test(key) && value && value.length >= 8,
        )
        .map(([, value]) => value!),
    ];
    if (!(options.enabled ?? process.env.LANGSMITH_TRACING === "true")) return;
    if (!options.client && !(options.apiKey ?? process.env.LANGSMITH_API_KEY)?.trim()) {
      this.warn();
      return;
    }
    this.safe(() => {
      this.client =
        options.client ??
        new Client({
          apiKey: options.apiKey ?? process.env.LANGSMITH_API_KEY,
          apiUrl: options.endpoint ?? process.env.LANGSMITH_ENDPOINT,
          workspaceId: options.workspaceId ?? process.env.LANGSMITH_WORKSPACE_ID,
          hideInputs: this.hideInputs,
          hideOutputs: this.hideOutputs,
          timeout_ms: 3000,
          callerOptions: { maxRetries: 0 },
          autoBatchTracing: true,
          blockOnRootRunFinalization: false,
          maxIngestMemoryBytes: 8 * 1024 * 1024,
        });
      const run = new RunTree({
        name: "DreamCode turn",
        run_type: "chain",
        project_name: options.projectName ?? process.env.LANGSMITH_PROJECT ?? "DreamCode",
        client: this.client,
        inputs: this.inputs(inputs),
        metadata: this.clean({ provider: inputs.provider, model: inputs.model, mode: inputs.mode }),
        tags: ["dreamcode"],
      });
      this.root = this.post(run);
    });
  }

  private warn(): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      "[DreamCode] LangSmith trace unavailable or upload incomplete; task execution continues.",
    );
  }

  private safe<T>(action: () => T): T | undefined {
    try {
      return action();
    } catch {
      this.warn();
      return undefined;
    }
  }

  private clean(value: unknown, depth = 0): any {
    if (depth > 12) return "[truncated]";
    if (typeof value === "string") {
      let text = value;
      for (const secret of this.secrets) text = text.replaceAll(secret, "[redacted]");
      text = text.replace(/\bBearer\s+[^\s"']+|\bsk-[A-Za-z0-9_-]{8,}/gi, "[redacted]");
      return text.length > 64_000 ? `${text.slice(0, 64_000)}\n[truncated]` : text;
    }
    if (Array.isArray(value))
      return value.slice(0, 1000).map((item) => this.clean(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 1000)
          .map(([key, item]) => [
            key,
            /^(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|token)$/i.test(
              key,
            )
              ? "[redacted]"
              : this.clean(item, depth + 1),
          ]),
      );
    }
    return typeof value === "bigint" ? String(value) : value;
  }

  private inputs(value: Values): Values {
    return this.hideInputs ? {} : this.clean(value);
  }

  private queue(action: () => Promise<void>): Promise<void> {
    const task = Promise.resolve()
      .then(action)
      .catch(() => this.warn());
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
    return task;
  }

  private post(run: RunTree): Span {
    const payload = { ...run.toJSON(), child_runs: undefined };
    const span = { run, posted: this.queue(() => this.client!.createRun(payload)) };
    this.active.add(span);
    // We track live spans ourselves; retaining SDK child trees duplicates large payloads.
    if (run.parent_run) run.parent_run.child_runs = [];
    return span;
  }

  private child(
    name: string,
    type: string,
    inputs: Values,
    metadata: Values = {},
  ): Span | undefined {
    if (!this.root) return;
    return this.post(
      this.root.run.createChild({
        name,
        run_type: type,
        inputs: this.inputs(inputs),
        metadata: this.clean(metadata),
      }),
    );
  }

  private end(span: Span | undefined, outputs: Values, error?: string): void {
    if (!span || !this.active.delete(span)) return;
    span.run.end_time = Date.now();
    span.run.outputs = this.hideOutputs ? {} : this.clean(outputs);
    span.run.error = error ? this.clean(error) : undefined;
    const { run } = span;
    const update = {
      end_time: new Date(run.end_time!).toISOString(),
      outputs: run.outputs,
      error: run.error,
      parent_run_id: run.parent_run?.id,
      session_name: run.project_name,
      extra: this.clean(run.extra),
      events: run.events,
      trace_id: run.trace_id,
      dotted_order: run.dotted_order,
    };
    this.queue(async () => {
      await span.posted;
      await this.client!.updateRun(run.id, update);
    });
  }

  async measure<T>(
    name: string,
    inputs: Values,
    action: () => Promise<T>,
    type = "chain",
  ): Promise<T> {
    const span = this.safe(() => this.child(name, type, inputs));
    try {
      const result = await action();
      this.safe(() => this.end(span, { result }));
      return result;
    } catch (error) {
      this.safe(() => this.end(span, {}, String(error)));
      throw error;
    }
  }

  startModel(
    inputs: { messages: ChatMessage[]; tools: ToolModelSpec[] },
    provider: string,
    model: string,
  ): void {
    if (!this.root) return;
    this.safe(() => {
      this.usage = undefined;
      this.modelText = "";
      this.modelReasoning = "";
      this.model = this.child(
        "model",
        "llm",
        {
          model,
          messages: inputs.messages.map((message) => traceMessage(this.clean(message))),
          tools: inputs.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        },
        { ls_provider: provider, ls_model_name: model },
      );
      this.modelRunId = this.model?.run.id;
    });
  }

  startTool(call: NormalizedToolCall): void {
    this.safe(() => {
      if (this.tools.has(call.id)) return;
      const span = this.child(
        call.name,
        "tool",
        { input: call.input },
        { toolCallId: call.id, model_run_id: this.modelRunId },
      );
      if (span) this.tools.set(call.id, span);
    });
  }

  observe(event: AgentEvent): void {
    if (!this.root) return;
    this.safe(() => {
      const payload = event.payload as Values;
      this.root!.run.metadata = {
        ...this.root!.run.metadata,
        session_id: event.sessionId,
        thread_id: event.sessionId,
        turn_id: event.turnId,
      };
      if (event.type === "model.usage") {
        this.usage = payload.usage as ModelUsage;
        if (this.model)
          this.model.run.metadata = {
            ...this.model.run.metadata,
            usage_estimated: payload.estimated === true,
          };
      } else if (event.type === "model.delta" || event.type === "model.reasoning_delta") {
        if (event.type === "model.delta")
          this.modelText = (this.modelText + String(payload.text ?? "")).slice(0, 64_000);
        else
          this.modelReasoning = (this.modelReasoning + String(payload.text ?? "")).slice(0, 64_000);
        if (this.model && !this.model.run.events?.length)
          this.model.run.addEvent({ name: "new_token", time: event.timestamp });
      } else if (event.type === "assistant.message") {
        const usage = this.usage;
        this.end(this.model, {
          choices: [{ message: traceMessage(this.clean(payload.message) as ChatMessage) }],
          usage_metadata: usage
            ? {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                total_tokens: usage.totalTokens,
                input_token_details: { cache_read: usage.cachedInputTokens },
                output_token_details: { reasoning: usage.reasoningTokens },
                total_cost: usage.costUsd,
              }
            : undefined,
        });
        this.model = undefined;
      } else if (event.type === "tool.completed") {
        const id = String(payload.toolCallId);
        this.end(
          this.tools.get(id),
          payload,
          payload.status === "error" ||
            payload.status === "denied" ||
            payload.status === "cancelled"
            ? String(payload.summary)
            : undefined,
        );
        this.tools.delete(id);
      } else if (
        event.type === "permission.decided" ||
        event.type === "tool.started" ||
        event.type === "sandbox.denied"
      ) {
        const span = this.tools.get(String(payload.toolCallId));
        span?.run.addEvent({
          name: event.type,
          time: event.timestamp,
          kwargs: this.clean(
            event.type === "permission.decided" ? { decision: payload.decision } : {},
          ),
        });
      }
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        this.terminal = true;
        const error =
          event.type === "turn.completed"
            ? undefined
            : String(payload.error ?? payload.reason ?? event.type);
        for (const span of [...this.active]) {
          if (span !== this.root)
            this.end(
              span,
              this.partial(span, event.type),
              error ?? "Turn ended before span completed",
            );
        }
        this.end(this.root, { status: event.type, ...payload }, error);
      }
    });
  }

  private partial(span: Span, status: string): Values {
    return span === this.model
      ? {
          status,
          choices: [
            {
              message: {
                role: "assistant",
                content: this.modelText,
                reasoning_content: this.modelReasoning,
              },
            },
          ],
        }
      : { status };
  }

  async close(error?: unknown): Promise<void> {
    if (!this.root) return;
    this.safe(() => {
      if (!this.terminal) {
        const reason = error ? String(error) : "Trace stream closed before turn completion";
        for (const span of [...this.active])
          this.end(span, this.partial(span, error ? "failed" : "interrupted"), reason);
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await Promise.all([...this.pending]);
          await this.client!.awaitPendingTraceBatches();
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.warn();
            resolve();
          }, this.options.flushTimeoutMs ?? 3000);
        }),
      ]);
    } catch {
      this.warn();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
