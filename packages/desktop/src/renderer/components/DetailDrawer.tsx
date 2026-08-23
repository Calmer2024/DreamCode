import type { AgentEvent } from "@dreamcode/shared";
import {
  ChevronDown,
  CircleAlert,
  FileText,
  Plus,
  ScrollText,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DesktopApi } from "../../shared/contracts";
import type { DesktopTerminalEntry } from "../state/desktop-state";
import { TerminalView } from "./TerminalView";

export type DetailTab = "logs" | "terminal";

interface DetailDrawerProps {
  terminalEntries?: DesktopTerminalEntry[];
  events?: AgentEvent[];
  initialTab?: DetailTab;
  onClose: () => void;
  api?: DesktopApi;
  workspaceRoot?: string;
}

const outputLimit = 200 * 1024;
const tabs: Array<{ id: DetailTab; label: string; Icon: typeof FileText }> = [
  { id: "logs", label: "日志", Icon: ScrollText },
  { id: "terminal", label: "终端", Icon: SquareTerminal },
];

export function DetailDrawer({
  terminalEntries = [],
  events = [],
  initialTab = "logs",
  onClose,
  api,
  workspaceRoot,
}: DetailDrawerProps) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [terminalId, setTerminalId] = useState<string>();
  const [liveTerminalOutput, setLiveTerminalOutput] = useState("");
  const [terminalError, setTerminalError] = useState<string>();
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const dragPointerRef = useRef<number | undefined>(undefined);
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const pendingHeightRef = useRef(360);
  useEffect(() => setTab(initialTab), [initialTab]);

  useEffect(() => {
    void terminalGeneration;
    if (tab !== "terminal" || !api || !workspaceRoot) return;
    let disposed = false;
    let activeTerminalId: string | undefined;
    const pendingOutput = new Map<string, string>();
    setTerminalError(undefined);
    const unsubscribe = api.onTerminalOutput((output) => {
      if (activeTerminalId) {
        if (output.terminalId === activeTerminalId) {
          setLiveTerminalOutput((current) => `${current}${output.text}`);
        }
        return;
      }
      pendingOutput.set(
        output.terminalId,
        `${pendingOutput.get(output.terminalId) ?? ""}${output.text}`,
      );
    });
    void api
      .startTerminal(workspaceRoot)
      .then(({ terminalId: nextId }) => {
        if (disposed) {
          void api.closeTerminal(nextId);
          return;
        }
        activeTerminalId = nextId;
        setLiveTerminalOutput(pendingOutput.get(nextId) ?? "");
        setTerminalId(nextId);
      })
      .catch((error) => {
        if (!disposed) setTerminalError(readErrorMessage(error));
      });
    return () => {
      disposed = true;
      unsubscribe();
      if (activeTerminalId) void api.closeTerminal(activeTerminalId);
      setTerminalId(undefined);
      setLiveTerminalOutput("");
    };
  }, [api, tab, workspaceRoot, terminalGeneration]);

  useEffect(() => {
    document.documentElement.style.setProperty("--drawer-height", `${pendingHeightRef.current}px`);
    return () => {
      if (resizeFrameRef.current !== undefined) cancelAnimationFrame(resizeFrameRef.current);
      document.documentElement.removeAttribute("data-drawer-resizing");
      document.documentElement.style.removeProperty("--drawer-height");
    };
  }, []);

  const updateHeight = (clientY: number) => {
    pendingHeightRef.current = Math.max(
      220,
      Math.min(Math.round(window.innerHeight * 0.72), window.innerHeight - clientY),
    );
    if (resizeFrameRef.current !== undefined) return;
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      document.documentElement.style.setProperty(
        "--drawer-height",
        `${pendingHeightRef.current}px`,
      );
    });
  };

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragPointerRef.current !== event.pointerId) return;
    updateHeight(event.clientY);
    dragPointerRef.current = undefined;
    document.documentElement.removeAttribute("data-drawer-resizing");
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const terminalOutput = useMemo(
    () => terminalEntries.map(formatTerminalEntry).join("\n"),
    [terminalEntries],
  );

  return (
    <div className="drawer-backdrop">
      <aside className="detail-drawer" role="dialog" aria-modal="false" aria-label="底部面板">
        <button
          type="button"
          className="drawer-resize-handle"
          aria-label="调整底部栏高度"
          onPointerDown={(event) => {
            dragPointerRef.current = event.pointerId;
            document.documentElement.setAttribute("data-drawer-resizing", "true");
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragPointerRef.current === event.pointerId) updateHeight(event.clientY);
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
        />
        <header className="drawer-tabbar">
          <div className="drawer-tabs" role="tablist" aria-label="底部面板类型">
            {tabs.map(({ id, label, Icon }) => (
              <button
                type="button"
                role="tab"
                aria-label={label}
                aria-selected={tab === id}
                className="drawer-tab"
                key={id}
                onClick={() => setTab(id)}
              >
                <Icon aria-hidden="true" />
                <span
                  className="drawer-tab-label"
                  title={id === "terminal" ? workspaceRoot : undefined}
                >
                  {id === "terminal" && workspaceRoot ? workspaceRoot : label}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="drawer-new-tab"
              aria-label="新建终端"
              data-tooltip="新建终端"
              disabled={!api || !workspaceRoot}
              onClick={() => {
                setTab("terminal");
                setTerminalGeneration((generation) => generation + 1);
              }}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="drawer-close"
            aria-label="关闭详情"
            data-tooltip="关闭"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="drawer-body">
          {tab === "logs" ? (
            <LogEventList events={events} />
          ) : terminalError ? (
            <div className="terminal-error" role="alert">
              <CircleAlert aria-hidden="true" />
              <div>
                <strong>终端启动失败</strong>
                <span>{terminalError}</span>
              </div>
            </div>
          ) : api && terminalId ? (
            <TerminalView
              api={api}
              terminalId={terminalId}
              output={boundOutput(`${terminalOutput}${liveTerminalOutput}`)}
            />
          ) : (
            <pre className="drawer-output" data-testid="detail-output">
              {boundOutput(terminalOutput) || "终端正在启动…"}
            </pre>
          )}
        </div>
      </aside>
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "无法在当前项目目录启动系统终端。";
}

function LogEventList({ events }: { events: AgentEvent[] }) {
  if (!events.length) {
    return (
      <div className="drawer-empty">
        <FileText aria-hidden="true" />
        <span>暂无日志</span>
      </div>
    );
  }

  return (
    <div className="log-event-list" data-testid="detail-output">
      {groupLogEvents(events).map((event) => {
        const presentation = eventPresentation(event);
        const detail = compactJson(event.payload);
        const preview = eventPreview(event);
        const collapsible = detail.length > 120 || detail.includes("\n");
        const rowClassName = `log-line tone-${presentation.tone}`;
        return (
          <details className={rowClassName} key={event.id}>
            <summary className="log-line-summary">
              <time className="log-line-time" dateTime={event.timestamp}>
                {formatTime(event.timestamp)}
              </time>
              <span className="log-line-module">{presentation.module}</span>
              <code className="log-line-type">{event.type}</code>
              <span className="log-line-status">{presentation.label}</span>
              <span className="log-line-message">{preview || presentation.label}</span>
              {detail && collapsible ? (
                <span className="log-line-detail-toggle">
                  详情
                  <ChevronDown aria-hidden="true" />
                </span>
              ) : null}
            </summary>
            {detail && collapsible ? (
              <div className="log-line-detail-content">{boundOutput(detail)}</div>
            ) : null}
          </details>
        );
      })}
    </div>
  );
}

function groupLogEvents(events: AgentEvent[]): AgentEvent[] {
  const grouped: AgentEvent[] = [];
  for (const event of events) {
    const previous = grouped.at(-1);
    if (event.type !== "model.delta" || previous?.type !== "model.delta") {
      grouped.push(event);
      continue;
    }

    const previousPayload = previous.payload;
    const currentPayload = event.payload;
    if (
      previous.turnId !== event.turnId ||
      !previousPayload ||
      typeof previousPayload !== "object" ||
      !currentPayload ||
      typeof currentPayload !== "object"
    ) {
      grouped.push(event);
      continue;
    }

    const previousText = stringPayload(previousPayload, "text");
    const currentText = stringPayload(currentPayload, "text");
    if (previousText === undefined || currentText === undefined) {
      grouped.push(event);
      continue;
    }

    grouped[grouped.length - 1] = {
      ...previous,
      timestamp: event.timestamp,
      payload: {
        ...(previousPayload as Record<string, unknown>),
        text: previousText + currentText,
        chunkCount:
          numberPayload(previousPayload, "chunkCount") +
          numberPayload(currentPayload, "chunkCount"),
      },
    };
  }
  return grouped;
}

function stringPayload(value: object, key: string): string | undefined {
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" ? item : undefined;
}

function numberPayload(value: object, key: string): number {
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "number" && Number.isFinite(item) ? item : 1;
}

function eventPresentation(event: AgentEvent) {
  if (event.type.includes("failed") || event.type.includes("error")) {
    return {
      label: "执行失败",
      module: "runtime",
      tone: "danger",
    } as const;
  }
  if (event.type.includes("completed") || event.type.includes("saved")) {
    return {
      label: "执行完成",
      module: "runtime",
      tone: "success",
    } as const;
  }
  if (event.type.startsWith("tool.") || event.type === "model.tool_call") {
    return { label: "工具调用", module: "tool", tone: "tool" } as const;
  }
  if (event.type.startsWith("file.") || event.type.includes("artifact")) {
    return {
      label: "文件变更",
      module: "files",
      tone: "file",
    } as const;
  }
  if (event.type.startsWith("model.")) {
    return { label: "模型输出", module: "model", tone: "model" } as const;
  }
  if (event.type === "user.message") {
    return {
      label: "用户输入",
      module: "user",
      tone: "message",
    } as const;
  }
  if (event.type.startsWith("permission.")) {
    return {
      label: "权限决策",
      module: "policy",
      tone: "warning",
    } as const;
  }
  if (event.type.includes("question")) {
    return {
      label: "交互问题",
      module: "user",
      tone: "warning",
    } as const;
  }
  return {
    label: "运行事件",
    module: "runtime",
    symbol: "·",
    tone: "info",
  } as const;
}

function eventPreview(event: AgentEvent): string {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload))
    return "";
  const payload = event.payload as Record<string, unknown>;
  for (const key of [
    "summary",
    "content",
    "message",
    "reason",
    "command",
    "path",
    "tool",
    "model",
    "status",
  ]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim(), 180);
  }
  const toolCall = payload.toolCall;
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const name = (toolCall as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return "";
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function formatTerminalEntry(entry: DesktopTerminalEntry): string {
  const prefix = entry.stream === "stderr" ? "[stderr] " : "";
  return `${prefix}${entry.text}`;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export function boundOutput(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= outputLimit) return value;
  const marker = "\n[输出已截断至 200 KB]";
  const byteBudget = outputLimit - encoder.encode(marker).byteLength;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= byteBudget) low = middle;
    else high = middle - 1;
  }
  const safeEnd = low > 0 && isHighSurrogate(value.charCodeAt(low - 1)) ? low - 1 : low;
  return `${value.slice(0, safeEnd)}${marker}`;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}
