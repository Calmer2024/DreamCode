import { dockerAgentArguments } from "./container.js";
import { describe, it, expect } from "vitest";
import { parseCase, parseAcceptance, validateRelative } from "./loader.js";
import { validateChecks, validateProcess, summarize } from "./scoring.js";
import {
  constraintViolations,
  prepareWorkspace,
  workspaceDiff,
  collectArtifacts,
} from "./workspace.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunRecord } from "./types.js";
import type { ModelProvider } from "@dreamcode/shared";
import { judgeAcceptance, anonymizeProcessEvidence } from "./judge.js";
const example = {
  id: "CASE-001",
  instruction: "instruction.md",
  environment: { workspace: "workspace", runtime: "python" },
  acceptance: { evaluator: "program", config: "acceptance.json" },
};
describe("new case contract", () => {
  it("preserves supplied Git state and records actual changes using an independent index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dreameval-git-"));
    try {
      const source = path.join(root, "source"),
        target = path.join(root, "run", "workspace");
      await mkdir(path.join(source, ".git"), { recursive: true });
      await writeFile(path.join(source, ".git", "HEAD"), "ref: refs/heads/customer-branch\n");
      await writeFile(
        path.join(source, ".git", "config"),
        "[core]\n\tbare = false\n[diff]\n\texternal = command-that-must-not-run\n",
      );
      await writeFile(path.join(source, "main.txt"), "before\n");
      await prepareWorkspace(source, target);
      expect(await readFile(path.join(target, ".git", "HEAD"), "utf8")).toContain(
        "customer-branch",
      );
      await writeFile(path.join(target, "main.txt"), "after\n");
      await writeFile(path.join(target, "new.txt"), "new content\n");
      const diff = await workspaceDiff(target);
      expect(diff).toContain("+after");
      expect(diff).toContain("+new content");
      expect(diff).not.toContain("customer-branch");
      await collectArtifacts(target, path.join(root, "artifacts"));
      expect(await readFile(path.join(root, "artifacts", ".git", "HEAD"), "utf8")).toContain(
        "customer-branch",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects legacy scoring fields and nested unknown fields", () => {
    expect(() => parseCase({ ...example, weight: 1 })).toThrow("Unknown field");
    expect(() =>
      parseCase({ ...example, environment: { ...example.environment, commit: "abc" } }),
    ).toThrow("Unknown field");
    expect(parseCase(example)).toEqual(example);
  });
  it("rejects traversal and Windows escape forms", () => {
    for (const value of [
      "../secret",
      "C:/secret",
      "workspace/../secret",
      "workspace\\file",
      "/tmp/file",
      "a//b",
    ])
      expect(() => validateRelative(value)).toThrow();
  });
  it("allows readonly constraints and lets protected files override editable", () => {
    const value = {
      ...example,
      constraints: { editable: ["src/**", "*.md"], protected: ["src/private/**"] },
    };
    expect(
      constraintViolations(value, ["src/main.py", "src/private/key", "README.md", "tests/test.py"]),
    ).toEqual(["src/private/key", "tests/test.py"]);
    expect(
      constraintViolations({ ...example, constraints: { editable: [] } }, ["README.md"]),
    ).toEqual(["README.md"]);
  });
  it("rejects missing/duplicate required checks rather than rewarding skipped work", () => {
    const criteria = [
      { id: "f2p", description: "Fix defect" },
      { id: "p2p", description: "Preserve behavior" },
    ];
    expect(
      validateChecks(criteria, [{ id: "f2p", status: "passed", reason: "ok", evidence: [] }])
        .status,
    ).toBe("error");
    expect(
      validateChecks(
        criteria,
        criteria.map((item) => ({ id: item.id, status: "passed", reason: "ok", evidence: [] })),
      ).status,
    ).toBe("passed");
    expect(() =>
      parseAcceptance({ criteria, program: { file: "test.py", timeoutMs: 0 } }, "program"),
    ).toThrow();
  });
  it("requires explicit ownership of combined acceptance criteria", () => {
    const program = { file: "check.py", timeoutMs: 1000 };
    const criteria = [
      { id: "behavior", description: "Behavior", method: "program" },
      { id: "report", description: "Explanation", method: "judge" },
    ];
    expect(
      parseAcceptance({ criteria, program, rubric: "Evaluate explanation" }, "combined").criteria,
    ).toHaveLength(2);
    expect(() =>
      parseAcceptance(
        { criteria: [{ id: "ambiguous", description: "No method" }], program, rubric: "Anything" },
        "combined",
      ),
    ).toThrow();
  });
  it("requires actual process evidence and preserves ungradable scores", () => {
    const dimension = { score: 4, reason: "Appropriate recovery", evidence: ["E1"] };
    expect(() =>
      validateProcess({ toolAccuracy: dimension, pathEfficiency: dimension }, new Set()),
    ).toThrow();
    expect(
      validateProcess(
        {
          toolAccuracy: dimension,
          pathEfficiency: { score: null, reason: "Missing output", evidence: [] },
        },
        new Set(["E1"]),
      ).score,
    ).toBeNull();
  });
  it("rejects a Judge that credits the reference source instead of the submitted review", async () => {
    const provider: ModelProvider = {
      name: "test",
      async *stream() {
        yield {
          type: "text_delta",
          text: JSON.stringify({
            checks: [
              {
                id: "finding",
                status: "passed",
                reason: "There is a bug in the source",
                evidence: ["S1"],
              },
            ],
          }),
        };
      },
    };
    const entry = {
      instruction: "Review",
      acceptance: {
        criteria: [{ id: "finding", description: "Agent identifies defect" }],
        rubric: "Must identify defect",
      },
    } as Parameters<typeof judgeAcceptance>[2];
    await expect(
      judgeAcceptance(provider, "test", entry, [
        { id: "S1", type: "reference.source", data: "Defective source" },
        { id: "A1", type: "assistant.message", data: "No findings" },
      ]),
    ).rejects.toThrow("submitted answer");
  });
  it("averages repetitions per case and exposes missing coverage", () => {
    let sequence = 0;
    const run = (caseId: string, status: "passed" | "failed" | "error") =>
      ({ id: String(++sequence), caseId, acceptance: { status }, process: null }) as RunRecord;
    expect(
      summarize([run("A", "passed"), run("A", "passed"), run("B", "failed")], ["A", "B"])
        .successRate,
    ).toBe(0.5);
    const partial = summarize([run("A", "error")], ["A", "B"]);
    expect(partial.successRate).toBeNull();
    expect(partial.coverageComplete).toBe(false);
  });
});

it("enforces a read-only workspace mount when a case forbids edits", () => {
  const image = "sha256:" + "a".repeat(64);
  const writable = dockerAgentArguments(image, "workspace", "home", "runtime", "probe");
  const readonly = dockerAgentArguments(image, "workspace", "home", "runtime", "probe", true);
  expect(writable.find((x) => x.endsWith("dst=/workspace"))).toBeDefined();
  expect(readonly.find((x) => x.endsWith("dst=/workspace,readonly"))).toBeDefined();
});

it("rejects mixed execution protocols and unversioned records", () => {
  const configuration = {
    datasetVersion: "1.0.1",
    datasetDigest: "fixed",
    model: "agent",
    provider: "provider",
    judgeModel: "judge",
    timeoutMs: 1000,
    maxModelRequests: 10,
    executionProtocolVersion: "dataset-run-v2",
  };
  const configured = {
    id: "one",
    caseId: "A",
    configuration,
    acceptance: { status: "passed" },
    process: null,
  } as RunRecord;
  const legacy = { ...configured, id: "two", configuration: undefined };
  expect(() => summarize([configured, legacy], ["A"])).toThrow("unversioned");
  const different = {
    ...configured,
    id: "three",
    configuration: { ...configuration, executionProtocolVersion: "other" },
  };
  expect(() => summarize([configured, different], ["A"])).toThrow("different");
  expect(() => summarize([configured, configured], ["A"])).toThrow("Duplicate");
  const dimension = { score: 3, reason: "Minor recovered error", evidence: ["E1"] };
  const judged = {
    ...configured,
    process: { judgeVersion: "one", score: 75, toolAccuracy: dimension, pathEfficiency: dimension },
  };
  const changedJudge = {
    ...judged,
    id: "four",
    process: { ...judged.process, judgeVersion: "two" },
  };
  expect(() => summarize([judged, changedJudge], ["A"])).toThrow("Judge versions");
});

it("removes nested provider identity and private metadata from process evidence", () => {
  const original = [
    {
      id: "E1",
      type: "model.tool_call",
      data: {
        eventId: "old",
        payload: {
          toolCall: {
            id: "call",
            name: "bash",
            input: { command: "pytest -q" },
            rawProvider: "mimo",
            raw: [{ provider: "mimo" }],
          },
        },
        reasoningContent: "private",
      },
    },
  ];
  const filtered = anonymizeProcessEvidence(original);
  expect(JSON.stringify(filtered)).not.toContain("mimo");
  expect(JSON.stringify(filtered)).not.toContain("private");
  expect(JSON.stringify(filtered)).toContain("pytest -q");
  expect(original[0]!.data.payload.toolCall.rawProvider).toBe("mimo");
});

it("retains failed-run consumption and keeps incomplete totals separate from reported subtotals", () => {
  const run = (
    id: string,
    status: "passed" | "failed",
    latency: number,
    input: number | null,
    subtotal: number,
    cost: number,
  ) =>
    ({
      id,
      caseId: id,
      acceptance: { status },
      process: null,
      engineering: {
        agentLatencyMs: latency,
        inputTokens: input,
        outputTokens: 1,
        cachedInputTokens: 0,
        costUsd: cost,
        usageCoverage: { requests: 1, reported: input === null ? 0 : 1 },
        reportedSubtotal: {
          inputTokens: subtotal,
          outputTokens: 1,
          cachedInputTokens: 0,
          costUsd: cost,
        },
      },
    }) as RunRecord;
  const result = summarize(
    [run("A", "passed", 100, 20, 20, 1), run("B", "failed", 900, null, 10, 2)],
    ["A", "B"],
  );
  expect(result.engineering.allRuns.costUsd.total).toBe(3);
  expect(result.engineering.successfulRuns.costUsd.total).toBe(1);
  expect(result.engineering.allRuns.inputTokens.total).toBeNull();
  expect(result.engineering.allRuns.inputTokens.reportedSubtotal).toBe(30);
  expect(result.engineering.agentLatencyMs.caseMean).toBe(500);
});
