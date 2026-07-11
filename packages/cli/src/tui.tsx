import os from "node:os";
import path from "node:path";
import type { ApprovalRequest } from "@dreamcode/core";
import { runTurn } from "@dreamcode/core";
import type { ModelProvider, RunMode } from "@dreamcode/shared";
import {
  type DreamCodeConfig,
  getDreamCodeHome,
  listSessions,
  readReplayedSession,
  readSessionEvents,
  rollbackSession,
} from "@dreamcode/store";
import { createDefaultToolRegistry } from "@dreamcode/tools";
import {
  Box,
  type Key,
  render,
  Text,
  useApp,
  useCursor,
  useInput,
  useStdout,
  useWindowSize,
} from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addTuiNotice,
  clearTuiOutput,
  createInitialTuiState,
  reduceTuiEvent,
  setTuiDetail,
  setTuiStatus,
  startTuiTurn,
  type TimelineTone,
  type TuiState,
} from "./tui-state.js";

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_BELL = String.fromCharCode(7);
const CURSOR_BLINK_ENABLE = `${ANSI_ESCAPE}[?12h`;
const CURSOR_BLINK_DISABLE = `${ANSI_ESCAPE}[?12l`;
const CURSOR_BLINKING_BAR = `${ANSI_ESCAPE}[5 q`;
const CURSOR_DEFAULT_STYLE = `${ANSI_ESCAPE}[0 q`;
const CURSOR_WHITE = `${ANSI_ESCAPE}]12;#ffffff${ANSI_BELL}`;
const CURSOR_RESET_COLOR = `${ANSI_ESCAPE}]112${ANSI_BELL}`;

export interface InkTuiInput {
  version: string;
  config: DreamCodeConfig;
  workspaceRoot: string;
  mode: RunMode;
  home?: string;
  maxToolCalls: number;
  createProvider: (prompt: string) => { provider: ModelProvider; model?: string };
}

interface PendingApproval {
  tool: string;
  reason: string;
  inputPreview?: string;
  resolve: (approved: boolean) => void;
}

interface PendingQuestion {
  question: string;
  resolve: (answer: string) => void;
}

interface ComposerInput {
  value: string;
  cursor: number;
}

interface InputView {
  text: string;
  cursorColumn: number;
}

export interface TranscriptLine {
  key: string;
  text: string;
  tone: TimelineTone;
  bold?: boolean;
  dimColor?: boolean;
  color?: string;
  backgroundColor?: string;
  kind?: "normal" | "code" | "table" | "rule" | "user" | "header" | "status";
}

export interface TranscriptBuildOptions {
  width?: number;
  statusFrame?: number;
}

export interface TranscriptViewport {
  lines: TranscriptLine[];
  totalLines: number;
  firstLine: number;
  canScroll: boolean;
}

const BRAND_PURPLE = "#a855f7";
const BRAND_PURPLE_LIGHT = "#c084fc";
const USER_BAR_BG = "#343438";
const MUTED = "#9ca3af";
const TEXT = "#f5f3ff";
const BLUE = "#c4b5fd";
const PINK = "#f472b6";
const GREEN = "#6ee7b7";
const YELLOW = "#fbbf24";
const MIN_TRANSCRIPT_WIDTH = 24;
const DEFAULT_TRANSCRIPT_WIDTH = 120;
const STATUS_FRAMES = ["·", "•", "●", "•"];
const SCROLL_LINE_STEP = 5;
const SCROLL_PAGE_OVERLAP = 2;
const DREAMCODE_MASCOT_PIXELS = [
  "...P.........P......",
  "...PP.......PP......",
  "...PPP.....PPP......",
  "...PPPPPPPPPPP......",
  "..PPPPPPPPPPPPP.....",
  "..PPPPPPPPPPPPP.....",
  "..PPPPPPPPPPPPP.....",
  "..PPPKPPPPPKPPP.....",
  "PPPPPKPPPPPKPPPPP.P.",
  "..PPPPPPPPPPPPP...P.",
  "PPPPPPPPPPPPPPPPP.P.",
  "..PPPPPPPPPPPPP...P.",
  "..PPPPPPPPPPPPP..P..",
  "..PPPPPPPPPPPPPPP...",
  "....P.PP...PP.P.....",
  "....P.PP...PP.P.....",
] as const;

export async function runInkTui(input: InkTuiInput): Promise<void> {
  const app = render(React.createElement(DreamCodeTui, input), {
    exitOnCtrlC: false,
    alternateScreen: true,
    maxFps: 24,
  });
  await app.waitUntilExit();
}

export function DreamCodeTui(input: InkTuiInput): React.JSX.Element {
  const { exit } = useApp();
  const size = useWindowSize();
  const [runMode, setRunMode] = useState<RunMode>(input.mode);
  const [inputLine, setInputLine] = useState<ComposerInput>(() => emptyComposerInput());
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusFrame, setStatusFrame] = useState(0);
  const [showTodoStatus, setShowTodoStatus] = useState(false);
  const line = inputLine.value;
  const [state, setState] = useState<TuiState>(() =>
    createInitialTuiState({
      version: input.version,
      workspaceRoot: input.workspaceRoot,
      mode: runMode,
      provider: "auto",
      model: "default",
      home: input.home ?? getDreamCodeHome(),
    }),
  );
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const pendingApprovalRef = useRef<PendingApproval | undefined>(undefined);
  const pendingQuestionRef = useRef<PendingQuestion | undefined>(undefined);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>();
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | undefined>();

  const requestApproval = useCallback((request: ApprovalRequest): Promise<boolean> => {
    return new Promise((resolve) => {
      const pending: PendingApproval = {
        tool: request.toolCall.name,
        reason: request.decision.reason,
        inputPreview: previewJson(request.toolCall.input, 240),
        resolve,
      };
      pendingApprovalRef.current = pending;
      setPendingApproval(pending);
      setState((current) => setTuiStatus(current, "waiting_approval"));
    });
  }, []);

  const requestQuestion = useCallback((question: string): Promise<string> => {
    return new Promise((resolve) => {
      const pending: PendingQuestion = { question, resolve };
      pendingQuestionRef.current = pending;
      setPendingQuestion(pending);
      setInputLine(emptyComposerInput());
      setState((current) => setTuiStatus(current, "waiting_question"));
    });
  }, []);

  const runPrompt = useCallback(
    async (prompt: string, options: { sessionId?: string } = {}) => {
      if (!prompt.trim()) {
        return;
      }
      if (abortRef.current) {
        setState((current) =>
          addTuiNotice(current, {
            title: "A turn is already running",
            body: "Use /interrupt or Ctrl+C before starting another turn.",
            tone: "warning",
          }),
        );
        return;
      }

      const abortController = new AbortController();
      abortRef.current = abortController;
      const effectiveSessionId = options.sessionId ?? sessionIdRef.current;
      setState((current) => startTuiTurn(current, prompt));

      try {
        const { provider, model } = input.createProvider(prompt);
        for await (const event of runTurn({
          sessionId: effectiveSessionId,
          prompt,
          workspaceRoot: input.workspaceRoot,
          provider,
          model,
          mode: runMode,
          home: input.home,
          maxToolCalls: input.maxToolCalls,
          registry: createDefaultToolRegistry({ mcpServers: input.config.mcpServers }),
          signal: abortController.signal,
          approvalHandler: requestApproval,
          questionHandler: requestQuestion,
        })) {
          const payload = event.payload as { session?: { id?: string } };
          if (
            (event.type === "session.created" || event.type === "session.resumed") &&
            payload.session?.id
          ) {
            sessionIdRef.current = payload.session.id;
          }
          setState((current) => reduceTuiEvent(current, event));
        }
      } catch (error) {
        setState((current) =>
          addTuiNotice(current, {
            title: "Turn failed to start",
            body: error instanceof Error ? error.message : String(error),
            tone: "danger",
          }),
        );
      } finally {
        abortRef.current = undefined;
        pendingApprovalRef.current = undefined;
        pendingQuestionRef.current = undefined;
        setPendingApproval(undefined);
        setPendingQuestion(undefined);
      }
    },
    [input, requestApproval, requestQuestion, runMode],
  );

  const cyclePermissionMode = useCallback(() => {
    setRunMode((current) => {
      const next = nextRunMode(current);
      setState((state) => ({
        ...state,
        runtime: {
          ...state.runtime,
          mode: next,
        },
      }));
      return next;
    });
  }, []);

  const suggestions = useMemo(() => slashSuggestions(line), [line]);
  const width = Math.max(size.columns, 60);
  const height = Math.max(size.rows, 24);
  const transcriptHeight = Math.max(
    1,
    height -
      composerHeight({
        pendingApproval: Boolean(pendingApproval),
        pendingQuestion: Boolean(pendingQuestion),
        suggestions,
      }) -
      (showTodoStatus ? todoStatusHeight(state.todos.length) : 0),
  );
  const transcriptWidth = Math.max(MIN_TRANSCRIPT_WIDTH, width - 3);
  const transcriptLines = useMemo(
    () =>
      buildDreamCodeTranscriptLines(state, Number.POSITIVE_INFINITY, {
        width: transcriptWidth,
        statusFrame,
      }),
    [state, transcriptWidth, statusFrame],
  );
  const maxScrollOffset = Math.max(0, transcriptLines.length - transcriptHeight);
  const scrollPageSize = Math.max(1, transcriptHeight - SCROLL_PAGE_OVERLAP);
  const scrollTranscript = useCallback(
    (delta: number) => {
      setScrollOffset((current) => clamp(current + delta, 0, maxScrollOffset));
    },
    [maxScrollOffset],
  );

  useEffect(() => {
    setScrollOffset((current) => clamp(current, 0, maxScrollOffset));
  }, [maxScrollOffset]);

  useEffect(() => {
    if (!isLiveRunStatus(state.status)) {
      setStatusFrame(0);
      return;
    }
    const timer = setInterval(() => {
      setStatusFrame((current) => (current + 1) % STATUS_FRAMES.length);
    }, 180);
    return () => clearInterval(timer);
  }, [state.status]);

  const interruptTurn = useCallback(() => {
    if (!abortRef.current) {
      setState((current) =>
        addTuiNotice(current, {
          title: "Nothing is running",
          body: "Type a goal to start a new DreamCode turn.",
          tone: "muted",
        }),
      );
      return;
    }
    pendingApprovalRef.current?.resolve(false);
    pendingQuestionRef.current?.resolve("");
    abortRef.current.abort("Interrupted from Ink TUI.");
    setPendingApproval(undefined);
    setPendingQuestion(undefined);
    setState((current) =>
      addTuiNotice(setTuiStatus(current, "interrupted"), {
        title: "Interrupt requested",
        body: "DreamCode will stop at the next safe checkpoint.",
        tone: "warning",
      }),
    );
  }, []);

  const submit = useCallback(async () => {
    const value = line.trim();
    if (pendingQuestionRef.current) {
      const pending = pendingQuestionRef.current;
      pending.resolve(value);
      pendingQuestionRef.current = undefined;
      setPendingQuestion(undefined);
      setState((current) => setTuiStatus(current, "running"));
      setInputLine(emptyComposerInput());
      return;
    }

    if (!value) {
      return;
    }
    setInputLine(emptyComposerInput());
    setScrollOffset(0);
    if (value.startsWith("/")) {
      await handleSlashCommand({
        line: value,
        state,
        setState,
        runPrompt,
        interruptTurn,
        exit,
        home: input.home,
        workspaceRoot: input.workspaceRoot,
        config: input.config,
        mode: runMode,
        sessionIdRef,
      });
      return;
    }
    await runPrompt(value);
  }, [line, state, runPrompt, interruptTurn, exit, input, runMode]);

  useInput(
    (value: string, key: Key) => {
      if (key.pageUp || (key.ctrl && value.toLowerCase() === "u")) {
        scrollTranscript(scrollPageSize);
        return;
      }

      if (key.pageDown || (key.ctrl && value.toLowerCase() === "d")) {
        scrollTranscript(-scrollPageSize);
        return;
      }

      if (pendingApprovalRef.current) {
        const normalized = value.toLowerCase();
        if (normalized === "y" || normalized === "a") {
          pendingApprovalRef.current.resolve(true);
          pendingApprovalRef.current = undefined;
          setPendingApproval(undefined);
          setState((current) => setTuiStatus(current, "running"));
          return;
        }
        if (normalized === "n" || normalized === "d" || key.escape) {
          pendingApprovalRef.current.resolve(false);
          pendingApprovalRef.current = undefined;
          setPendingApproval(undefined);
          setState((current) => setTuiStatus(current, "running"));
          return;
        }
        if (!(key.ctrl && normalized === "c")) {
          return;
        }
      }

      if (key.ctrl && value.toLowerCase() === "c") {
        if (abortRef.current) {
          interruptTurn();
        } else {
          exit();
        }
        return;
      }

      if (key.ctrl && value.toLowerCase() === "l") {
        setState((current) => clearTuiOutput(current));
        return;
      }

      if (key.ctrl && value.toLowerCase() === "t") {
        setShowTodoStatus((current) => !current);
        return;
      }

      if (key.ctrl && value.toLowerCase() === "o") {
        setState((current) =>
          current.detail?.title === "Transcript"
            ? setTuiDetail(current, undefined)
            : setTuiDetail(current, {
                title: "Transcript",
                body: buildDreamCodeTranscriptLines(
                  { ...current, detail: undefined },
                  Number.POSITIVE_INFINITY,
                )
                  .map((line) => line.text)
                  .join("\n"),
                tone: "info",
              }),
        );
        return;
      }

      if (key.shift && key.tab) {
        cyclePermissionMode();
        return;
      }

      if (key.upArrow && !line) {
        scrollTranscript(SCROLL_LINE_STEP);
        return;
      }

      if (key.downArrow && !line) {
        scrollTranscript(-SCROLL_LINE_STEP);
        return;
      }

      if (key.return) {
        void submit();
        return;
      }

      if (key.backspace || key.delete) {
        setInputLine((current) =>
          key.delete ? deleteAtCursor(current) : deleteBeforeCursor(current),
        );
        return;
      }

      if (key.escape) {
        setInputLine(emptyComposerInput());
        setState((current) => setTuiDetail(current, undefined));
        return;
      }

      if (key.tab) {
        setInputLine((current) => lineToComposerInput(completeSlash(current.value)));
        return;
      }

      if (key.leftArrow) {
        setInputLine((current) => moveCursor(current, -1));
        return;
      }

      if (key.rightArrow) {
        setInputLine((current) => moveCursor(current, 1));
        return;
      }

      if (key.home) {
        if (!line) {
          setScrollOffset(maxScrollOffset);
          return;
        }
        setInputLine((current) => ({ ...current, cursor: 0 }));
        return;
      }

      if (key.end) {
        if (!line) {
          setScrollOffset(0);
          return;
        }
        setInputLine((current) => ({ ...current, cursor: countCharacters(current.value) }));
        return;
      }

      if (
        !key.ctrl &&
        !key.meta &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow &&
        value
      ) {
        setInputLine((current) => insertAtCursor(current, value));
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        <DreamCodeTranscript
          lines={transcriptLines}
          height={transcriptHeight}
          scrollOffset={scrollOffset}
        />
      </Box>
      {showTodoStatus && state.todos.length ? <TodoStatus todos={state.todos} /> : null}
      <Composer
        state={state}
        line={line}
        cursor={inputLine.cursor}
        terminalWidth={width}
        terminalHeight={height}
        suggestions={suggestions}
        pendingApproval={pendingApproval}
        pendingQuestion={pendingQuestion}
      />
    </Box>
  );
}

function DreamCodeTranscript({
  lines,
  height,
  scrollOffset,
}: {
  lines: TranscriptLine[];
  height: number;
  scrollOffset: number;
}): React.JSX.Element {
  const viewport = getTranscriptViewport(lines, height, scrollOffset);
  return (
    <Box flexDirection="column" height={height}>
      {viewport.lines.map((line) => (
        <Text
          key={line.key}
          color={line.color ?? toneColor(line.tone)}
          backgroundColor={line.backgroundColor}
          bold={line.bold}
          dimColor={line.dimColor}
          wrap="truncate"
        >
          {line.text || " "}
        </Text>
      ))}
    </Box>
  );
}

export function getTranscriptViewport(
  lines: TranscriptLine[],
  height: number,
  scrollOffset: number,
): TranscriptViewport {
  const safeHeight = Math.max(1, height);
  const maxScroll = Math.max(0, lines.length - safeHeight);
  const boundedOffset = clamp(scrollOffset, 0, maxScroll);
  const firstLine = Math.max(0, lines.length - safeHeight - boundedOffset);
  const visibleLines = lines.slice(firstLine, firstLine + safeHeight);

  return {
    lines: visibleLines,
    totalLines: lines.length,
    firstLine,
    canScroll: maxScroll > 0,
  };
}

function TodoStatus({ todos }: { todos: TuiState["todos"] }): React.JSX.Element {
  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color={BLUE} bold>
        * Todos
      </Text>
      {todos.slice(0, 6).map((todo) => (
        <Text key={`${todo.status}-${todo.content}`} color={todoColor(todo.status)} wrap="truncate">
          {todoCheckbox(todo.status)} {todo.content}
        </Text>
      ))}
    </Box>
  );
}

export function buildDreamCodeTranscriptLines(
  state: TuiState,
  maxLines: number,
  options: TranscriptBuildOptions = {},
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const width = Math.max(MIN_TRANSCRIPT_WIDTH, options.width ?? DEFAULT_TRANSCRIPT_WIDTH);
  const push = (
    text: string,
    tone: TimelineTone = "muted",
    key = `${lines.length}`,
    lineOptions: {
      bold?: boolean;
      dimColor?: boolean;
      color?: string;
      backgroundColor?: string;
      kind?: TranscriptLine["kind"];
    } = {},
  ) => {
    lines.push({
      key: `${key}-${hashKey(text)}`,
      text,
      tone,
      bold: lineOptions.bold,
      dimColor: lineOptions.dimColor,
      color: lineOptions.color,
      backgroundColor: lineOptions.backgroundColor,
      kind: lineOptions.kind,
    });
  };

  if (state.detail) {
    push(`* ${state.detail.title}`, state.detail.tone ?? "info", "detail-title");
    for (const [index, line] of state.detail.body.split(/\r?\n/).entries()) {
      push(`  ${line}`, "muted", `detail-${index}`);
    }
    return tailLines(layoutTranscriptLines(lines, width), maxLines);
  }

  for (const line of buildWelcomeTranscriptLines(state, width)) {
    push(line.text, line.tone, line.key, {
      bold: line.bold,
      color: line.color,
      kind: line.kind,
    });
  }

  const assistantMessages = assistantMessagesForRender(state);
  const renderedAssistantMessageIds = new Set<string>();
  const pushAssistantMessage = (message: (typeof assistantMessages)[number]) => {
    if (renderedAssistantMessageIds.has(message.id) || !message.text.trim()) {
      return;
    }
    renderedAssistantMessageIds.add(message.id);
    push("", "muted", `${message.id}-gap`);
    for (const line of renderAssistantTranscriptLines(message.text, width)) {
      push(line.text, line.tone, `${message.id}-${line.key}`, {
        bold: line.bold,
        kind: line.kind,
      });
    }
  };

  for (const entry of state.timeline) {
    if (entry.id === "welcome") {
      continue;
    }
    if (entry.title === "User message") {
      push(`› ${entry.detail ?? ""}`, "info", entry.id, {
        backgroundColor: USER_BAR_BG,
        bold: true,
        color: TEXT,
        kind: "user",
      });
      continue;
    }
    if (
      entry.title === "Turn started" ||
      entry.title === "Model started" ||
      entry.title === "Session created"
    ) {
      continue;
    }
    if (entry.title.startsWith("Tool requested:")) {
      push(`* ${entry.title.replace("Tool requested: ", "")}`, "info", entry.id);
      if (entry.detail) {
        push(`  Input: ${entry.detail}`, "muted", `${entry.id}-input`);
      }
      continue;
    }
    if (entry.title.startsWith("Running ")) {
      push(`  Running ${entry.title.replace("Running ", "")}...`, "muted", entry.id);
      continue;
    }
    if (entry.title.includes(" success") || entry.title.includes(" error")) {
      push(`  ${entry.title}${entry.detail ? ` - ${entry.detail}` : ""}`, entry.tone, entry.id);
      continue;
    }
    if (entry.title === "Todo updated") {
      push("* Update Todos", "info", entry.id);
      for (const [index, todo] of state.todos.entries()) {
        push(
          `  ${todoCheckbox(todo.status)} ${todo.content}`,
          todoTone(todo.status),
          `${entry.id}-${index}`,
        );
      }
      continue;
    }
    if (
      entry.title.startsWith("update ") ||
      entry.title.startsWith("create ") ||
      entry.title.startsWith("delete ")
    ) {
      push(`* ${entry.title}`, "warning", entry.id);
      continue;
    }
    if (
      entry.title === "Turn completed" ||
      entry.title === "Turn failed" ||
      entry.title === "Turn interrupted"
    ) {
      push(formatTurnStatusLine(state, entry.title, entry.detail), entry.tone, entry.id, {
        color: entry.title === "Turn completed" ? MUTED : undefined,
        kind: "status",
      });
      const assistantMessage = findAssistantMessageForTurn(assistantMessages, entry.turnId);
      if (assistantMessage) {
        pushAssistantMessage(assistantMessage);
      }
      continue;
    }
    push(`* ${entry.title}${entry.detail ? ` - ${entry.detail}` : ""}`, entry.tone, entry.id);
  }

  if (isLiveRunStatus(state.status)) {
    push(formatLiveActivityLine(state, options.statusFrame ?? 0), "info", "live-activity", {
      color: BRAND_PURPLE_LIGHT,
      kind: "status",
    });
  }

  for (const assistantMessage of assistantMessages) {
    pushAssistantMessage(assistantMessage);
  }

  if (state.changedFiles.length) {
    push("", "muted", "files-gap");
    push("* Files changed", "warning", "files-title");
    for (const [index, file] of state.changedFiles.slice(-6).entries()) {
      push(`  ${file.operation.padEnd(6)} ${file.path}`, "warning", `file-${index}`);
    }
  }

  if (state.usage.totalTokens > 0 && state.status !== "running") {
    push("", "muted", "cost-gap");
    push(formatTokenUsage(state), "success", "cost", { kind: "status" });
  }

  return tailLines(layoutTranscriptLines(lines, width), maxLines);
}

function assistantMessagesForRender(state: TuiState): TuiState["assistantMessages"] {
  return state.assistantMessages.length
    ? state.assistantMessages
    : state.assistantText.trim()
      ? [
          {
            id: "assistant-current",
            turnId: state.turnId,
            text: state.assistantText,
            status: isLiveRunStatus(state.status) ? "streaming" : "completed",
            startedAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ]
      : [];
}

function findAssistantMessageForTurn(
  messages: TuiState["assistantMessages"],
  turnId: string | undefined,
): TuiState["assistantMessages"][number] | undefined {
  if (!turnId) {
    return undefined;
  }
  return messages.find((message) => message.turnId === turnId);
}

function buildWelcomeTranscriptLines(state: TuiState, width: number): TranscriptLine[] {
  const logoLines = renderMascotRows(DREAMCODE_MASCOT_PIXELS);
  const logoWidth = Math.max(...logoLines.map(displayWidth));
  const infoGap = width >= 72 ? "  " : "";
  const infoLines = [
    `DreamCode v${state.runtime.version}`,
    formatRuntimeSummary(state),
    formatWorkspaceRoot(state.runtime.workspaceRoot),
  ];
  const canPlaceInfoBesideLogo = width >= logoWidth + 2 + 26;

  const lines = logoLines.map((logoLine, index): TranscriptLine => {
    const info = canPlaceInfoBesideLogo ? (infoLines[index] ?? "") : "";
    return {
      key: `header-${index}-${hashKey(logoLine)}`,
      text: `${logoLine}${info ? `${infoGap}${info}` : ""}`,
      tone: index === 0 ? "info" : "muted",
      bold: index === 0,
      color: BRAND_PURPLE,
      kind: "header",
    };
  });

  if (!canPlaceInfoBesideLogo) {
    for (const [index, info] of infoLines.entries()) {
      lines.push({
        key: `header-info-${index}-${hashKey(info)}`,
        text: info,
        tone: index === 0 ? "info" : "muted",
        bold: index === 0,
        color: index === 0 ? BRAND_PURPLE_LIGHT : MUTED,
        kind: "header",
      });
    }
  }

  lines.push({
    key: "header-gap",
    text: "",
    tone: "muted",
    kind: "header",
  });

  return lines;
}

function renderMascotRows(rows: readonly string[]): string[] {
  const width = Math.max(...rows.map((row) => row.length));
  const lines: string[] = [];

  // Pair source rows into half-blocks so the 20x16 mascot stays compact in terminal chrome.
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 2) {
    const upper = rows[rowIndex] ?? "";
    const lower = rows[rowIndex + 1] ?? "";
    let line = "";

    for (let column = 0; column < width; column += 1) {
      const upperFilled = upper[column] === "P";
      const lowerFilled = lower[column] === "P";

      if (upperFilled && lowerFilled) {
        line += "█";
      } else if (upperFilled) {
        line += "▀";
      } else if (lowerFilled) {
        line += "▄";
      } else {
        line += " ";
      }
    }

    lines.push(line);
  }

  return lines;
}

function formatTurnStatusLine(state: TuiState, title: string, detail: string | undefined): string {
  if (title === "Turn completed") {
    return `✱ Cooked${formatDurationSuffix(state)}${formatTokenSuffix(state)}`;
  }
  if (title === "Turn interrupted") {
    return `✱ Interrupted${detail ? ` · ${detail}` : ""}`;
  }
  return `✱ Failed${detail ? ` · ${detail}` : ""}`;
}

function formatLiveActivityLine(state: TuiState, frame: number): string {
  const activity = deriveAgentActivity(state);
  const marker = STATUS_FRAMES[frame % STATUS_FRAMES.length] ?? "·";
  const detail = activity.detail ? ` · ${activity.detail}` : "";
  return `${marker} ${capitalize(activity.label)}...${detail}${formatTokenSuffix(state)}`;
}

function formatTokenUsage(state: TuiState): string {
  return `✱ Tokens ${state.usage.totalTokens} total · ${state.usage.inputTokens} in · ${state.usage.outputTokens} out · $${state.usage.costUsd.toFixed(6)}`;
}

function formatTokenSuffix(state: TuiState): string {
  return state.usage.totalTokens > 0 ? ` · ↓ ${state.usage.totalTokens} tokens` : "";
}

function formatDurationSuffix(state: TuiState): string {
  const startedAt = state.timeline.find((entry) => entry.title === "Turn started")?.timestamp;
  const endedAt = [...state.timeline]
    .reverse()
    .find(
      (entry) =>
        entry.title === "Turn completed" ||
        entry.title === "Turn failed" ||
        entry.title === "Turn interrupted",
    )?.timestamp;
  if (!startedAt || !endedAt) {
    return "";
  }
  const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "";
  }
  return ` for ${Math.max(1, Math.round(durationMs / 1000))}s`;
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function renderAssistantTranscriptLines(text: string, width: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let inCodeBlock = false;
  let codeLanguage = "";
  let paragraphOpen = false;

  const push = (
    text: string,
    tone: TimelineTone = "info",
    key = `${lines.length}`,
    options: { bold?: boolean; kind?: TranscriptLine["kind"] } = {},
  ) => {
    lines.push({
      key: `assistant-${key}-${hashKey(text)}`,
      text,
      tone,
      bold: options.bold,
      kind: options.kind,
    });
  };

  const sourceLines = text.split(/\r?\n/);
  for (let index = 0; index < sourceLines.length; index += 1) {
    const rawLine = sourceLines[index] ?? "";
    const line = rawLine.replace(/\s+$/u, "");
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        push("  └─", "muted", `code-end-${index}`, { kind: "code" });
        inCodeBlock = false;
        codeLanguage = "";
        paragraphOpen = false;
      } else {
        codeLanguage = trimmed.slice(3).trim();
        push(`  ┌─ code${codeLanguage ? ` ${codeLanguage}` : ""}`, "muted", `code-start-${index}`, {
          kind: "code",
        });
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      push(`  │ ${line || " "}`, "muted", `code-${index}`, { kind: "code" });
      continue;
    }

    const table = readMarkdownTable(sourceLines, index);
    if (table) {
      for (const rendered of renderMarkdownTable(table, width)) {
        push(rendered, "info", `table-${index}-${lines.length}`, { kind: "table" });
      }
      index += table.rawLineCount - 1;
      paragraphOpen = false;
      continue;
    }

    if (!trimmed) {
      if (lines.length && lines.at(-1)?.text) {
        push("", "muted", `blank-${index}`);
      }
      paragraphOpen = false;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(trimmed);
    if (heading) {
      push(`* ${stripInlineMarkdown(heading[2] ?? "")}`, "info", `heading-${index}`, {
        bold: true,
      });
      paragraphOpen = false;
      continue;
    }

    const unordered = /^[-*+]\s+(.+)$/u.exec(trimmed);
    if (unordered) {
      push(`  • ${stripInlineMarkdown(unordered[1] ?? "")}`, "info", `bullet-${index}`);
      paragraphOpen = false;
      continue;
    }

    const ordered = /^(\d+)[.)]\s+(.+)$/u.exec(trimmed);
    if (ordered) {
      push(`  ${ordered[1]}. ${stripInlineMarkdown(ordered[2] ?? "")}`, "info", `ordered-${index}`);
      paragraphOpen = false;
      continue;
    }

    const quote = /^>\s?(.+)$/u.exec(trimmed);
    if (quote) {
      push(`  │ ${stripInlineMarkdown(quote[1] ?? "")}`, "muted", `quote-${index}`);
      paragraphOpen = false;
      continue;
    }

    push(`${paragraphOpen ? "  " : "* "}${stripInlineMarkdown(trimmed)}`, "info", `text-${index}`);
    paragraphOpen = true;
  }

  if (inCodeBlock) {
    push("  └─", "muted", "code-end-eof", { kind: "code" });
  }

  return trimTrailingBlankTranscriptLines(lines);
}

interface MarkdownTable {
  headers: string[];
  rows: string[][];
  rawLineCount: number;
}

function readMarkdownTable(lines: string[], startIndex: number): MarkdownTable | undefined {
  const header = parseMarkdownTableRow(lines[startIndex] ?? "");
  const separator = parseMarkdownTableSeparator(lines[startIndex + 1] ?? "");
  if (!header || !separator || header.length < 2) {
    return undefined;
  }

  const columnCount = Math.max(header.length, separator.length);
  const rows: string[][] = [];
  let index = startIndex + 2;
  for (; index < lines.length; index += 1) {
    const row = parseMarkdownTableRow(lines[index] ?? "");
    if (!row) {
      break;
    }
    rows.push(normalizeTableRow(row, columnCount));
  }

  return {
    headers: normalizeTableRow(header, columnCount),
    rows,
    rawLineCount: index - startIndex,
  };
}

function parseMarkdownTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || /^[-:\s|]+$/u.test(trimmed)) {
    return undefined;
  }
  return trimmed
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => stripInlineMarkdown(cell.trim()));
}

function parseMarkdownTableSeparator(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return undefined;
  }
  const cells = trimmed
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell)) ? cells : undefined;
}

function normalizeTableRow(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

function renderMarkdownTable(table: MarkdownTable, width: number): string[] {
  const columnWidths = tableColumnWidths(table, width);
  const top = `  ┌${columnWidths.map((columnWidth) => "─".repeat(columnWidth + 2)).join("┬")}┐`;
  const divider = `  ├${columnWidths.map((columnWidth) => "─".repeat(columnWidth + 2)).join("┼")}┤`;
  const bottom = `  └${columnWidths.map((columnWidth) => "─".repeat(columnWidth + 2)).join("┴")}┘`;
  const renderRow = (cells: string[]): string =>
    `  │ ${cells
      .map((cell, index) =>
        padRightDisplay(
          truncateToDisplayWidth(cell, columnWidths[index] ?? 3),
          columnWidths[index] ?? 3,
        ),
      )
      .join(" │ ")} │`;

  return [top, renderRow(table.headers), divider, ...table.rows.map(renderRow), bottom];
}

function tableColumnWidths(table: MarkdownTable, width: number): number[] {
  const columnCount = table.headers.length;
  const minColumnWidth = 3;
  const availableColumnWidth = Math.max(
    columnCount * minColumnWidth,
    width - 2 - (3 * columnCount + 1),
  );
  const naturalWidths = table.headers.map((header, index) =>
    Math.max(
      minColumnWidth,
      displayWidth(header),
      ...table.rows.map((row) => displayWidth(row[index] ?? "")),
    ),
  );
  const widths = [...naturalWidths];

  while (sumNumbers(widths) > availableColumnWidth) {
    const widestIndex = widestShrinkableColumn(widths, minColumnWidth);
    if (widestIndex === -1) {
      break;
    }
    widths[widestIndex] = (widths[widestIndex] ?? minColumnWidth) - 1;
  }

  return widths;
}

function widestShrinkableColumn(widths: number[], minWidth: number): number {
  let widestIndex = -1;
  let widestWidth = minWidth;
  for (const [index, width] of widths.entries()) {
    if (width > widestWidth) {
      widestIndex = index;
      widestWidth = width;
    }
  }
  return widestIndex;
}

function layoutTranscriptLines(lines: TranscriptLine[], width: number): TranscriptLine[] {
  const safeWidth = Math.max(MIN_TRANSCRIPT_WIDTH, width);
  return lines.flatMap((line) => {
    if (!line.text) {
      return [line];
    }
    if (line.kind === "user") {
      return [
        {
          ...line,
          text: padRightDisplay(truncateToDisplayWidth(line.text, safeWidth), safeWidth),
        },
      ];
    }
    if (line.kind === "code" || line.kind === "table" || line.kind === "rule") {
      return [
        {
          ...line,
          text: truncateToDisplayWidth(line.text, safeWidth),
        },
      ];
    }

    return wrapByDisplayWidth(line.text, safeWidth, continuationIndent(line.text)).map(
      (text, index) => ({
        ...line,
        key: index === 0 ? line.key : `${line.key}-wrap-${index}`,
        text,
      }),
    );
  });
}

function wrapByDisplayWidth(text: string, width: number, indent: string): string[] {
  if (displayWidth(text) <= width) {
    return [text];
  }

  const lines: string[] = [];
  let current = "";
  for (const character of Array.from(text)) {
    const nextWidth = displayWidth(character);
    if (current && displayWidth(current) + nextWidth > width) {
      lines.push(current.trimEnd());
      current = indent;
    }
    current += character;
  }
  if (current) {
    lines.push(current.trimEnd());
  }
  return lines.length ? lines : [""];
}

function continuationIndent(text: string): string {
  if (text.startsWith("  ")) {
    return "  ";
  }
  if (text.startsWith("* ") || text.startsWith("> ")) {
    return "  ";
  }
  return "";
}

function truncateToDisplayWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) {
    return text;
  }
  if (width <= 1) {
    return "…".slice(0, Math.max(0, width));
  }

  let output = "";
  let currentWidth = 0;
  const ellipsisWidth = displayWidth("…");
  for (const character of Array.from(text)) {
    const nextWidth = displayWidth(character);
    if (currentWidth + nextWidth + ellipsisWidth > width) {
      break;
    }
    output += character;
    currentWidth += nextWidth;
  }
  return `${output}…`;
}

function padRightDisplay(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/_([^_]+)_/gu, "$1")
    .trim();
}

function trimTrailingBlankTranscriptLines(lines: TranscriptLine[]): TranscriptLine[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.text) {
    end -= 1;
  }
  return lines.slice(0, end);
}

function Composer({
  state,
  line,
  cursor,
  terminalWidth,
  terminalHeight,
  suggestions,
  pendingApproval,
  pendingQuestion,
}: {
  state: TuiState;
  line: string;
  cursor: number;
  terminalWidth: number;
  terminalHeight: number;
  suggestions: string[];
  pendingApproval?: PendingApproval;
  pendingQuestion?: PendingQuestion;
}): React.JSX.Element {
  const prompt = pendingQuestion ? "? " : "> ";
  const inputContentWidth = Math.max(1, terminalWidth - 3);
  const inputView = createInputView(
    line,
    cursor,
    Math.max(0, inputContentWidth - displayWidth(prompt)),
  );
  const { setCursorPosition } = useCursor();
  useTerminalCursorStyle(!pendingApproval);
  setCursorPosition(
    pendingApproval
      ? undefined
      : getComposerCursorPosition({
          cursorColumn: inputView.cursorColumn,
          terminalHeight,
          prompt,
          suggestions,
          pendingQuestion,
        }),
  );

  return (
    <Box flexDirection="column" flexShrink={0}>
      {pendingApproval ? <ApprovalPrompt pendingApproval={pendingApproval} /> : null}
      {pendingQuestion ? (
        <Text color={BLUE} wrap="truncate">
          ? {pendingQuestion.question}
        </Text>
      ) : null}
      {suggestions.length ? (
        <Box>
          {suggestions.map((suggestion) => (
            <Text key={suggestion} color={BLUE} wrap="truncate">
              {suggestion}{" "}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text color={MUTED} wrap="truncate">
        {horizontalRule(terminalWidth)}
      </Text>
      <Text color={state.status === "running" ? BRAND_PURPLE_LIGHT : TEXT} wrap="truncate">
        {prompt}
        {inputView.text}
      </Text>
      <Text color={MUTED} wrap="truncate">
        {horizontalRule(terminalWidth)}
      </Text>
      <Text wrap="truncate">
        <Text color={PINK} bold>
          &gt;&gt; {state.runtime.mode} mode
        </Text>
        <Text color={MUTED}> (shift+tab to cycle)</Text>
      </Text>
    </Box>
  );
}

function ApprovalPrompt({
  pendingApproval,
}: {
  pendingApproval: PendingApproval;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={PINK} bold wrap="truncate">
        * Permission required: {pendingApproval.tool}
      </Text>
      <Text color={TEXT} wrap="truncate">
        {pendingApproval.reason}
      </Text>
      {pendingApproval.inputPreview ? (
        <Text color={MUTED} wrap="truncate">
          {pendingApproval.inputPreview}
        </Text>
      ) : null}
      <Text color={MUTED}>Press y/a to allow, n/d/Esc to deny.</Text>
    </Box>
  );
}

async function handleSlashCommand(input: {
  line: string;
  state: TuiState;
  setState: React.Dispatch<React.SetStateAction<TuiState>>;
  runPrompt: (prompt: string, options?: { sessionId?: string }) => Promise<void>;
  interruptTurn: () => void;
  exit: (error?: Error) => void;
  home?: string;
  workspaceRoot: string;
  config: DreamCodeConfig;
  mode: RunMode;
  sessionIdRef: React.MutableRefObject<string | undefined>;
}): Promise<void> {
  const [command = "", ...args] = input.line.slice(1).trim().split(/\s+/);
  switch (command.toLowerCase()) {
    case "exit":
    case "quit":
    case "q":
      input.exit();
      return;
    case "help":
    case "?":
      input.setState((current) =>
        setTuiDetail(current, {
          title: "Slash commands",
          body: [
            "/sessions - list recent sessions",
            "/resume <session-id> [prompt] - resume a session",
            "/new - start a fresh session",
            "/diff [session-id] [file] - show recorded diff",
            "/rollback <session-id> --file <path> | --all - restore snapshots",
            "/skills - list local skills",
            "/mcp - list configured MCP servers/tools",
            "/status - show current activity, model, cost, and files",
            "/tools - show recent tool calls",
            "/cost - show token and cost summary",
            "/interrupt - stop current turn",
            "/clear - clear transcript and recent event panel",
            "/exit - leave TUI",
          ].join("\n"),
          tone: "info",
        }),
      );
      return;
    case "interrupt":
      input.interruptTurn();
      return;
    case "clear":
      input.setState((current) => clearTuiOutput(current));
      return;
    case "new":
      input.sessionIdRef.current = undefined;
      input.setState((current) =>
        addTuiNotice(
          {
            ...current,
            sessionId: undefined,
            turnId: undefined,
            sessionDir: undefined,
            status: "idle",
          },
          {
            title: "Started a fresh session",
            tone: "success",
          },
        ),
      );
      return;
    case "sessions":
      await showSessions(input);
      return;
    case "resume":
      await resumeSession(input, args);
      return;
    case "diff":
      await showDiff(input, args);
      return;
    case "rollback":
      await runRollback(input, args);
      return;
    case "skills":
      await showToolResult(input, "skill.list", {});
      return;
    case "mcp":
      await showToolResult(input, "mcp.list", {});
      return;
    case "status":
      input.setState((current) =>
        setTuiDetail(current, {
          title: "Status",
          body: formatStatusDetail(current),
          tone: current.status === "failed" ? "danger" : "info",
        }),
      );
      return;
    case "tools":
      input.setState((current) =>
        setTuiDetail(current, {
          title: "Recent tools",
          body: formatToolsDetail(current),
          tone: "info",
        }),
      );
      return;
    case "cost":
      input.setState((current) =>
        setTuiDetail(current, {
          title: "Cost summary",
          body: [
            `Input tokens: ${current.usage.inputTokens}`,
            `Output tokens: ${current.usage.outputTokens}`,
            `Total tokens: ${current.usage.totalTokens}`,
            `Estimated USD: $${current.usage.costUsd.toFixed(6)}`,
          ].join("\n"),
          tone: "success",
        }),
      );
      return;
    default:
      input.setState((current) =>
        addTuiNotice(current, {
          title: `Unknown command /${command}`,
          body: "Use /help to see available commands.",
          tone: "warning",
        }),
      );
  }
}

async function showSessions(input: {
  setState: React.Dispatch<React.SetStateAction<TuiState>>;
  home?: string;
  workspaceRoot: string;
}): Promise<void> {
  const sessions = await listSessions({ home: input.home, cwd: input.workspaceRoot, limit: 20 });
  const body = sessions.length
    ? sessions
        .map(
          (session) =>
            `${session.id}  ${session.status}  ${session.changedFileCount} file(s)  ${session.title}`,
        )
        .join("\n")
    : "No DreamCode sessions found for this workspace.";
  input.setState((current) =>
    setTuiDetail(current, {
      title: "Sessions",
      body,
      tone: "info",
    }),
  );
}

async function resumeSession(
  input: {
    setState: React.Dispatch<React.SetStateAction<TuiState>>;
    runPrompt: (prompt: string, options?: { sessionId?: string }) => Promise<void>;
    sessionIdRef: React.MutableRefObject<string | undefined>;
    home?: string;
  },
  args: string[],
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    input.setState((current) =>
      addTuiNotice(current, {
        title: "Missing session id",
        body: "Usage: /resume <session-id> [prompt]",
        tone: "warning",
      }),
    );
    return;
  }
  const prompt =
    args.slice(1).join(" ").trim() ||
    "Continue this DreamCode session from the event log and finish the remaining goal.";
  input.sessionIdRef.current = sessionId;
  const events = await readSessionEvents(sessionId, input.home);
  input.setState((current) => {
    const baseState: TuiState = {
      ...current,
      assistantText: "",
      assistantMessages: [],
      timeline: [],
      tools: [],
      changedFiles: [],
      artifacts: [],
      approvals: [],
      todos: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
      detail: undefined,
      notice: undefined,
    };
    return events.reduce<TuiState>(
      (nextState, event) => reduceTuiEvent(nextState, event),
      baseState,
    );
  });
  await input.runPrompt(prompt, { sessionId });
}

async function showDiff(
  input: {
    state: TuiState;
    setState: React.Dispatch<React.SetStateAction<TuiState>>;
    home?: string;
  },
  args: string[],
): Promise<void> {
  const sessionId = args[0]?.startsWith("--")
    ? input.state.sessionId
    : (args[0] ?? input.state.sessionId);
  const fileArgIndex = args.indexOf("--file");
  const filePath = fileArgIndex >= 0 ? args[fileArgIndex + 1] : args[1];
  if (!sessionId) {
    input.setState((current) =>
      addTuiNotice(current, {
        title: "No active session",
        body: "Run a task first, or use /diff <session-id>.",
        tone: "warning",
      }),
    );
    return;
  }
  const replayed = await readReplayedSession(sessionId, input.home);
  const files = filePath
    ? replayed.changedFiles.filter((file) => file.path === filePath)
    : replayed.changedFiles;
  const body = files.length
    ? files.map((file) => `diff -- ${file.path}\n${file.diff ?? "(no diff recorded)"}`).join("\n\n")
    : "No matching file diff recorded.";
  input.setState((current) =>
    setTuiDetail(current, {
      title: `Diff ${compactId(sessionId)}`,
      body,
      tone: "warning",
    }),
  );
}

async function runRollback(
  input: {
    setState: React.Dispatch<React.SetStateAction<TuiState>>;
    home?: string;
  },
  args: string[],
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    input.setState((current) =>
      addTuiNotice(current, {
        title: "Missing session id",
        body: "Usage: /rollback <session-id> --file <path> | --all",
        tone: "warning",
      }),
    );
    return;
  }
  const fileIndex = args.indexOf("--file");
  const all = args.includes("--all");
  const filePath = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  const force = args.includes("--force");
  if (!all && !filePath) {
    input.setState((current) =>
      addTuiNotice(current, {
        title: "Rollback needs a scope",
        body: "Pass --file <path> or --all.",
        tone: "warning",
      }),
    );
    return;
  }
  const result = await rollbackSession({
    sessionId,
    home: input.home,
    filePath,
    all,
    force,
  });
  input.setState((current) =>
    setTuiDetail(current, {
      title: `Rollback ${compactId(sessionId)}`,
      body: [
        result.rolledBackFiles.length
          ? `Rolled back:\n${result.rolledBackFiles.map((file) => `- ${file}`).join("\n")}`
          : "No files rolled back.",
        result.skippedFiles.length
          ? `Skipped:\n${result.skippedFiles.map((file) => `- ${file.path}: ${file.reason}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      tone: result.skippedFiles.length ? "warning" : "success",
    }),
  );
}

async function showToolResult(
  input: {
    setState: React.Dispatch<React.SetStateAction<TuiState>>;
    home?: string;
    workspaceRoot: string;
    config: DreamCodeConfig;
    mode: RunMode;
  },
  toolName: string,
  toolInput: unknown,
): Promise<void> {
  const registry = createDefaultToolRegistry({ mcpServers: input.config.mcpServers });
  const tool = registry.get(toolName);
  if (!tool) {
    input.setState((current) =>
      addTuiNotice(current, {
        title: `Tool not found: ${toolName}`,
        tone: "danger",
      }),
    );
    return;
  }
  const home = input.home ?? getDreamCodeHome();
  const result = await tool.execute(toolInput, {
    workspaceRoot: input.workspaceRoot,
    sessionDir: path.join(home, "sessions", "_tui"),
    mode: input.mode,
    toolCallId: `tui_${toolName.replace(/\W/g, "_")}`,
  });
  input.setState((current) =>
    setTuiDetail(current, {
      title: toolName,
      body:
        result.data === undefined
          ? result.summary
          : `${result.summary}\n\n${JSON.stringify(result.data, null, 2)}`,
      tone: result.status === "success" ? "success" : "warning",
    }),
  );
}

function formatStatusDetail(state: TuiState): string {
  return [
    `Activity: ${statusLineLabel(state)}`,
    `Session: ${state.sessionId ?? "new session"}`,
    `Model: ${state.runtime.provider}/${state.runtime.model || "default"}`,
    `Mode: ${state.runtime.mode}`,
    `Workspace: ${state.runtime.workspaceRoot}`,
    `Tools: ${state.tools.length} recorded`,
    `Changed files: ${state.changedFiles.length}`,
    `Tokens: ${state.usage.totalTokens}`,
    `Cost: $${state.usage.costUsd.toFixed(6)}`,
  ].join("\n");
}

function formatToolsDetail(state: TuiState): string {
  if (!state.tools.length) {
    return "No tool calls recorded yet.";
  }

  return state.tools
    .slice(-12)
    .map((tool) =>
      [
        `${tool.status.padEnd(9)} ${tool.name}`,
        tool.summary ? `  ${tool.summary}` : undefined,
        tool.inputPreview ? `  input: ${tool.inputPreview}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function slashSuggestions(line: string): string[] {
  if (!line.startsWith("/")) {
    return [];
  }
  const commands = [
    "/sessions",
    "/resume",
    "/diff",
    "/rollback",
    "/skills",
    "/mcp",
    "/status",
    "/tools",
    "/cost",
    "/interrupt",
    "/clear",
    "/help",
  ];
  const normalized = line.toLowerCase();
  return commands.filter((command) => command.startsWith(normalized)).slice(0, 5);
}

function composerHeight(input: {
  pendingApproval: boolean;
  pendingQuestion: boolean;
  suggestions: string[];
}): number {
  return (
    (input.pendingApproval ? 5 : 0) +
    (input.pendingQuestion ? 1 : 0) +
    (input.suggestions.length ? 1 : 0) +
    4
  );
}

function todoStatusHeight(todoCount: number): number {
  return todoCount ? Math.min(7, todoCount + 1) + 1 : 0;
}

function nextRunMode(mode: RunMode): RunMode {
  switch (mode) {
    case "plan":
      return "guided";
    case "guided":
      return "yolo";
    case "yolo":
      return "full";
    default:
      return "plan";
  }
}

function horizontalRule(width: number): string {
  return "─".repeat(Math.max(0, width - 2));
}

function formatRuntimeSummary(state: TuiState): string {
  const session = state.sessionId ? compactId(state.sessionId) : "new session";
  return `${state.runtime.provider}/${state.runtime.model || "default"} · ${state.runtime.mode} · ${session}`;
}

export function statusLineLabel(state: TuiState, frame = 0): string {
  const activity = deriveAgentActivity(state);
  const marker = activity.live ? STATUS_FRAMES[frame % STATUS_FRAMES.length] : "●";
  const cost =
    state.usage.totalTokens > 0
      ? ` · ${state.usage.totalTokens} tokens · $${state.usage.costUsd.toFixed(6)}`
      : "";
  const detail = activity.detail ? ` · ${activity.detail}` : "";
  return `${marker} ${activity.label}${detail}${cost}`;
}

function deriveAgentActivity(state: TuiState): { label: string; detail?: string; live: boolean } {
  if (state.status === "waiting_approval") {
    return { label: "waiting for approval", detail: latestToolName(state), live: true };
  }
  if (state.status === "waiting_question") {
    return { label: "waiting for input", live: true };
  }
  if (state.status === "completed") {
    return { label: "completed", live: false };
  }
  if (state.status === "failed") {
    return { label: "failed", live: false };
  }
  if (state.status === "interrupted") {
    return { label: "interrupted", live: false };
  }
  if (state.status === "idle") {
    return { label: "idle", live: false };
  }

  const runningTool = findLastTool(state.tools, (tool) => tool.status === "running");
  if (runningTool) {
    return { label: "using tool", detail: runningTool.name, live: true };
  }

  const queuedTool = findLastTool(state.tools, (tool) => tool.status === "queued");
  if (queuedTool) {
    return { label: "preparing tool", detail: queuedTool.name, live: true };
  }

  const latestTool = findLastTool(state.tools, (tool) =>
    ["success", "error", "cancelled", "denied"].includes(tool.status),
  );
  if (latestTool) {
    return { label: "reviewing result", detail: latestTool.name, live: true };
  }

  if (state.assistantText.trim()) {
    return { label: "responding", live: true };
  }

  if (state.contextSummary) {
    return { label: "thinking", detail: "context ready", live: true };
  }

  return { label: "thinking", live: true };
}

function latestToolName(state: TuiState): string | undefined {
  return findLastTool(state.tools, () => true)?.name;
}

function findLastTool(
  tools: TuiState["tools"],
  predicate: (tool: TuiState["tools"][number]) => boolean,
): TuiState["tools"][number] | undefined {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool && predicate(tool)) {
      return tool;
    }
  }
  return undefined;
}

function isLiveRunStatus(status: TuiState["status"]): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_question";
}

function useTerminalCursorStyle(isActive: boolean): void {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!isActive) {
      return;
    }
    stdout.write(`${CURSOR_BLINK_ENABLE}${CURSOR_BLINKING_BAR}${CURSOR_WHITE}`);
    return () => {
      stdout.write(`${CURSOR_BLINK_DISABLE}${CURSOR_DEFAULT_STYLE}${CURSOR_RESET_COLOR}`);
    };
  }, [isActive, stdout]);
}

function formatWorkspaceRoot(workspaceRoot: string): string {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedHome = path.resolve(os.homedir());
  return normalizedRoot.toLowerCase().startsWith(normalizedHome.toLowerCase())
    ? `~${normalizedRoot.slice(normalizedHome.length)}`
    : normalizedRoot;
}

function tailLines<T>(lines: T[], maxLines: number): T[] {
  return lines.slice(Math.max(0, lines.length - Math.max(1, maxLines)));
}

function todoCheckbox(status: string): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[-]";
    default:
      return "[ ]";
  }
}

function todoTone(status: string): TimelineTone {
  switch (status) {
    case "completed":
      return "success";
    case "in_progress":
      return "info";
    case "blocked":
      return "danger";
    default:
      return "muted";
  }
}

function emptyComposerInput(): ComposerInput {
  return { value: "", cursor: 0 };
}

function lineToComposerInput(value: string): ComposerInput {
  return { value, cursor: countCharacters(value) };
}

function insertAtCursor(input: ComposerInput, value: string): ComposerInput {
  const inserted = sanitizeComposerInput(value);
  if (!inserted) {
    return input;
  }
  const chars = Array.from(input.value);
  const cursor = clamp(input.cursor, 0, chars.length);
  const insertedChars = Array.from(inserted);
  chars.splice(cursor, 0, ...insertedChars);
  return {
    value: chars.join(""),
    cursor: cursor + insertedChars.length,
  };
}

function deleteBeforeCursor(input: ComposerInput): ComposerInput {
  const chars = Array.from(input.value);
  const cursor = clamp(input.cursor, 0, chars.length);
  if (cursor === 0) {
    return { value: input.value, cursor };
  }
  chars.splice(cursor - 1, 1);
  return { value: chars.join(""), cursor: cursor - 1 };
}

function deleteAtCursor(input: ComposerInput): ComposerInput {
  const chars = Array.from(input.value);
  const cursor = clamp(input.cursor, 0, chars.length);
  if (cursor >= chars.length) {
    return { value: input.value, cursor };
  }
  chars.splice(cursor, 1);
  return { value: chars.join(""), cursor };
}

function moveCursor(input: ComposerInput, delta: number): ComposerInput {
  return {
    ...input,
    cursor: clamp(input.cursor + delta, 0, countCharacters(input.value)),
  };
}

function sanitizeComposerInput(value: string): string {
  return Array.from(value.replace(/[\t\r\n]+/g, " "))
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    })
    .join("");
}

function createInputView(value: string, cursor: number, maxWidth: number): InputView {
  const chars = Array.from(value);
  const boundedCursor = clamp(cursor, 0, chars.length);
  if (maxWidth <= 0) {
    return { text: "", cursorColumn: 0 };
  }

  let start = boundedCursor;
  let widthBeforeCursor = 0;
  while (start > 0) {
    const nextWidth = displayWidth(chars[start - 1] ?? "");
    if (widthBeforeCursor + nextWidth > maxWidth) {
      break;
    }
    start -= 1;
    widthBeforeCursor += nextWidth;
  }

  let end = boundedCursor;
  let totalWidth = widthBeforeCursor;
  while (end < chars.length) {
    const nextWidth = displayWidth(chars[end] ?? "");
    if (totalWidth + nextWidth > maxWidth) {
      break;
    }
    end += 1;
    totalWidth += nextWidth;
  }

  return {
    text: chars.slice(start, end).join(""),
    cursorColumn: widthBeforeCursor,
  };
}

export function getComposerCursorPosition(input: {
  cursorColumn: number;
  terminalHeight: number;
  prompt: string;
  suggestions: string[];
  pendingQuestion?: PendingQuestion;
}): { x: number; y: number } {
  const height = composerHeight({
    pendingApproval: false,
    pendingQuestion: Boolean(input.pendingQuestion),
    suggestions: input.suggestions,
  });
  const inputRowOffset = (input.pendingQuestion ? 1 : 0) + (input.suggestions.length ? 1 : 0) + 1;

  return {
    x: 1 + displayWidth(input.prompt) + input.cursorColumn,
    y: clamp(input.terminalHeight - height + inputRowOffset + 1, 0, input.terminalHeight - 1),
  };
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of Array.from(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || isZeroWidthCodePoint(codePoint)) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    isCombiningMark(codePoint)
  );
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6))) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff)
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function completeSlash(line: string): string {
  const [suggestion] = slashSuggestions(line);
  return suggestion ? `${suggestion} ` : line;
}

function toneColor(tone: TimelineTone): string {
  switch (tone) {
    case "success":
      return GREEN;
    case "warning":
      return YELLOW;
    case "danger":
      return PINK;
    case "muted":
      return MUTED;
    default:
      return BLUE;
  }
}

function todoColor(status: string): string {
  switch (status) {
    case "completed":
      return GREEN;
    case "in_progress":
      return BRAND_PURPLE;
    case "blocked":
      return PINK;
    default:
      return MUTED;
  }
}

function compactId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}...${id.slice(-5)}` : id;
}

function previewJson(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return undefined;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 15)}...[truncated]` : text;
}

function hashKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
