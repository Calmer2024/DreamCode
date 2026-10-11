import { describe, it, expect } from "vitest";
import type { ModelProvider } from "@dreamcode/shared";
import { judgeProcess } from "./judge.js";
import { validateProcess } from "./scoring.js";

const dimension = (reason: string, evidence: string[]) => ({ score: 3, reason, evidence });
describe("process Judge failure regressions", () => {
  it("retains public background completion reports instead of falsely declaring the subagent unproductive", async () => {
    const provider: ModelProvider = {
      name: "test",
      async *stream(request) {
        const input = JSON.parse(request.messages[1]!.content);
        expect(input.evidence).toHaveLength(3);
        expect(input.evidence[2].type).toBe("background.result");
        expect(input.evidence[2].preview).toContain("Located the parser defect");
        expect(input.evidence[2].preview).not.toContain("total_tokens");
        yield {
          type: "tool_call",
          toolCall: {
            id: "finish",
            name: "submit_process",
            input: {
              toolAccuracy: dimension("Used async report P3", ["P2", "P3"]),
              pathEfficiency: dimension("Result arrived P3", ["P2", "P3"]),
            },
          },
        };
      },
    };
    const result = await judgeProcess(provider, "judge", [
      { id: "E000001", type: "task", data: "fix" },
      {
        id: "E000020",
        type: "model.tool_call",
        data: { payload: { toolCall: { id: "call1", name: "Agent", input: {} } } },
      },
      {
        id: "E003330",
        type: "agent.native_event",
        data: {
          observedAt: "2026-10-10T07:11:00Z",
          record: {
            type: "system",
            subtype: "task_notification",
            tool_use_id: "call1",
            task_id: "task1",
            status: "completed",
            summary: "Located the parser defect",
            usage: { total_tokens: 99999 },
          },
        },
      },
    ]);
    expect(result.pathEfficiency.evidence).toEqual(["E000020", "E003330"]);
  });
  it("reproduces the seven-digit IDs emitted for the Claude Code first case", () => {
    expect(() =>
      validateProcess(
        {
          toolAccuracy: dimension("Repeated errors", ["E0005368"]),
          pathEfficiency: dimension("Recovered", ["E005368"]),
        },
        new Set(["E005368"]),
      ),
    ).toThrow("unknown IDs");
  });
  it("rejects unknown citations in prose even if structured references exist", () => {
    expect(() =>
      validateProcess(
        {
          toolAccuracy: dimension("Error at E0000124", ["E000124"]),
          pathEfficiency: dimension("Progress", ["E000124"]),
        },
        new Set(["E000124"]),
      ),
    ).toThrow("reason");
  });
  it("rejects prose references omitted from the dimension evidence array", () => {
    expect(() =>
      validateProcess(
        {
          toolAccuracy: dimension("Repeated at E000125", ["E000124"]),
          pathEfficiency: dimension("Progress", ["E000124"]),
        },
        new Set(["E000124", "E000125"]),
      ),
    ).toThrow("reason");
  });
  it("uses short local references and a typed submission, translating back to source IDs", async () => {
    const provider: ModelProvider = {
      name: "test",
      async *stream(request) {
        const task = JSON.parse(request.messages[1]!.content);
        expect(task.evidence.map((e: any) => e.id)).toEqual(["P1", "P2"]);
        const submit = request.tools.find((t) => t.name === "submit_process");
        expect(submit).toBeDefined();
        yield {
          type: "tool_call",
          toolCall: {
            id: "finish",
            name: "submit_process",
            input: {
              toolAccuracy: dimension("Minor mistake P2", ["P2"]),
              pathEfficiency: dimension("Recovered P2", ["P2"]),
            },
          },
        };
      },
    };
    const result = await judgeProcess(provider, "judge", [
      { id: "E000001", type: "task", data: "fix" },
      { id: "E005368", type: "tool.completed", data: { status: "success" } },
    ]);
    expect(result.score).toBe(75);
    expect(result.toolAccuracy.evidence).toEqual(["E005368"]);
    expect(result.toolAccuracy.reason).toBe("Minor mistake E005368");
  });
  it("repairs only rejected citations through a valid tool-result exchange without inventing references", async () => {
    let requests = 0;
    const provider: ModelProvider = {
      name: "test",
      async *stream(request) {
        requests++;
        if (requests === 2) {
          expect(
            request.messages.some(
              (m) =>
                m.role === "tool" && m.toolCallId === "bad" && m.content.includes("unknown IDs"),
            ),
          ).toBe(true);
          expect(request.messages.at(-1)?.content).not.toContain("Passing acceptance");
        }
        yield {
          type: "tool_call",
          toolCall: {
            id: requests === 1 ? "bad" : "good",
            name: "submit_process",
            input: {
              toolAccuracy: dimension(requests === 1 ? "Error P02" : "Error P2", [
                requests === 1 ? "P02" : "P2",
              ]),
              pathEfficiency: dimension("Recovery P2", ["P2"]),
            },
          },
        };
      },
    };
    const result = await judgeProcess(provider, "judge", [
      { id: "E000001", type: "task", data: undefined },
      { id: "E005368", type: "tool.completed", data: { status: "error" } },
    ]);
    expect(requests).toBe(2);
    expect(result.score).toBe(75);
    expect(result.toolAccuracy.evidence).toEqual(["E005368"]);
  });
  it("never converts an invented reference into an existing one after repair exhaustion", async () => {
    let requests = 0;
    const provider: ModelProvider = {
      name: "test",
      async *stream() {
        requests++;
        yield {
          type: "tool_call",
          toolCall: {
            id: `bad-${requests}`,
            name: "submit_process",
            input: {
              toolAccuracy: dimension("Error P01", ["P01"]),
              pathEfficiency: dimension("Progress P1", ["P1"]),
            },
          },
        };
      },
    };
    await expect(
      judgeProcess(provider, "judge", [{ id: "E005368", type: "tool.completed", data: {} }]),
    ).rejects.toThrow("invalid after two repairs");
    expect(requests).toBe(3);
  });
});
