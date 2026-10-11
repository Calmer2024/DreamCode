import type { ModelProvider, ModelUsage } from "@dreamcode/shared";

export function usageTotals(values: (ModelUsage | null)[]) {
  const reportedSubtotal = (key: keyof ModelUsage) => {
    const known = values.filter(
      (value) =>
        value &&
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        Number(value[key]) >= 0,
    );
    return known.length || !values.length
      ? known.reduce((total, value) => total + Number(value![key]), 0)
      : null;
  };
  const sum = (key: keyof ModelUsage) =>
    values.every(
      (value) =>
        value &&
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        Number(value[key]) >= 0,
    )
      ? values.reduce((total, value) => total + Number(value![key]), 0)
      : null;
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    costUsd: sum("costUsd"),
    usageCoverage: { requests: values.length, reported: values.filter(Boolean).length },
    reportedSubtotal: {
      inputTokens: reportedSubtotal("inputTokens"),
      outputTokens: reportedSubtotal("outputTokens"),
      cachedInputTokens: reportedSubtotal("cachedInputTokens"),
      costUsd: reportedSubtotal("costUsd"),
    },
  };
}

/** Observe provider telemetry without retaining any prompt or private reasoning. */
export function meterProvider(
  provider: ModelProvider,
  values: (ModelUsage | null)[],
): ModelProvider {
  return {
    name: provider.name,
    async *stream(input) {
      let usage: ModelUsage | null = null;
      try {
        for await (const event of provider.stream(input)) {
          if (event.type === "usage") usage = event.usage;
          yield event;
        }
      } finally {
        values.push(usage);
      }
    },
  };
}
