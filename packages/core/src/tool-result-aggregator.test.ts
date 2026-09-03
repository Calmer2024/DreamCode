import { describe, expect, it } from "vitest";
import { ToolResultAggregator } from "./tool-result-aggregator";

describe("ToolResultAggregator", () => {
  it("keeps one tool message per call under a shared batch budget", () => {
    const aggregator = new ToolResultAggregator({ maxBatchChars: 1_200, maxResultChars: 800 });
    const messages = [1, 2, 3].map((index) =>
      aggregator.project(
        { id: `call_${index}`, name: "file.read", input: {} },
        {
          toolCallId: `call_${index}`,
          status: "success",
          summary: `read ${index}`,
          data: { content: "x".repeat(2_000) },
        },
      ),
    );

    expect(messages.map((message) => message.toolCallId)).toEqual(["call_1", "call_2", "call_3"]);
    expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThan(1_600);
    expect(messages[2]!.content).toContain("batch result budget exhausted");
  });
});
