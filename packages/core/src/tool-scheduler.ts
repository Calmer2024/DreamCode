import type {
  NormalizedToolCall,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolSchedulePlan,
} from "@dreamcode/shared";
import type { ToolRegistry } from "@dreamcode/tools";

export interface ScheduledToolCall {
  index: number;
  toolCall: NormalizedToolCall;
  plan: ToolSchedulePlan;
}

export interface ToolCallWave {
  mode: ToolExecutionMode;
  calls: ScheduledToolCall[];
  maxConcurrency: number;
}

const DEFAULT_PARALLELISM = 8;

export function resolveToolSchedule(
  registry: ToolRegistry,
  toolCall: NormalizedToolCall,
  context: ToolExecutionContext,
): ToolSchedulePlan {
  const policy = registry.get(toolCall.name)?.schedule;
  const resolved = typeof policy === "function" ? policy(toolCall.input, context) : policy;
  return {
    mode: resolved?.mode ?? "exclusive",
    resources: resolved?.resources,
    concurrencyGroup: resolved?.concurrencyGroup,
    maxConcurrency: resolved?.maxConcurrency,
    actionCost: Math.max(1, Math.floor(resolved?.actionCost ?? 1)),
  };
}

/**
 * Consecutive parallel-safe calls form a wave. Every exclusive call is a barrier,
 * preserving the existing serial semantics around edits, processes and interaction.
 */
export function buildToolCallWaves(
  registry: ToolRegistry,
  toolCalls: NormalizedToolCall[],
  context: ToolExecutionContext,
): ToolCallWave[] {
  const waves: ToolCallWave[] = [];
  let parallel: ScheduledToolCall[] = [];

  const flushParallel = () => {
    if (!parallel.length) return;
    const declaredLimits = parallel
      .map((call) => call.plan.maxConcurrency)
      .filter((value): value is number => value !== undefined && value > 0);
    waves.push({
      mode: "parallel",
      calls: parallel,
      maxConcurrency: Math.min(DEFAULT_PARALLELISM, ...declaredLimits, DEFAULT_PARALLELISM),
    });
    parallel = [];
  };

  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index]!;
    const scheduled = { index, toolCall, plan: resolveToolSchedule(registry, toolCall, context) };
    if (scheduled.plan.mode === "parallel") {
      parallel.push(scheduled);
      continue;
    }
    flushParallel();
    waves.push({ mode: "exclusive", calls: [scheduled], maxConcurrency: 1 });
  }
  flushParallel();
  return waves;
}

export async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  maxConcurrency: number,
  worker: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (!values.length) return [];
  const output = new Array<TOutput>(values.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, maxConcurrency), values.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        output[index] = await worker(values[index]!, index);
      }
    },
  );
  await Promise.all(runners);
  return output;
}
