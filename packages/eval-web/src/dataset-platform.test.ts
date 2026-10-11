import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ModelProvider } from "@dreamcode/shared";
import {
  processJudgePolicy,
  type LoadedCase,
  type RunRecord,
  type admissionReport,
  type ModelEndpoint,
} from "@dreamcode/evals/dataset";
import { createDatasetPlatform, validateLaunch } from "./dataset-platform";
import type { DatasetJob } from "./dataset-types";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function fixture(external = false, secondCase = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dreameval-platform-"));
  await mkdir(path.join(root, "evals/dataset"), { recursive: true });
  await writeFile(
    path.join(root, "evals/dataset/execution.json"),
    JSON.stringify({ timeoutMs: 1000, maxModelRequests: 10 }),
  );
  const entry = {
    value: {
      id: "CASE-001",
      instruction: "instruction.md",
      environment: { workspace: "workspace", runtime: "test" },
      acceptance: { evaluator: "program", config: "acceptance.json" },
      metadata: { scenario: "bugfix" },
    },
    instruction: "Fix a bug",
    acceptance: { criteria: [] },
  } as unknown as LoadedCase;
  const provider: ModelProvider = {
    name: "test-control",
    async *stream() {
      yield {
        type: "text_delta",
        text: JSON.stringify({
          toolAccuracy: { score: 3, reason: "Observed recovery", evidence: ["P1"] },
          pathEfficiency: { score: 4, reason: "Useful progress", evidence: ["P1"] },
        }),
      };
    },
  };
  let executions = 0;
  const options = {
    repoRoot: root,
    runsRoot: path.join(root, "evals/runs"),
    load: async () => ({
      version: "test",
      cases: secondCase
        ? [entry, { ...entry, value: { ...entry.value, id: "CASE-002" } }]
        : [entry],
    }),
    integrity: async () => ({ algorithm: "sha256-tree-v1", digest: "fixed", files: 1 }),
    admission: async () => ({ ready: true }) as Awaited<ReturnType<typeof admissionReport>>,
    profiles: async () => [{ id: "test", label: "Test", provider: "test", model: "test-agent" }],
    provider: async () => provider,
    claudeEndpoints: async (): Promise<ModelEndpoint[]> => [],
    localize: async () => ({ toolAccuracy: "工具使用准确 E1", pathEfficiency: "路径高效 E1" }),
    ...(external
      ? {
          agents: async () => [
            {
              id: "claude-code" as const,
              label: "Claude Code" as const,
              available: true,
              version: "test-cli",
              detail: "test",
            },
          ],
          installation: async () => ({
            version: 1 as const,
            image: `sha256:${"a".repeat(64)}`,
            volume: `dreameval-harness-${"a".repeat(24)}`,
            lockDigest: "a".repeat(64),
            agents: {
              "claude-code": { version: "test-cli", command: ["claude"] },
              pi: { version: "test", command: ["pi"] },
              dsh: { version: "test", command: ["dsh"] },
              opencode: { version: "test", command: ["opencode"] },
            },
          }),
          endpoint: async () => ({
            protocol: "anthropic" as const,
            baseURL: "https://fake.invalid",
            apiKey: "HOST-SECRET",
            model: "test-agent",
            provider: "test",
          }),
        }
      : {}),
    execute: async (
      entry: LoadedCase,
      input: Parameters<NonNullable<Parameters<typeof createDatasetPlatform>[0]["execute"]>>[1],
    ) => {
      executions++;
      if (external) {
        expect(input.external?.agent).toBe("claude-code");
        expect(input.external?.endpoint.apiKey).toBe("HOST-SECRET");
        await input.onPhase?.("agent");
        input.onProgress?.({
          id: "progress",
          sessionId: "test",
          type: "model.started",
          timestamp: new Date().toISOString(),
          payload: {},
        });
      }
      const directory = path.join(input.directory, `${entry.value.id}-${randomUUID()}`);
      await mkdir(directory, { recursive: true });
      const dimension = { score: 4, reason: "Control", evidence: ["E1"] };
      const record: RunRecord = {
        version: 1,
        id: randomUUID(),
        caseId: entry.value.id,
        startedAt: new Date().toISOString(),
        configuration: {
          executionProtocolVersion: "dataset-run-v4",
          datasetVersion: "test",
          datasetDigest: "fixed",
          model: input.model,
          provider: "test-control",
          judgeModel: input.judge!.model,
          timeoutMs: 1000,
          maxModelRequests: 10,
        },
        processJudgePolicy: processJudgePolicy(input.judge!.model),
        evidence: [{ id: "E1", type: "tool.completed", data: { tool: "bash", exitCode: 0 } }],
        missingEvidence: [],
        acceptance: { status: "passed", checks: [] },
        process: {
          toolAccuracy: dimension,
          pathEfficiency: dimension,
          score: 100,
          judgeVersion: "process-v3",
        },
        engineering: {
          agentLatencyMs: 1,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          costUsd: null,
          usageCoverage: { requests: 0, reported: 0 },
        },
      };
      await writeFile(path.join(directory, "record.json"), JSON.stringify(record));
      return { directory, record };
    },
  };
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url!, base));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port,
    base = `http://127.0.0.1:${port}`;
  let handler = createDatasetPlatform({ ...options, port });
  closers.push(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const request = (route: string, body?: unknown, origin?: string, method?: string) =>
    fetch(
      base + route,
      body || method
        ? {
            method: method ?? "POST",
            headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
            body: body ? JSON.stringify(body) : undefined,
          }
        : undefined,
    );
  return {
    root,
    options,
    port,
    request,
    executions: () => executions,
    restart: () => {
      handler = createDatasetPlatform({ ...options, port });
    },
  };
}
describe("new dataset platform", () => {
  it("caches Chinese display separately and preserves original execution records", async () => {
    const app = await fixture();
    let translations = 0;
    app.options.localize = async () => {
      translations++;
      return { toolAccuracy: "工具使用准确 E1", pathEfficiency: "路径高效 E1" };
    };
    app.restart();
    await app.request("/api/dataset/jobs", { caseIds: ["CASE-001"], model: "test-agent" });
    let key: string | undefined;
    for (let attempt = 0; attempt < 30 && !key; attempt++) {
      key = (await (await app.request("/api/dataset/jobs")).json())[0]?.records[0];
      if (!key) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(key).toBeDefined();
    const original = await (await app.request(`/api/dataset/runs/${key}`)).text();
    expect(
      (await app.request("/api/dataset/process-translation", { key, model: "unknown" })).status,
    ).toBe(400);
    for (let i = 0; i < 2; i++) {
      const response = await app.request("/api/dataset/process-translation", {
        key,
        model: "test-agent",
      });
      expect(response.status).toBe(200);
      expect((await response.json()).toolAccuracy).toContain("工具使用准确");
    }
    expect(translations).toBe(1);
    expect(await (await app.request(`/api/dataset/runs/${key}`)).text()).toBe(original);
  });
  it("refreshes local Claude models and launches them independently of the DreamCode Judge profile", async () => {
    const app = await fixture(true);
    let active = "local-first";
    app.options.claudeEndpoints = async () => [
      {
        protocol: "anthropic",
        baseURL: "https://fake.invalid",
        apiKey: "HOST-SECRET",
        model: active,
        provider: "local",
      },
    ];
    const usedProfiles: string[] = [];
    const originalProvider = app.options.provider;
    app.options.provider = async (...args: unknown[]) => {
      usedProfiles.push(String(args[0]));
      expect(args[0]).toBe("test-agent");
      return originalProvider();
    };
    app.restart();
    const config = () => app.request("/api/dataset/config").then((response) => response.json());
    expect((await config()).agents[0].models).toEqual(["local-first", "test-agent"]);
    active = "local-second";
    const refreshed = await config();
    expect(refreshed.agents[0].models).toEqual(["local-second", "test-agent"]);
    expect(refreshed.models).toEqual(["test-agent"]);
    expect(JSON.stringify(refreshed)).not.toContain("HOST-SECRET");
    const body = {
      agent: "claude-code",
      caseIds: ["CASE-001"],
      model: active,
      judgeModel: "test-agent",
    };
    expect((await app.request("/api/dataset/jobs", { ...body, model: "local-first" })).status).toBe(
      400,
    );
    expect((await app.request("/api/dataset/jobs", { ...body, judgeModel: active })).status).toBe(
      400,
    );
    expect((await app.request("/api/dataset/jobs", body)).status).toBe(202);
    for (let attempt = 0; attempt < 30 && !app.executions(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.executions()).toBe(1);
    expect(usedProfiles).toEqual(["test-agent", "test-agent"]);
  });
  it("persists reusable groups and freezes submitted scope and name through edits and deletion", async () => {
    const app = await fixture(false, true);
    expect((await (await app.request("/api/dataset/groups")).json())[0].caseIds).toEqual([
      "CASE-001",
      "CASE-002",
    ]);
    expect((await app.request("/api/dataset/groups", { name: "bad", caseIds: [] })).status).toBe(
      400,
    );
    expect(
      (await app.request("/api/dataset/groups", { name: "bad", caseIds: ["CASE-001", "CASE-001"] }))
        .status,
    ).toBe(400);
    expect(
      (await app.request("/api/dataset/groups", { name: "bad", caseIds: ["unknown"] })).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/dataset/groups/default-60", {
          name: "overwrite",
          caseIds: ["CASE-001"],
        })
      ).status,
    ).toBe(400);
    const group = await (
      await app.request("/api/dataset/groups", {
        name: "My group",
        description: "coverage",
        caseIds: ["CASE-001"],
      })
    ).json();
    app.restart();
    expect(
      (await (await app.request("/api/dataset/groups")).json()).find(
        (item: any) => item.id === group.id,
      ).name,
    ).toBe("My group");
    const submitted = await (
      await app.request("/api/dataset/jobs", { groupId: group.id, model: "test-agent" })
    ).json();
    const edited = await app.request(`/api/dataset/groups/${group.id}`, {
      name: "New name",
      caseIds: ["CASE-002"],
    });
    expect(edited.status).toBe(200);
    const snapshot = (await (await app.request("/api/dataset/jobs")).json()).find(
      (item: any) => item.id === submitted.id,
    );
    expect(snapshot.group.name).toBe("My group");
    expect(snapshot.caseIds).toEqual(["CASE-001"]);
    // Remove only the reusable definition; original execution history remains addressable.
    expect(
      (await app.request(`/api/dataset/groups/${group.id}`, undefined, undefined, "DELETE")).status,
    ).toBe(200);
    expect(
      (await app.request("/api/dataset/groups/default-60", undefined, undefined, "DELETE")).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/api/dataset/groups/${group.id}`,
          undefined,
          "https://external.example",
          "DELETE",
        )
      ).status,
    ).toBe(403);
    expect(
      (await (await app.request("/api/dataset/jobs")).json()).some(
        (item: any) => item.id === submitted.id,
      ),
    ).toBe(true);
    expect(
      (await app.request("/api/dataset/jobs", { groupId: group.id, model: "test-agent" })).status,
    ).toBe(400);
  });
  it("persists framework selection, resolves credentials server-side and exposes only public capabilities", async () => {
    const app = await fixture(true);
    const config = await (await app.request("/api/dataset/config")).json();
    expect(config.agents[0]).toMatchObject({
      id: "claude-code",
      available: true,
      models: ["test-agent"],
    });
    expect(JSON.stringify(config)).not.toContain("HOST-SECRET");
    expect(
      (
        await app.request("/api/dataset/jobs", {
          agent: "unsupported",
          groupId: "default-60",
          model: "test-agent",
        })
      ).status,
    ).toBe(400);
    const response = await app.request("/api/dataset/jobs", {
      agent: "claude-code",
      groupId: "default-60",
      model: "test-agent",
    });
    expect(response.status).toBe(202);
    const submitted = await response.json();
    expect(submitted.agent).toBe("claude-code");
    expect(JSON.stringify(submitted)).not.toContain("HOST-SECRET");
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = (await (await app.request("/api/dataset/jobs")).json())[0];
      if (job.status === "completed") {
        expect(job.completed).toBe(1);
        expect(job.agentVersion).toBe("test-cli");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(app.executions()).toBe(1);
  });
  it("accepts direct case selection and rejects ambiguous scopes, unknown cases and invalid budgets", () => {
    const groups = [
      { id: "default-60", name: "All", description: "", caseIds: ["A"], builtin: true },
    ];
    expect(() =>
      validateLaunch({ caseIds: ["A"], groupId: "default-60", model: "test" }, groups, ["test"]),
    ).toThrow();
    expect(validateLaunch({ caseIds: ["A"], model: "test" }, groups, ["test"]).caseIds).toEqual([
      "A",
    ]);
    for (const caseIds of [[], ["unknown"], ["A", "A"]])
      expect(() => validateLaunch({ caseIds, model: "test" }, groups, ["test"])).toThrow();
    expect(() => validateLaunch({ groupId: "missing", model: "test" }, groups, ["test"])).toThrow();
    expect(() =>
      validateLaunch({ groupId: "default-60", model: "unknown" }, groups, ["test"]),
    ).toThrow();
    expect(() =>
      validateLaunch({ groupId: "default-60", model: "test", repeats: 0 }, groups, ["test"]),
    ).toThrow();
  });
  it("launches selected dataset cases and deletes a batch with its artifacts without affecting other runs", async () => {
    const app = await fixture(false, true);
    const submitted = await app.request("/api/dataset/jobs", {
      caseIds: ["CASE-002"],
      model: "test-agent",
    });
    expect(submitted.status).toBe(202);
    const launched = (await submitted.json()) as DatasetJob;
    let completed: DatasetJob | undefined;
    for (let i = 0; i < 100; i++) {
      const jobs = (await (await app.request("/api/dataset/jobs")).json()) as DatasetJob[];
      completed = jobs.find((job) => job.id === launched.id);
      if (completed?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed?.status).toBe("completed");
    expect(completed?.caseIds).toEqual(["CASE-002"]);
    expect(completed?.group).toBeUndefined();
    const savedRecord = await (
      await app.request(`/api/dataset/runs/${completed!.records[0]}`)
    ).json();
    const batchDirectory = path.join(app.root, "evals/runs/dataset", `web-${launched.id}`);
    await mkdir(path.join(batchDirectory, "workspace"), { recursive: true });
    await writeFile(path.join(batchDirectory, "workspace/file.txt"), "artifact");
    const protectedFile = path.join(app.root, "evals/dataset/keep.txt");
    await writeFile(protectedFile, "dataset");
    const elsewhere = path.join(app.root, "evals/runs/dataset/unrelated");
    await mkdir(elsewhere);
    const assigned = await app.request(
      `/api/dataset/runs/${completed!.records[0]}`,
      undefined,
      undefined,
      "DELETE",
    );
    expect(assigned.status).toBe(400);
    const deleted = await app.request(
      `/api/dataset/jobs/${launched.id}`,
      undefined,
      undefined,
      "DELETE",
    );
    expect(deleted.status).toBe(200);
    expect(await stat(batchDirectory).catch(() => null)).toBeNull();
    expect(await readFile(protectedFile, "utf8")).toBe("dataset");
    expect((await stat(elsewhere)).isDirectory()).toBe(true);
    expect(await (await app.request("/api/dataset/runs")).json()).toEqual([]);
    const independentDirectory = path.join(
      app.root,
      "evals/runs/dataset",
      `CASE-002-${randomUUID()}`,
    );
    await mkdir(path.join(independentDirectory, "workspace"), { recursive: true });
    await writeFile(path.join(independentDirectory, "record.json"), JSON.stringify(savedRecord));
    await writeFile(path.join(independentDirectory, "workspace/keep.txt"), "independent artifact");
    const independentKey = Buffer.from(
      path.relative(
        path.join(app.root, "evals/runs/dataset"),
        path.join(independentDirectory, "record.json"),
      ),
    ).toString("base64url");
    expect(
      (await app.request(`/api/dataset/runs/${independentKey}`, undefined, undefined, "DELETE"))
        .status,
    ).toBe(200);
    expect(await stat(independentDirectory).catch(() => null)).toBeNull();
    app.restart();
    expect(await (await app.request("/api/dataset/jobs")).json()).toEqual([]);
    const badKey = Buffer.from("../../dataset/record.json").toString("base64url");
    expect(
      (await app.request(`/api/dataset/runs/${badKey}`, undefined, undefined, "DELETE")).status,
    ).toBe(400);
  });
  it("reports the active case start and rejects deleting a running batch", async () => {
    const app = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = app.options.execute;
    app.options.execute = async (entry, input) => {
      await gate;
      return original(entry, input);
    };
    app.restart();
    const submitted = (await (
      await app.request("/api/dataset/jobs", { caseIds: ["CASE-001"], model: "test-agent" })
    ).json()) as DatasetJob;
    try {
      let active: DatasetJob | undefined;
      for (let i = 0; i < 100; i++) {
        const jobs = (await (await app.request("/api/dataset/jobs")).json()) as DatasetJob[];
        active = jobs.find((job) => job.id === submitted.id);
        if (active?.currentCaseStartedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(active?.currentCase).toBe("CASE-001");
      expect(active?.currentRepetition).toBe(1);
      expect(Number.isFinite(Date.parse(active!.currentCaseStartedAt!))).toBe(true);
      expect(
        (await app.request(`/api/dataset/jobs/${submitted.id}`, undefined, undefined, "DELETE"))
          .status,
      ).toBe(400);
    } finally {
      release();
    }
    for (let i = 0; i < 100; i++) {
      const jobs = (await (await app.request("/api/dataset/jobs")).json()) as DatasetJob[];
      if (jobs.every((job) => job.status === "completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  it("connects launch, persisted records, case-weighted summary, detail and immutable re-evaluation", async () => {
    const app = await fixture();
    const response = await app.request("/api/dataset/jobs", {
      groupId: "default-60",
      model: "test-agent",
      repeats: 2,
    });
    expect(response.status).toBe(202);
    const submitted = await response.json();
    let job: DatasetJob | undefined;
    for (let index = 0; index < 100; index++) {
      job = ((await (await app.request("/api/dataset/jobs")).json()) as DatasetJob[]).find(
        (item) => item.id === submitted.id,
      );
      if (job?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job?.completed).toBe(2);
    expect(job?.group).toEqual({ id: "default-60", name: "完整测评组" });
    expect(job?.startedAt).toBeTruthy();
    expect(
      job?.attempts?.map((attempt) => [attempt.caseId, attempt.repetition, attempt.key]),
    ).toEqual([
      ["CASE-001", 1, job!.records[0]],
      ["CASE-001", 2, job!.records[1]],
    ]);
    expect(job?.summary?.successRate).toBe(1);
    expect(job?.summary?.compositeScore).toBeNull(); // Fixture intentionally has unknown Token telemetry.
    expect(job?.summary?.compositeCoverage.executions[0]?.reasons).toContain(
      "Complete input/output Token totals unavailable",
    );
    expect(job?.summary?.scoringPolicy.version).toBe("composite-v1-token");
    expect(job?.summary?.coverageComplete).toBe(true);
    const before = await (await app.request(`/api/dataset/runs/${job!.records[0]}`)).text();
    const review = await app.request("/api/dataset/reevaluate", {
      key: job!.records[0],
      model: "test-agent",
    });
    expect(review.status).toBe(200);
    expect((await review.json()).process.score).toBe(87.5);
    expect(await (await app.request(`/api/dataset/runs/${job!.records[0]}`)).text()).toBe(before);
    expect(app.executions()).toBe(2);
    const comparison = await app.request("/api/dataset/compare", {
      caseIds: ["CASE-001"],
      agents: { a: job!.records, b: job!.records },
    });
    expect((await comparison.json()).comparable).toBe(false);
    app.restart();
    const reviews = await (await app.request(`/api/dataset/reviews?key=${job!.records[0]}`)).json();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].process.score).toBe(87.5);
    expect(reviews[0].policy.version).toBe("process-v5");
    expect(reviews[0].transcript).toBeUndefined();
    expect((await (await app.request("/api/dataset/jobs")).json())[0].summary.successRate).toBe(1);
    expect(
      (await (await app.request("/api/dataset/jobs")).json())[0].summary.compositeScore,
    ).toBeNull();
  });
  it("prevents cross-origin launches and record path escapes", async () => {
    const app = await fixture();
    expect(
      (
        await app.request(
          "/api/dataset/jobs",
          { groupId: "default-60", model: "test-agent" },
          "https://external.example",
        )
      ).status,
    ).toBe(403);
    const key = Buffer.from("../../outside/record.json").toString("base64url");
    expect((await app.request(`/api/dataset/runs/${key}`)).status).toBe(400);
    expect(app.executions()).toBe(0);
    const tasks = await (await app.request("/api/dataset/tasks")).json();
    expect(tasks[0].case).toEqual({
      id: "CASE-001",
      instruction: "instruction.md",
      environment: { workspace: "workspace", runtime: "test" },
      acceptance: { evaluator: "program", config: "acceptance.json" },
      metadata: { scenario: "bugfix" },
    });
    expect(tasks[0].acceptanceConfig.criteria).toEqual([]);
    expect(tasks[0].instructionOriginal).toBe("Fix a bug");
    const config = await (await app.request("/api/dataset/config")).json();
    expect(config.models).toEqual(["test-agent"]);
    expect(JSON.stringify(config)).not.toContain("apiKey");
  });
  it("marks pending persisted work interrupted after restart without calling models", async () => {
    const app = await fixture(),
      id = randomUUID(),
      directory = path.join(app.root, "evals/runs/dataset/web-jobs");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${id}.json`),
      JSON.stringify({ id, status: "running", caseIds: ["CASE-001"], records: [], errors: [] }),
    );
    app.restart();
    const job = (await (await app.request("/api/dataset/jobs")).json())[0];
    expect(job.status).toBe("interrupted");
    expect(app.executions()).toBe(0);
    expect(JSON.parse(await readFile(path.join(directory, `${id}.json`), "utf8")).status).toBe(
      "interrupted",
    );
  });
});
