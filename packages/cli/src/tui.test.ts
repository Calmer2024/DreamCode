import { PassThrough, Writable } from "node:stream";
import type { DreamCodeConfig } from "@dreamcode/store";
import { render } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";
import {
  buildDreamCodeTranscriptLines,
  DreamCodeTui,
  getComposerCursorPosition,
  getTranscriptViewport,
  type InkTuiInput,
} from "./tui";
import { createInitialTuiState, type TuiState } from "./tui-state";

describe("DreamCode Ink TUI", () => {
  it("keeps the terminal cursor inside the composer while typing", async () => {
    const stdin = createMockStdin();
    const stdout = new CaptureStream({ columns: 82, rows: 28 });
    const stderr = new CaptureStream({ columns: 82, rows: 28 });
    const app = render(React.createElement(DreamCodeTui, createTuiInput()), {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      interactive: true,
      maxFps: 60,
    });

    try {
      await app.waitUntilRenderFlush();
      stdin.write("的");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await app.waitUntilRenderFlush();

      const plain = stripAnsi(stdout.output);
      expect(stdout.output).toContain("DreamCode v0.1.0");
      expect(plain).toContain("█████████████");
      expect(plain).toContain("> 的");
      expect(plain).not.toContain("> 的|");
      expect(stdout.output).toContain(`${String.fromCharCode(27)}[5 q`);
      expect(stdout.output).toContain(`${String.fromCharCode(27)}[?12h`);
      expect(stdout.output).toContain(
        `${String.fromCharCode(27)}]12;#ffffff${String.fromCharCode(7)}`,
      );
      expect(stdout.output).toContain(`${String.fromCharCode(27)}[?25h`);
      expect(stdout.output).toContain(">> yolo mode");
      expect(stdout.output).not.toContain("● idle");
      expect(stdout.output).not.toContain("API Usage Billing");
      expect(stdout.output).not.toContain("bypass permissions on");
      expect(stdout.output).not.toContain("/effort");
      expect(stdout.output).not.toContain("Files / Diff");
      expect(stdout.output).not.toContain("Recent events");
      expect(stdout.output).not.toContain("Tool events will appear here");
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
  });

  it("formats todo, tool, file, and cost state as inline transcript lines", () => {
    const state: TuiState = {
      ...createInitialTuiState({
        version: "0.1.0",
        workspaceRoot: "/repo",
        mode: "yolo",
        provider: "fake",
        model: "default",
        home: "/tmp/dreamcode",
      }),
      status: "completed",
      todos: [
        { content: "Inspect TUI", status: "completed" },
        { content: "Patch composer", status: "in_progress" },
      ],
      changedFiles: [{ path: "packages/cli/src/tui.tsx", operation: "update" }],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0.001,
      },
      timeline: [
        {
          id: "user",
          title: "User message",
          detail: "Fix the TUI",
          tone: "info",
          timestamp: "2026-07-09T00:00:00.000Z",
        },
        {
          id: "tool",
          title: "Tool requested: shell_command",
          detail: '{"command":"pnpm test"}',
          tone: "info",
          timestamp: "2026-07-09T00:00:01.000Z",
        },
        {
          id: "todos",
          title: "Todo updated",
          detail: "2 item(s)",
          tone: "info",
          timestamp: "2026-07-09T00:00:02.000Z",
        },
      ],
    };

    const lines = buildDreamCodeTranscriptLines(state, 20).map((line) => line.text);

    expect(lines.some((line) => line.startsWith("› Fix the TUI"))).toBe(true);
    expect(lines).toContain("* shell_command");
    expect(lines).toContain("* Update Todos");
    expect(lines).toContain("  [x] Inspect TUI");
    expect(lines).toContain("* Files changed");
    expect(lines).toContain("  update packages/cli/src/tui.tsx");
    expect(lines).toContain("✱ Tokens 15 total · 10 in · 5 out · $0.001000");
  });

  it("renders the welcome mascot from the compact pixel grid", () => {
    const state = createInitialTuiState({
      version: "0.1.0",
      workspaceRoot: "/repo",
      mode: "yolo",
      provider: "fake",
      model: "default",
      home: "/tmp/dreamcode",
    });

    const headerLines = buildDreamCodeTranscriptLines(state, 30, { width: 90 }).filter(
      (line) => line.kind === "header",
    );

    expect(headerLines[0]?.text).toContain("   █▄       ▄█");
    expect(headerLines[2]?.text).toContain("  █████████████");
    expect(headerLines[3]?.text).toContain("  ███▀█████▀███");
    expect(headerLines).toHaveLength(9);
  });

  it("does not duplicate final summary markdown when assistant text is rendered", () => {
    const state: TuiState = {
      ...createInitialTuiState({
        version: "0.1.0",
        workspaceRoot: "/repo",
        mode: "yolo",
        provider: "fake",
        model: "default",
        home: "/tmp/dreamcode",
      }),
      status: "completed",
      assistantText: "我是 **DreamCode**，可以帮你写代码。",
      timeline: [
        {
          id: "turn-started",
          title: "Turn started",
          detail: "你是谁？",
          tone: "info",
          timestamp: "2026-07-09T00:00:00.000Z",
        },
        {
          id: "turn-completed",
          title: "Turn completed",
          detail: "我是 **DreamCode**，可以帮你写代码。",
          tone: "success",
          timestamp: "2026-07-09T00:00:03.000Z",
        },
      ],
    };

    const lines = buildDreamCodeTranscriptLines(state, 40, { width: 90 }).map((line) => line.text);
    const renderedSummaryCount = lines.filter((line) => line.includes("我是 DreamCode")).length;

    expect(lines).toContain("✱ Cooked for 3s");
    expect(renderedSummaryCount).toBe(1);
    expect(lines.some((line) => line.includes("Turn completed - 我是"))).toBe(false);
  });

  it("renders complete assistant conversation history without folding old turns", () => {
    const state: TuiState = {
      ...createInitialTuiState({
        version: "0.1.0",
        workspaceRoot: "/repo",
        mode: "yolo",
        provider: "fake",
        model: "default",
        home: "/tmp/dreamcode",
      }),
      status: "completed",
      assistantMessages: [
        {
          id: "assistant-turn-1",
          turnId: "turn_1",
          text: "第一轮完整回答，不能被折叠。",
          status: "completed",
          startedAt: "2026-07-09T00:00:01.000Z",
          updatedAt: "2026-07-09T00:00:02.000Z",
          completedAt: "2026-07-09T00:00:02.000Z",
        },
        {
          id: "assistant-turn-2",
          turnId: "turn_2",
          text: "第二轮完整回答，也必须继续显示。",
          status: "completed",
          startedAt: "2026-07-09T00:00:03.000Z",
          updatedAt: "2026-07-09T00:00:04.000Z",
          completedAt: "2026-07-09T00:00:04.000Z",
        },
      ],
      timeline: [
        {
          id: "user-1",
          title: "User message",
          detail: "第一轮问题",
          tone: "info",
          timestamp: "2026-07-09T00:00:00.000Z",
          turnId: "turn_1",
        },
        {
          id: "done-1",
          title: "Turn completed",
          tone: "success",
          timestamp: "2026-07-09T00:00:02.000Z",
          turnId: "turn_1",
        },
        {
          id: "user-2",
          title: "User message",
          detail: "第二轮问题",
          tone: "info",
          timestamp: "2026-07-09T00:00:03.000Z",
          turnId: "turn_2",
        },
        {
          id: "done-2",
          title: "Turn completed",
          tone: "success",
          timestamp: "2026-07-09T00:00:04.000Z",
          turnId: "turn_2",
        },
      ],
    };

    const lines = buildDreamCodeTranscriptLines(state, Number.POSITIVE_INFINITY, {
      width: 90,
    }).map((line) => line.text);

    expect(lines.some((line) => line.startsWith("› 第一轮问题"))).toBe(true);
    expect(lines).toContain("* 第一轮完整回答，不能被折叠。");
    expect(lines.some((line) => line.startsWith("› 第二轮问题"))).toBe(true);
    expect(lines).toContain("* 第二轮完整回答，也必须继续显示。");
  });

  it("renders assistant markdown as terminal transcript blocks", () => {
    const state: TuiState = {
      ...createInitialTuiState({
        version: "0.1.0",
        workspaceRoot: "/repo",
        mode: "yolo",
        provider: "fake",
        model: "default",
        home: "/tmp/dreamcode",
      }),
      assistantText: [
        "## Plan",
        "",
        "- inspect the TUI",
        "1. patch cursor",
        "",
        "```ts",
        "const ok = true;",
        "```",
        "",
        "Done.",
      ].join("\n"),
    };

    const lines = buildDreamCodeTranscriptLines(state, 30).map((line) => line.text);

    expect(lines).toContain("* Plan");
    expect(lines).toContain("  • inspect the TUI");
    expect(lines).toContain("  1. patch cursor");
    expect(lines).toContain("  ┌─ code ts");
    expect(lines).toContain("  │ const ok = true;");
    expect(lines).toContain("  └─");
    expect(lines).toContain("* Done.");
  });

  it("renders markdown tables as aligned terminal tables", () => {
    const state: TuiState = {
      ...createInitialTuiState({
        version: "0.1.0",
        workspaceRoot: "/repo",
        mode: "yolo",
        provider: "fake",
        model: "default",
        home: "/tmp/dreamcode",
      }),
      assistantText: [
        "| 包名 | 用途 |",
        "| --- | --- |",
        "| packages/core | 核心代理逻辑 |",
        "| packages/models | 模型集成 |",
      ].join("\n"),
    };

    const lines = buildDreamCodeTranscriptLines(state, 30, { width: 80 }).map((line) => line.text);

    expect(lines.some((line) => line.includes("┌") && line.includes("┬"))).toBe(true);
    expect(lines.some((line) => line.includes("包名") && line.includes("用途"))).toBe(true);
    expect(
      lines.some((line) => line.includes("packages/core") && line.includes("核心代理逻辑")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("---"))).toBe(false);
  });

  it("keeps a scrollable transcript viewport without a rendered scrollbar", () => {
    const lines = Array.from({ length: 8 }, (_, index) => ({
      key: `line-${index}`,
      text: `line ${index}`,
      tone: "info" as const,
    }));

    const bottom = getTranscriptViewport(lines, 3, 0);
    const scrolled = getTranscriptViewport(lines, 3, 2);

    expect(bottom.lines.map((line) => line.text)).toEqual(["line 5", "line 6", "line 7"]);
    expect(scrolled.lines.map((line) => line.text)).toEqual(["line 3", "line 4", "line 5"]);
    expect(bottom.canScroll).toBe(true);
  });

  it("surfaces agent activity in the transcript output", () => {
    const state: TuiState = {
      ...createInitialTuiState({
        version: "0.1.0",
        workspaceRoot: "/repo",
        mode: "yolo",
        provider: "fake",
        model: "default",
        home: "/tmp/dreamcode",
      }),
      status: "running",
      tools: [
        {
          id: "call_1",
          name: "shell.run",
          status: "running",
        },
      ],
    };

    const lines = buildDreamCodeTranscriptLines(state, 40, { statusFrame: 1 }).map(
      (line) => line.text,
    );

    expect(lines).toContain("• Using tool... · shell.run");
  });

  it("targets the hardware cursor at the input row for IME composition", () => {
    expect(
      getComposerCursorPosition({
        cursorColumn: 6,
        terminalHeight: 28,
        prompt: "> ",
        suggestions: [],
      }),
    ).toEqual({ x: 9, y: 26 });
  });
});

class CaptureStream extends Writable {
  public readonly chunks: string[] = [];
  public readonly isTTY = true;
  public readonly columns: number;
  public readonly rows: number;

  public constructor(size: { columns: number; rows: number }) {
    super();
    this.columns = size.columns;
    this.rows = size.rows;
  }

  public get output(): string {
    return this.chunks.join("");
  }

  public override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }
}

function stripAnsi(value: string): string {
  const ansiEscape = String.fromCharCode(27);
  return value.replace(new RegExp(`${ansiEscape}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
}

function createMockStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as PassThrough & {
    isRaw?: boolean;
    isTTY: boolean;
    setRawMode: (isRaw: boolean) => PassThrough;
    ref: () => PassThrough;
    unref: () => PassThrough;
  };
  stream.isTTY = true;
  stream.setRawMode = (isRaw: boolean) => {
    stream.isRaw = isRaw;
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream as unknown as NodeJS.ReadStream;
}

function createTuiInput(): InkTuiInput {
  const config: DreamCodeConfig = {
    version: 1,
    profiles: {},
    mcpServers: {},
  };
  return {
    version: "0.1.0",
    config,
    workspaceRoot: "/repo",
    mode: "yolo",
    home: "/tmp/dreamcode",
    maxToolCalls: 1,
    createProvider: () => {
      throw new Error("createProvider should not be called while typing.");
    },
  };
}
