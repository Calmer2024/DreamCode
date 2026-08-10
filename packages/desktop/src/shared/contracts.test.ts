import { describe, expect, it } from "vitest";
import { startTurnRequestSchema } from "./contracts";

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
});
