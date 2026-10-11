import { it, expect } from "vitest";
import type { ModelProvider, ModelUsage } from "@dreamcode/shared";
import { meterProvider, usageTotals } from "./usage.js";

it("retains reported consumption without treating missing telemetry or fees as zero", () => {
  const value = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8 } as ModelUsage;
  const result = usageTotals([value, null]);
  expect(result.inputTokens).toBeNull();
  expect(result.reportedSubtotal.inputTokens).toBe(10);
  expect(result.costUsd).toBeNull();
  expect(result.reportedSubtotal.costUsd).toBeNull();
  expect(result.usageCoverage).toEqual({ requests: 2, reported: 1 });
  expect(usageTotals([]).costUsd).toBe(0);
});

it("records an interrupted evaluator request with absent usage", async () => {
  const provider: ModelProvider = {
    name: "interrupted",
    async *stream() {
      yield { type: "text_delta", text: "partial" };
      throw Error("interrupted");
    },
  };
  const values: (ModelUsage | null)[] = [];
  const wrapped = meterProvider(provider, values);
  await expect(
    (async () => {
      for await (const _ of wrapped.stream({
        model: "test",
        messages: [],
        tools: [],
        mode: "read-only",
        workspaceRoot: "",
      })) {
        /* consume */
      }
    })(),
  ).rejects.toThrow("interrupted");
  expect(values).toEqual([null]);
  expect(usageTotals(values).inputTokens).toBeNull();
});
