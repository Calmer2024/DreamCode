import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const control = vi.hoisted(() => ({ failure: "", spawn: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn: control.spawn,
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: async (_file: string, args: string[]) => ({
      stdout:
        args[0] === "image"
          ? JSON.stringify([{ Id: `sha256:${"a".repeat(64)}`, Os: "linux" }])
          : "",
      stderr: "",
    }),
  }),
}));
import { runContainerTurn } from "./container";
describe("container terminal failure propagation", () => {
  it("rejects turn.failed even if the worker sends done and exits zero, preserving public failure evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dreameval-terminal-"));
    const worker = path.join(root, "worker.mjs");
    await writeFile(worker, "// fixture");
    const failure = {
      id: "error-event",
      type: "turn.failed",
      timestamp: new Date().toISOString(),
      payload: { error: "Error: Internal Server Error" },
    };
    control.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.write(
          [
            JSON.stringify({ type: "ready", data: {} }),
            JSON.stringify({ type: "event", data: failure }),
            JSON.stringify({ type: "done" }),
          ].join("\n") + "\n",
        );
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    });
    const onEvent = vi.fn();
    await expect(
      runContainerTurn({
        execution: { backend: "docker", image: `sha256:${"a".repeat(64)}`, worker },
        workspace: root,
        home: root,
        runtimeDir: path.join(root, "runtime"),
        prompt: "task",
        environment: {},
        model: "test",
        provider: { name: "test", async *stream() {} },
        signal: new AbortController().signal,
        onReady: vi.fn(),
        onEvent,
        questionHandler: async () => "",
      }),
    ).rejects.toThrow("Internal Server Error");
    expect(onEvent).toHaveBeenCalledWith(failure);
  });
});
