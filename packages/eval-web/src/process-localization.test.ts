import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@dreamcode/shared";
import type { RunRecord } from "@dreamcode/evals/dataset";
import { localizeProcess } from "./process-localization";

const record = {
  process: {
    toolAccuracy: {
      score: 3,
      reason: "Minor mistake E001, recovered E002",
      evidence: ["E001", "E002"],
    },
    pathEfficiency: { score: 4, reason: "Coherent progress E003", evidence: ["E003"] },
  },
} as RunRecord;
const provider = (output: unknown): ModelProvider => ({
  name: "test",
  async *stream() {
    yield { type: "text_delta", text: JSON.stringify(output) };
  },
});
describe("Chinese process display", () => {
  it("translates prose without changing stored grades or citations", async () => {
    const before = JSON.stringify(record);
    const result = await localizeProcess(
      record,
      provider({
        toolAccuracy: "轻微错误 E001，随后在 E002 恢复。",
        pathEfficiency: "推进连贯 E003。",
      }),
      "test",
    );
    expect(result.toolAccuracy).toContain("轻微错误");
    expect(JSON.stringify(record)).toBe(before);
  });
  it("rejects translation that drops or invents evidence IDs", async () => {
    await expect(
      localizeProcess(
        record,
        provider({ toolAccuracy: "轻微错误 E001。", pathEfficiency: "推进连贯 E003。" }),
        "test",
      ),
    ).rejects.toThrow("证据编号");
    await expect(
      localizeProcess(
        record,
        provider({ toolAccuracy: "轻微错误 E001 E002 E999。", pathEfficiency: "推进连贯 E003。" }),
        "test",
      ),
    ).rejects.toThrow("证据编号");
  });
});
