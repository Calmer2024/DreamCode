import { cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultFakeProvider, FakeModelProvider, fakeCall } from "@dreamcode/models";
import type { AgentEvent, FinalSummary, ModelProvider } from "@dreamcode/shared";
import { listSessions, readReplayedSession, rollbackSession } from "@dreamcode/store";
import { describe, expect, it } from "vitest";
import { runTurn } from "./index";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("runTurn fake model integration", () => {
  it("fixes the failing-test-js fixture and records evidence", async () => {
    const workspaceRoot = await copyFixture("failing-test-js");
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
    const summary = (completed!.payload as { summary: FinalSummary }).summary;
    expect(summary.changedFiles.map((file) => file.path)).toContain("src/math.js");
    expect(summary.commands[0]?.command).toBe("npm test");
    expect(summary.commands[0]?.exitCode).toBe(0);
    await expect(readFile(summary.eventLogPath, "utf8")).resolves.toContain("tool.completed");
  });

  it("denies secret reads and destructive deletion in the safety fixture", async () => {
    const workspaceRoot = await copyFixture("safety");
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
    const workspaceRoot = await copyFixture("readme-update");
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
          { toolCalls: [fakeCall("file.read", { path: "DREAMCODE_NOTES.md" })] },
          { toolCalls: [fakeCall("file.read", { path: "DREAMCODE_NOTES.md" })] },
          { toolCalls: [fakeCall("file.read", { path: "DREAMCODE_NOTES.md" })] },
          { toolCalls: [fakeCall("file.read", { path: "DREAMCODE_NOTES.md" })] },
        ]),
        mode: "yolo",
        home: await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-")),
      }),
    );

    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed).toBeDefined();
    const summary = (completed!.payload as { summary: FinalSummary }).summary;
    expect(summary.status).toBe("completed");
    expect(summary.message).toContain("repeated post-change inspection");
    expect(summary.changedFiles.map((file) => file.path)).toContain("DREAMCODE_NOTES.md");
  });

  it("resumes an existing session and appends a new turn", async () => {
    const workspaceRoot = await copyFixture("readme-update");
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
          { toolCalls: [fakeCall("file.read", { path: "DREAMCODE_NOTES.md" })] },
          { text: "Final answer: resumed and checked the note." },
        ]),
        mode: "yolo",
        home,
      }),
    );

    expect(secondEvents.some((event) => event.type === "session.resumed")).toBe(true);
    const replayed = await readReplayedSession(sessionId!, home);
    expect(replayed.turns).toHaveLength(2);
    expect(replayed.changedFiles.map((file) => file.path)).toContain("DREAMCODE_NOTES.md");
    const sessions = await listSessions({ home });
    expect(sessions.map((session) => session.id)).toContain(sessionId);
  });

  it("rolls back a changed file from the session snapshots", async () => {
    const workspaceRoot = await copyFixture("readme-update");
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-home-"));
    const readmePath = path.join(workspaceRoot, "README.md");
    const before = await readFile(readmePath, "utf8");
    const events = await collectEvents(
      runTurn({
        prompt: "更新 README。",
        workspaceRoot,
        provider: new FakeModelProvider([
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
    const workspaceRoot = await copyFixture("readme-update");
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
});

async function copyFixture(name: string): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), `dreamcode-${name}-`));
  await cp(path.join(repoRoot, "evals/fixtures", name), workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function collectEvents(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}
