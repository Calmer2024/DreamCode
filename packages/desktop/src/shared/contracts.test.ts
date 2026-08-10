import { describe, expect, it } from "vitest";
import {
  approvalResponseSchema,
  questionResponseSchema,
  rollbackRequestSchema,
  saveProfileRequestSchema,
  startTurnRequestSchema,
} from "./contracts";

describe("desktop IPC contracts", () => {
  it("rejects a start request without a workspace", () => {
    expect(() =>
      startTurnRequestSchema.parse({ prompt: "Fix tests", workspaceRoot: "", mode: "yolo" }),
    ).toThrow();
  });

  it("accepts the four existing run modes", () => {
    for (const mode of ["plan", "guided", "yolo", "full"] as const) {
      expect(
        startTurnRequestSchema.parse({ prompt: "Fix tests", workspaceRoot: "D:/repo", mode }).mode,
      ).toBe(mode);
    }
  });

  it("rejects a profile request without a provider", () => {
    expect(saveProfileRequestSchema.safeParse({ name: "personal" }).success).toBe(false);
  });

  it("rejects malformed rollback and response requests", () => {
    expect(
      rollbackRequestSchema.safeParse({ sessionId: "", filePath: "src/index.ts" }).success,
    ).toBe(false);
    expect(
      approvalResponseSchema.safeParse({ runId: "", requestId: "request", approved: true }).success,
    ).toBe(false);
    expect(
      questionResponseSchema.safeParse({ runId: "run", requestId: "request", answer: "" }).success,
    ).toBe(false);
  });
});
