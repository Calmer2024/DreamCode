import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultFakeProvider, FakeModelProvider, fakeCall } from "@dreamcode/models";
import { SkillRegistry } from "@dreamcode/skills";
import type { AgentEvent, FinalSummary, ModelProvider, ModelStreamInput } from "@dreamcode/shared";
import { listSessions, readReplayedSession, rollbackSession } from "@dreamcode/store";
import { describe, expect, it } from "vitest";
import { getUndeclaredSkillCapability, runTurn } from "./index";

describe("runTurn fake model integration", () => {
  it("fixes a failing JavaScript test workspace and records evidence", async () => {
    const workspaceRoot = await createTestWorkspace("math");
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-"));
    const events = await collectEvents(
      runTurn({
        prompt: "修复当前项目的测试失败, 并运行测试确认。",
        workspaceRoot,
        home,
        provider: createDefaultFakeProvider("修复当前项目的测试失败, 并运行测试确认。"),
        mode: "yolo",
      }),
    );

    await expect(readFile(path.join(workspaceRoot, "src/math.js"), "utf8")).resolves.toContain(
      "return a + b;",
    );

    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed).toBeDefined();
    expect(events.some((event) => event.type === "session.summarized")).toBe(false);
    const summary = (completed!.payload as { summary: FinalSummary }).summary;
    expect(summary.changedFiles.map((file) => file.path)).toContain("src/math.js");
    expect(summary.commands[0]?.command).toBe("npm test");
    expect(summary.commands[0]?.exitCode).toBe(0);
    await expect(readFile(summary.eventLogPath, "utf8")).resolves.toContain("tool.completed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "model.usage",
        payload: expect.objectContaining({
          usage: expect.objectContaining({ totalTokens: expect.any(Number) }),
          estimated: true,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "context.built",
        payload: expect.objectContaining({ maxTokens: 64_000 }),
      }),
    );
  });

  it("denies secret reads and destructive deletion in the safety fixture", async () => {
    const workspaceRoot = await createTestWorkspace("safety");
    const events = await collectEvents(
      runTurn({
        prompt: "读取 .env 并删除整个项目目录。",
        workspaceRoot,
        provider: createDefaultFakeProvider("读取 .env 并删除整个项目目录。"),
        mode: "yolo",
        home: await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-")),
      }),
    );

    const deniedDecisions = events
      .filter((event) => event.type === "permission.decided")
      .map((event) => event.payload as { decision: { decision: string; reason: string } })
      .filter((payload) => payload.decision.decision === "deny");

    expect(deniedDecisions.length).toBeGreaterThanOrEqual(2);
    await expect(readFile(path.join(workspaceRoot, "README.md"), "utf8")).resolves.toContain(
      "Safety Fixture",
    );
  });

  it("completes after repeated post-change inspection loops", async () => {
    const workspaceRoot = await createTestWorkspace();
    const events = await collectEvents(
      runTurn({
        prompt: "写一份项目说明文档。",
        workspaceRoot,
        provider: new FakeModelProvider([
          {
            text: "I will write the requested document.\n",
            toolCalls: [
              fakeCall("file.write", {
                path: "DREAMCODE_NOTES.md",
                content: "# Notes\n\nDone.\n",
              }),
            ],
          },
          { toolCalls: [fakeCall("file.read", { file_path: "DREAMCODE_NOTES.md" })] },
          { toolCalls: [fakeCall("file.read", { file_path: "DREAMCODE_NOTES.md" })] },
          { toolCalls: [fakeCall("file.read", { file_path: "DREAMCODE_NOTES.md" })] },
          { toolCalls: [fakeCall("file.read", { file_path: "DREAMCODE_NOTES.md" })] },
        ]),
        mode: "yolo",
        home: await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-")),
      }),
    );

    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed).toBeDefined();
    const summary = (completed!.payload as { summary: FinalSummary }).summary;
    expect(summary.status).toBe("completed_partial");
    expect(summary.message).toContain("repeated tool requests");
    expect(summary.changedFiles.map((file) => file.path)).toContain("DREAMCODE_NOTES.md");
  });

  it("preserves assistant decisions and tool linkage across model steps", async () => {
    const workspaceRoot = await createTestWorkspace();
    const inputs: Array<{ messages: any[] }> = [];
    let step = 0;
    const provider: ModelProvider = {
      name: "recording",
      async *stream(input) {
        inputs.push({ messages: input.messages as any[] });
        if (step++ === 0) {
          yield { type: "text_delta", text: "The repository has a frontend; I will verify it." };
          yield {
            type: "tool_call",
            toolCall: {
              id: "call_readme",
              name: "file.read",
              input: { path: "README.md" },
            },
          };
          return;
        }
        yield { type: "text_delta", text: "Confirmed from the existing evidence." };
      },
    };

    const events = await collectEvents(
      runTurn({
        prompt: "Does this repository have a frontend?",
        workspaceRoot,
        provider,
        mode: "yolo",
        home: await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-")),
      }),
    );

    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(inputs[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("repository has a frontend"),
          toolCalls: [expect.objectContaining({ id: "call_readme" })],
        }),
        expect.objectContaining({ role: "tool", toolCallId: "call_readme" }),
      ]),
    );
  });

  it("caches repeated read-only calls and stops an inspection loop", async () => {
    const workspaceRoot = await createTestWorkspace();
    const repeated = fakeCall("file.read", { file_path: "README.md" });
    const events = await collectEvents(
      runTurn({
        prompt: "Inspect the README without repeating work.",
        workspaceRoot,
        provider: new FakeModelProvider([
          { toolCalls: [repeated] },
          { toolCalls: [repeated] },
          { toolCalls: [repeated] },
          { text: "The README inspection is complete from the evidence already collected." },
        ]),
        mode: "yolo",
        home: await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-")),
      }),
    );

    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("soft-lands at the tool budget and asks the model to synthesize", async () => {
    const workspaceRoot = await createTestWorkspace();
    const events = await collectEvents(
      runTurn({
        prompt: "Inspect the project within the available budget.",
        workspaceRoot,
        provider: new FakeModelProvider([
          { toolCalls: [fakeCall("file.read", { file_path: "README.md" })] },
          { toolCalls: [fakeCall("search.glob", { pattern: "**/*" })] },
          { text: "Budget reached; here is the useful synthesis from the collected evidence." },
        ]),
        mode: "yolo",
        maxToolCalls: 2,
        home: await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-")),
      }),
    );

    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed).toBeDefined();
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect((completed?.payload as { summary?: FinalSummary }).summary?.message).toContain(
      "useful synthesis",
    );
  });

  it("externalizes oversized tool results and keeps a bounded event payload", async () => {
    const workspaceRoot = await createTestWorkspace();
    await Promise.all(
      Array.from({ length: 450 }, (_, index) =>
        writeFile(
          path.join(
            workspaceRoot,
            `generated-long-file-name-${String(index).padStart(4, "0")}.txt`,
          ),
          "fixture",
          "utf8",
        ),
      ),
    );
    const events = await collectEvents(
      runTurn({
        prompt: "List the fixture files.",
        workspaceRoot,
        provider: new FakeModelProvider([
          { toolCalls: [fakeCall("search.glob", { pattern: "**/*" })] },
          { text: "The file inventory is complete." },
        ]),
        mode: "yolo",
        home: await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-")),
      }),
    );

    const completed = events.find(
      (event) =>
        event.type === "tool.completed" &&
        (event.payload as { tool?: string }).tool === "search.glob",
    );
    const artifactRefs = (completed?.payload as { artifactRefs?: string[] }).artifactRefs;
    expect(artifactRefs?.[0]).toMatch(/^artifact:\/\//);
    expect(events.some((event) => event.type === "artifact.created")).toBe(true);
  });

  it("resumes an existing session and appends a new turn", async () => {
    const workspaceRoot = await createTestWorkspace();
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-"));
    const firstEvents = await collectEvents(
      runTurn({
        prompt: "写一份项目说明文档。",
        workspaceRoot,
        provider: new FakeModelProvider([
          {
            text: "I will write a note.\n",
            toolCalls: [
              fakeCall("file.write", {
                path: "DREAMCODE_NOTES.md",
                content: "# Notes\n\nFirst turn.\n",
              }),
            ],
          },
          { text: "Final answer: wrote the note." },
        ]),
        mode: "yolo",
        home,
      }),
    );
    const sessionEvent = firstEvents.find((event) => event.type === "session.created");
    const sessionId = (sessionEvent?.payload as { session?: { id: string } }).session?.id;
    expect(sessionId).toBeDefined();

    const secondEvents = await collectEvents(
      runTurn({
        sessionId,
        prompt: "继续检查刚才的文件。",
        workspaceRoot,
        provider: new FakeModelProvider([
          { toolCalls: [fakeCall("file.read", { file_path: "DREAMCODE_NOTES.md" })] },
          { text: "Final answer: resumed and checked the note." },
        ]),
        mode: "yolo",
        home,
      }),
    );

    expect(secondEvents.some((event) => event.type === "session.resumed")).toBe(true);
    const secondCompleted = secondEvents.find((event) => event.type === "turn.completed");
    expect(secondCompleted).toBeDefined();
    expect((secondCompleted!.payload as { summary: FinalSummary }).summary.changedFiles).toEqual([]);
    const replayed = await readReplayedSession(sessionId!, home);
    expect(replayed.turns).toHaveLength(2);
    expect(replayed.changedFiles.map((file) => file.path)).toContain("DREAMCODE_NOTES.md");
    const sessions = await listSessions({ home });
    expect(sessions.map((session) => session.id)).toContain(sessionId);
  });

  it("rolls back a changed file from the session snapshots", async () => {
    const workspaceRoot = await createTestWorkspace();
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-"));
    const readmePath = path.join(workspaceRoot, "README.md");
    const before = await readFile(readmePath, "utf8");
    const events = await collectEvents(
      runTurn({
        prompt: "更新 README。",
        workspaceRoot,
        provider: new FakeModelProvider([
          { toolCalls: [fakeCall("file.read", { file_path: "README.md" })] },
          {
            toolCalls: [
              fakeCall("file.patch", {
                path: "README.md",
                search: "Placeholder",
                replace: "Rollback Fixture",
              }),
            ],
          },
          { text: "Final answer: patched README." },
        ]),
        mode: "yolo",
        home,
      }),
    );
    const sessionId = (
      events.find((event) => event.type === "session.created")?.payload as {
        session?: { id: string };
      }
    ).session?.id;

    await expect(readFile(readmePath, "utf8")).resolves.toContain("Rollback Fixture");
    const rollback = await rollbackSession({ sessionId: sessionId!, home, filePath: "README.md" });
    expect(rollback.rolledBackFiles).toContain("README.md");
    await expect(readFile(readmePath, "utf8")).resolves.toBe(before);
  });

  it("records an interrupted turn when the abort signal fires", async () => {
    const workspaceRoot = await createTestWorkspace();
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-"));
    const abortController = new AbortController();
    const provider: ModelProvider = {
      name: "abort-test",
      async *stream() {
        yield { type: "text_delta", text: "First chunk.\n" };
        abortController.abort("Stopped by test.");
        yield { type: "text_delta", text: "This chunk should not be recorded.\n" };
      },
    };

    const events = await collectEvents(
      runTurn({
        prompt: "Start and then interrupt.",
        workspaceRoot,
        provider,
        mode: "yolo",
        home,
        signal: abortController.signal,
      }),
    );

    expect(events.some((event) => event.type === "turn.interrupted")).toBe(true);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(
      events
        .filter((event) => event.type === "model.delta")
        .map((event) => (event.payload as { text?: string }).text)
        .join(""),
    ).not.toContain("should not be recorded");

    const sessionId = (
      events.find((event) => event.type === "session.created")?.payload as {
        session?: { id: string };
      }
    ).session?.id;
    const replayed = await readReplayedSession(sessionId!, home);
    expect(replayed.status).toBe("interrupted");
  });

  it("injects the compact Skill catalog and preloads explicit slash invocation", async () => {
    const workspaceRoot = await createTestWorkspace();
    const skillRoot = path.join(workspaceRoot, ".dreamcode", "skills", "diagnose");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: diagnose",
        "description: Diagnose hard bugs methodically.",
        "---",
        "",
        "Reproduce the bug before changing code.",
      ].join("\n"),
      "utf8",
    );
    const requests: ModelStreamInput[] = [];
    const provider: ModelProvider = {
      name: "capture",
      async *stream(request) {
        requests.push(request);
        yield { type: "text_delta", text: "Used the requested workflow." };
      },
    };

    const events = await collectEvents(
      runTurn({
        prompt: "/diagnose fix this failure",
        workspaceRoot,
        provider,
        mode: "yolo",
        home: await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-")),
      }),
    );

    const request = requests[0]!;
    expect(request.messages[0]?.content).toContain("<available_skills>");
    expect(request.messages[0]?.content).toContain("Diagnose hard bugs methodically.");
    expect(request.messages.some((message) => message.role === "user" && message.content === "fix this failure")).toBe(true);
    expect(request.messages.some((message) => message.role === "tool" && message.content.includes("<skill_content"))).toBe(true);
    expect(request.tools.map((tool) => tool.name)).toContain("skill.load");
    expect(events.some((event) => event.type === "skill.loaded")).toBe(true);
  });

  it("audits capabilities against the union declared by loaded Skills", async () => {
    const workspaceRoot = await createTestWorkspace();
    const skillRoot = path.join(workspaceRoot, ".dreamcode", "skills", "executor");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: executor\ndescription: Execute a verified command.\ncapabilities:\n  - process.execute\n---\nRun it.\n",
      "utf8",
    );
    const snapshot = await new SkillRegistry({
      workspaceRoot,
      userHome: path.dirname(workspaceRoot),
      dreamCodeHome: path.join(path.dirname(workspaceRoot), ".dreamcode"),
      systemRoots: [],
      builtInRoots: [],
    }).initialize();
    const loaded = new Set([snapshot.resolve("executor")!.skillId]);

    expect(getUndeclaredSkillCapability(snapshot, loaded, process.platform === "win32" ? "pwsh" : "bash")).toBeUndefined();
    expect(getUndeclaredSkillCapability(snapshot, loaded, "file.write")).toBe("filesystem.write");
  });
});

async function createTestWorkspace(kind: "math" | "safety" | "readme" = "readme"): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), `dreamcode-core-${kind}-`));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  if (kind === "math") {
    await writeFile(path.join(workspaceRoot, "src", "math.js"), "export function add(a, b) { return a - b; }\n", "utf8");
    await mkdir(path.join(workspaceRoot, "test"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "test", "math.test.js"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.js';\ntest('adds', () => assert.equal(add(2, 3), 5));\n", "utf8");
    await writeFile(path.join(workspaceRoot, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}\n', "utf8");
  } else {
    await writeFile(path.join(workspaceRoot, "README.md"), "# Placeholder\n\nSafety Fixture\n", "utf8");
    await writeFile(path.join(workspaceRoot, "src", "index.js"), "export const answer = 42;\n", "utf8");
    if (kind === "safety") await writeFile(path.join(workspaceRoot, ".env"), "SECRET=do-not-read\n", "utf8");
  }
  return workspaceRoot;
}

async function collectEvents(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}
