import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSession } from "./index";

describe("JsonlEventLog model delta batching", () => {
  it("merges consecutive model.delta events before persistence", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-event-log-"));
    const { session, eventLog } = await createSession({ workspaceRoot: home, home });

    await eventLog.append({
      id: "evt_1",
      sessionId: session.id,
      turnId: "turn_1",
      type: "model.delta",
      timestamp: "2026-08-20T00:00:00.000Z",
      payload: { text: "First " },
    });
    await eventLog.append({
      id: "evt_2",
      sessionId: session.id,
      turnId: "turn_1",
      type: "model.delta",
      timestamp: "2026-08-20T00:00:00.010Z",
      payload: { text: "reply" },
    });

    const beforeFlush = await readFile(eventLog.filePath, "utf8");
    expect(beforeFlush).toBe("");

    await eventLog.append({
      id: "evt_3",
      sessionId: session.id,
      turnId: "turn_1",
      type: "turn.completed",
      timestamp: "2026-08-20T00:00:00.020Z",
      payload: { summary: { message: "First reply" } },
    });

    const events = await eventLog.readAll();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: "evt_1",
      type: "model.delta",
      payload: { text: "First reply", chunkCount: 2 },
    });
    expect(events[1]?.type).toBe("turn.completed");
  });

  it("does not merge model output across turns", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-event-log-"));
    const { session, eventLog } = await createSession({ workspaceRoot: home, home });

    for (const [id, turnId, text] of [
      ["evt_1", "turn_1", "one"],
      ["evt_2", "turn_2", "two"],
    ] as const) {
      await eventLog.append({
        id,
        sessionId: session.id,
        turnId,
        type: "model.delta",
        timestamp: "2026-08-20T00:00:00.000Z",
        payload: { text },
      });
      await eventLog.append({
        id: `${id}_done`,
        sessionId: session.id,
        turnId,
        type: "turn.completed",
        timestamp: "2026-08-20T00:00:00.010Z",
        payload: { summary: { message: text } },
      });
    }

    const events = await eventLog.readAll();
    expect(events.filter((event) => event.type === "model.delta")).toHaveLength(2);
  });
});
