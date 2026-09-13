import { describe, expect, it } from "vitest";
import {
  approvalResponseSchema,
  createProfileRequestSchema,
  questionResponseSchema,
  rollbackRequestSchema,
  startTurnRequestSchema,
} from "./contracts";

describe("desktop IPC contracts", () => {
  it("rejects a start request without a workspace", () => {
    expect(() =>
      startTurnRequestSchema.parse({ prompt: "Fix tests", workspaceRoot: "", mode: "workspace-write" }),
    ).toThrow();
  });

  it("accepts the three canonical run modes", () => {
    for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
      expect(
        startTurnRequestSchema.parse({ prompt: "Fix tests", workspaceRoot: "D:/repo", mode }).mode,
      ).toBe(mode);
    }
  });

  it("accepts an attachment-only turn and rejects a completely empty turn", () => {
    expect(startTurnRequestSchema.safeParse({
      prompt: "",
      attachmentIds: ["attachment_1"],
      workspaceRoot: "D:/repo",
      mode: "workspace-write",
    }).success).toBe(true);
    expect(startTurnRequestSchema.safeParse({
      prompt: "  ",
      workspaceRoot: "D:/repo",
      mode: "workspace-write",
    }).success).toBe(false);
  });

  it("accepts a temporary model override and rejects an empty one", () => {
    expect(
      startTurnRequestSchema.parse({
        prompt: "Fix tests",
        workspaceRoot: "D:/repo",
        mode: "workspace-write",
        profileId: "work",
        model: "gpt-5.5",
      }).model,
    ).toBe("gpt-5.5");
    expect(
      startTurnRequestSchema.safeParse({
        prompt: "Fix tests",
        workspaceRoot: "D:/repo",
        mode: "workspace-write",
        model: " ",
      }).success,
    ).toBe(false);
  });

  it("rejects a profile request without a provider", () => {
    expect(createProfileRequestSchema.safeParse({ alias: "personal" }).success).toBe(false);
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
