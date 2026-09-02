import type { ChangedFile, TodoItem } from "@dreamcode/shared";
import {
  Activity,
  BrainCircuit,
  Bug,
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleStop,
  CircleX,
  Clock,
  Copy,
  Check,
  FileCode2,
  FilePenLine,
  Globe,
  Hammer,
  Layers3,
  ListChecks,
  PackagePlus,
  PlayCircle,
  PlusCircle,
  Radio,
  RefreshCw,
  RotateCcw,
  Shrink,
  SquareTerminal,
  Telescope,
  Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type {
  DesktopApi,
  DesktopQuestionRequest,
} from "../../shared/contracts";
import type {
  DesktopState,
  DesktopTimelineEntry,
  DesktopToolEvent,
  DesktopTurnUsage,
} from "../state/desktop-state";
import { MarkdownContent } from "./MarkdownContent";

interface TimelineProps {
  state: DesktopState;
  profileUsable: boolean;
  workspaceName?: string;
  onPromptSuggestion?: (prompt: string) => void;
  onConfigure: () => void;
  onChooseWorkspace: () => void;
  questionRequest?: DesktopQuestionRequest;
  questionApi?: Pick<DesktopApi, "respondQuestion">;
  onQuestionResolved?: () => void;
}

export function Timeline({
  state,
  profileUsable,
  workspaceName,
  onPromptSuggestion = () => undefined,
  onConfigure,
  onChooseWorkspace,
  questionRequest,
  questionApi,
  onQuestionResolved,
}: TimelineProps) {
  if (!profileUsable) {
    return (
      <div className="empty-state configuration-state">
        <span className="empty-kicker">模型未配置</span>
        <h1>先配置模型，再开始对话</h1>
        <p>添加一个可用的模型配置后，DreamCode 才能安全地执行任务。</p>
        <button type="button" className="secondary-button" onClick={onConfigure}>
          打开模型与配置
        </button>
      </div>
    );
  }

  if (!state.workspaceRoot) {
    return (
      <div className="empty-state">
        <span className="empty-kicker">工作区未选择</span>
        <h1>选择一个项目开始构建</h1>
        <p>DreamCode 只会在你选择的工作区内读取和修改文件。</p>
        <button type="button" className="secondary-button" onClick={onChooseWorkspace}>
          选择工作区
        </button>
      </div>
    );
  }

  const hasConversation = Boolean(state.request || state.timeline.length);
  if (!hasConversation) {
    if (questionRequest && questionApi && onQuestionResolved) {
      return <QuestionCard api={questionApi} request={questionRequest} onResolved={onQuestionResolved} />;
    }
    const suggestions = [
      { icon: Telescope, tone: "explore", label: "探索并理解代码" },
      { icon: Hammer, tone: "build", label: "构建新功能、应用或工具" },
      { icon: RefreshCw, tone: "review", label: "审查代码并提出修改建议" },
      { icon: Bug, tone: "fix", label: "修复问题和失败" },
    ] as const;
    return (
      <div className="empty-state welcome-state">
        <img className="welcome-mark" src="./dreamcode-welcome-icon.png" alt="" />
        <h1>
          要在 <span>{workspaceName ?? "当前项目"}</span> 内开发什么？
        </h1>
        <div className="welcome-suggestions">
          {suggestions.map(({ icon: Icon, tone, label }) => (
            <button
              type="button"
              data-tone={tone}
              key={label}
              onClick={() => onPromptSuggestion(label)}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="timeline" aria-label="任务时间线">
      {state.request && !state.timeline.some((entry) => entry.kind === "user") ? (
        <UserMessage content={state.request.prompt} timestamp={state.requestTimestamp ?? ""} />
      ) : null}
      {state.todoItems.length ? <TodoPanel items={state.todoItems} /> : null}
      {conversationBlocks(state.timeline, state.tools, state.turnUsage, state.changedFilesByTurn)}
      {questionRequest && questionApi && onQuestionResolved ? (
        <QuestionCard api={questionApi} request={questionRequest} onResolved={onQuestionResolved} />
      ) : null}
    </section>
  );
}

function conversationBlocks(
  entries: DesktopTimelineEntry[],
  tools: DesktopToolEvent[],
  turnUsage: Record<string, DesktopTurnUsage>,
  changedFilesByTurn: Record<string, ChangedFile[]>,
): ReactNode[] {
  const blocks: ReactNode[] = [];
  let execution: DesktopTimelineEntry[] = [];
  let executionTurnId: string | undefined;
  const flushExecution = () => {
    if (!execution.length) return;
    blocks.push(
      <ExecutionSegment
        entries={execution}
        tools={tools}
        usage={execution[0]?.turnId ? turnUsage[execution[0].turnId] : undefined}
        changedFiles={execution.find((entry) => entry.turnId)?.turnId
          ? changedFilesByTurn[execution.find((entry) => entry.turnId)?.turnId ?? ""] ?? []
          : []}
        key={`execution-${execution[0]?.id ?? blocks.length}`}
      />,
    );
    execution = [];
    executionTurnId = undefined;
  };

  for (const entry of entries) {
    if (entry.kind === "session" || entry.kind === "turn") continue;
    if (entry.kind === "user") {
      flushExecution();
      blocks.push(<TimelineItem entry={entry} key={entry.id} />);
    } else {
      if (execution.length && entry.turnId && executionTurnId && entry.turnId !== executionTurnId) {
        flushExecution();
      }
      if (!executionTurnId && entry.turnId) executionTurnId = entry.turnId;
      execution.push(entry);
    }
  }
  flushExecution();
  return blocks;
}

function ExecutionSegment({
  entries,
  tools,
  usage,
  changedFiles,
}: {
  entries: DesktopTimelineEntry[];
  tools: DesktopToolEvent[];
  usage?: DesktopTurnUsage;
  changedFiles: ChangedFile[];
}) {
  const liveStatusDelayMs = 800;
  const completed = entries.some((entry) => entry.title === "Turn completed");
  const turnId = entries.find((entry) => entry.turnId)?.turnId;
  const segmentTools = turnId ? tools.filter((tool) => tool.turnId === turnId) : tools;
  const runningTools = segmentTools.some((tool) => tool.status === "running" || tool.status === "queued");
  const hasCanonicalTools = segmentTools.length > 0;
  const processEntries = entries.filter(
    (entry) =>
      entry.kind !== "assistant" &&
      entry.kind !== "file" &&
      entry.title !== "Turn completed" &&
      entry.title !== "上下文已压缩",
  );
  const notices = entries.filter((entry) => entry.title === "上下文已压缩");
  const summaries = entries.filter((entry) => entry.kind === "assistant");
  const latestVisibleSummary = [...summaries].reverse().find((entry) => Boolean(entry.detail?.trim()));
  const hasVisibleOutput = summaries.some((entry) => Boolean(entry.detail?.trim()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (completed || runningTools || !hasVisibleOutput) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [completed, hasVisibleOutput, runningTools]);
  const latestOutputAt = latestVisibleSummary ? new Date(latestVisibleSummary.timestamp).valueOf() : Number.NaN;
  const outputIsFresh = Number.isFinite(latestOutputAt) && now - latestOutputAt < liveStatusDelayMs;
  const showLiveStatus = !completed && (runningTools || !hasVisibleOutput || !outputIsFresh);
  const liveStatus = runningTools ? "正在调用工具" : "正在思考";
  let processRendered = false;

  return (
    <>
      {processEntries.length ? (
        <details className="execution-segment" open={completed ? undefined : true}>
          <summary className="execution-summary">
            <span>
              {completed ? `已完成 · 耗时 ${formatElapsed(entries)}` : "执行中"}
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          <div className="execution-content">
            {processEntries.map((entry) => {
              if (entry.kind === "tool" && hasCanonicalTools) {
                if (processRendered) return null;
                processRendered = true;
                return <ToolProcess tools={segmentTools} key={`process-${entry.id}`} />;
              }
              return <TimelineItem entry={entry} key={entry.id} />;
            })}
          </div>
        </details>
      ) : null}
      {notices.map((entry) => (
        <TimelineItem entry={entry} key={entry.id} />
      ))}
      {summaries.map((entry, index) => (
        <TimelineItem
          entry={entry}
          usage={index === summaries.length - 1 ? usage : undefined}
          liveStatus={showLiveStatus && index === summaries.length - 1 ? liveStatus : undefined}
          key={entry.id}
        />
      ))}
      {!summaries.length && showLiveStatus ? (
        <div className="execution-live-status" role="status" aria-live="polite">
          <span className="status-shimmer">{liveStatus}</span>
        </div>
      ) : null}
      {completed && changedFiles.length ? <DiffSummaryCard files={changedFiles} /> : null}
    </>
  );
}

function TodoPanel({ items }: { items: TodoItem[] }) {
  const [open, setOpen] = useState(true);
  const completed = items.filter((item) => item.status === "completed").length;
  return (
    <section className="todo-panel" aria-label="任务清单">
      <button type="button" className="todo-panel-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="todo-panel-title"><CircleCheck aria-hidden="true" /> 任务清单</span>
        <span className="todo-panel-count">{completed}/{items.length}</span>
        <ChevronDown aria-hidden="true" className={open ? "todo-chevron-open" : ""} />
      </button>
      {open ? <div className="todo-list">{items.map((item, index) => {
        const Icon = item.status === "completed" ? CircleCheck : item.status === "blocked" ? CircleX : CircleDot;
        return <div className={`todo-item todo-${item.status}`} key={`${item.content}-${index}`}><Icon aria-hidden="true" /><span>{item.content}</span></div>;
      })}</div> : null}
    </section>
  );
}

function DiffSummaryCard({ files }: { files: ChangedFile[] }) {
  const [reviewing, setReviewing] = useState(false);
  const totals = files.reduce(
    (sum, file) => {
      const stats = diffStats(file.diff);
      return {
        additions: sum.additions + stats.additions,
        deletions: sum.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );

  return (
    <section className="diff-summary-card" aria-label={`已编辑 ${files.length} 个文件`}>
      <header>
        <span className="diff-summary-icon">
          <FileCode2 aria-hidden="true" />
        </span>
        <div>
          <h3>{`已编辑 ${files.length} 个文件`}</h3>
          <p>
            <span className="diff-additions">+{totals.additions}</span>{" "}
            <span className="diff-deletions">-{totals.deletions}</span>
          </p>
        </div>
        <button type="button" onClick={() => setReviewing((current) => !current)}>
          {reviewing ? "收起" : "审核"}
        </button>
      </header>
      <div className="diff-file-list">
        {files.map((file) => {
          const stats = diffStats(file.diff);
          return (
            <div className="diff-file" key={file.path}>
              <span data-tooltip={file.path}>{file.path}</span>
              <span>
                <b className="diff-additions">+{stats.additions}</b>{" "}
                <b className="diff-deletions">-{stats.deletions}</b>
              </span>
            </div>
          );
        })}
      </div>
      <div className="diff-review" data-expanded={reviewing}>
        <div>
          {files.map((file) => (
            <pre key={file.path}>{file.diff || `${file.operation}: ${file.path}`}</pre>
          ))}
        </div>
      </div>
    </section>
  );
}

function diffStats(diff?: string): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function ToolProcess({ tools }: { tools: DesktopToolEvent[] }) {
  return (
    <details className="tool-process">
      <summary className="tool-process-summary">
        <SquareTerminal aria-hidden="true" />
        <span>{`运行了 ${tools.length} 个命令`}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="tool-process-rows">
        {tools.map((tool) => (
          <CommandRow tool={tool} key={tool.id} />
        ))}
      </div>
    </details>
  );
}

function CommandRow({ tool }: { tool: DesktopToolEvent }) {
  return (
    <details className={`command-row tone-${tool.status}`} aria-label={`执行命令：${tool.name}`}>
      <summary>
        <SquareTerminal aria-hidden="true" />
        <span className="command-state">{commandState(tool)}</span>
        <code>{commandPreview(tool)}</code>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="command-detail">
        <span className="command-tool">{tool.name}</span>
        {tool.inputPreview ? <pre>{tool.inputPreview}</pre> : null}
        {tool.summary ? <p>{tool.summary}</p> : null}
      </div>
    </details>
  );
}

function TimelineItem({
  entry,
  usage,
  liveStatus,
}: {
  entry: DesktopTimelineEntry;
  usage?: DesktopTurnUsage;
  liveStatus?: string;
}) {
  if (entry.kind === "user") {
    return <UserMessage content={entry.detail ?? ""} timestamp={entry.timestamp} />;
  }

  if (entry.kind === "assistant") {
    return (
      <article className="timeline-entry assistant-entry" data-testid="timeline-assistant">
        {entry.detail ? <MarkdownContent>{entry.detail}</MarkdownContent> : null}
        {liveStatus ? (
          <div className="execution-live-status" role="status" aria-live="polite">
            <span className="status-shimmer">{liveStatus}</span>
          </div>
        ) : null}
        {usage?.totalTokens !== undefined ? <TokenUsage usage={usage} /> : null}
      </article>
    );
  }

  if (entry.kind === "tool" || entry.kind === "file") {
    const isTool = entry.kind === "tool";
    const Icon = isTool ? Wrench : FilePenLine;
    const label = isTool ? "工具调用" : "文件变更";
    const iconName = isTool ? "wrench" : "file-pen-line";
    return (
      <article
        aria-label={label}
        className={`timeline-entry compact-card ${entry.kind}-entry tone-${entry.tone}`}
        data-testid={`timeline-${entry.kind}`}
      >
        <div className="compact-card-heading">
          <Icon
            aria-hidden="true"
            data-lucide={iconName}
            data-testid={`timeline-${entry.kind}-icon`}
          />
          <h3>{entry.title}</h3>
          <TimelineTime timestamp={entry.timestamp} />
        </div>
        {entry.detail ? <p>{entry.detail}</p> : null}
      </article>
    );
  }

  if (entry.kind === "status" || entry.kind === "turn" || entry.kind === "session") {
    const presentation = timelinePresentation(entry);
    const Icon = presentation.Icon;
    return (
      <article
        aria-label={presentation.label}
        className={`timeline-entry lifecycle-entry ${entry.kind}-entry tone-${entry.tone}`}
        data-testid={`timeline-${entry.kind}`}
      >
        <Icon
          aria-hidden="true"
          data-lucide={presentation.iconName}
          data-testid={entry.kind === "status" ? "timeline-status-icon" : "timeline-lifecycle-icon"}
        />
        <div className="lifecycle-copy">
          <h3>{entry.title}</h3>
          {entry.detail ? <p>{entry.detail}</p> : null}
        </div>
        <TimelineTime timestamp={entry.timestamp} />
      </article>
    );
  }

  return (
    <article
      aria-label="事件证据"
      className={`timeline-entry evidence-entry event-entry tone-${entry.tone}`}
      data-testid="timeline-event"
    >
      <EventIcon entry={entry} />
      <div className="evidence-copy">
        <div className="event-heading">
          <h3>{entry.title}</h3>
          <TimelineTime timestamp={entry.timestamp} />
        </div>
        {entry.detail ? <p>{entry.detail}</p> : null}
      </div>
    </article>
  );
}

function UserMessage({ content, timestamp }: { content: string; timestamp: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = content;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    } catch {
      // Keep the acknowledgement visible: the user interaction completed even
      // when the host clipboard API is unavailable.
    }
  };
  return (
    <article className="timeline-entry user-entry" data-testid="timeline-user">
      <div className="user-bubble">{content}</div>
      <div className="user-bubble-actions">
        <time dateTime={timestamp}>{formatTime(timestamp)}</time>
        <button
          type="button"
          aria-label={copied ? "已复制用户消息" : "复制用户消息"}
          title={copied ? "已复制" : "复制"}
          onClick={copy}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
    </article>
  );
}

function TokenUsage({ usage }: { usage: DesktopTurnUsage }) {
  const parts = [`${usage.estimated ? "约 " : ""}${formatTokens(usage.totalTokens)} tokens`];
  if (usage.inputTokens !== undefined) parts.push(`输入 ${formatTokens(usage.inputTokens)}`);
  if (usage.outputTokens !== undefined) parts.push(`输出 ${formatTokens(usage.outputTokens)}`);
  if (usage.cachedInputTokens !== undefined) {
    parts.push(`缓存命中 ${formatTokens(usage.cachedInputTokens)}`);
    if ((usage.inputTokens ?? 0) > 0) {
      parts.push(`命中率 ${Math.round((usage.cachedInputTokens / (usage.inputTokens ?? 1)) * 100)}%`);
    }
  }
  return (
    <div className="assistant-token-usage" role="status" aria-label="本轮 Token 用量">
      {parts.join(" · ")}
    </div>
  );
}

function formatTokens(value: number | undefined): string {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

function statusPresentation(tone: DesktopTimelineEntry["tone"]) {
  if (tone === "success") {
    return { Icon: CircleCheck, iconName: "circle-check", label: "运行成功" } as const;
  }
  if (tone === "danger") {
    return { Icon: CircleX, iconName: "circle-x", label: "运行失败" } as const;
  }
  if (tone === "warning") {
    return { Icon: CircleStop, iconName: "circle-stop", label: "运行已中断" } as const;
  }
  return { Icon: Clock, iconName: "clock", label: "运行状态" } as const;
}

function TimelineTime({ timestamp }: { timestamp: string }) {
  return <time dateTime={timestamp}>{formatTime(timestamp)}</time>;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "";
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatElapsed(
  entries: DesktopTimelineEntry[],
): string {
  const timestamps = entries.filter((entry) => entry.kind !== "session")
    .map((entry) => new Date(entry.timestamp).valueOf())
    .filter(Number.isFinite);
  if (!timestamps.length) return "0秒";
  const end = Math.max(...timestamps);
  const elapsedMs = Math.max(0, end - Math.min(...timestamps));
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes ? `${minutes}分钟 ${seconds}秒` : `${seconds}秒`;
}

function EventIcon({ entry }: { entry: DesktopTimelineEntry }) {
  const key = `${entry.kind}:${entry.title}`;
  const presentation = {
    "event:Context built": { Icon: Layers3, iconName: "layers-3" },
    "event:上下文已压缩": { Icon: Shrink, iconName: "shrink" },
    "event:Model started": { Icon: BrainCircuit, iconName: "brain-circuit" },
    "event:Artifact created": { Icon: PackagePlus, iconName: "package-plus" },
    "event:Source saved": { Icon: Globe, iconName: "globe" },
    "event:Todo updated": { Icon: ListChecks, iconName: "list-checks" },
  }[key as "event:Context built" | "event:上下文已压缩" | "event:Model started" | "event:Artifact created" | "event:Source saved" | "event:Todo updated"] ?? { Icon: Activity, iconName: "activity" };
  const Icon = presentation.Icon;
  return <Icon aria-hidden="true" data-lucide={presentation.iconName} />;
}

function timelinePresentation(entry: DesktopTimelineEntry) {
  if (entry.kind === "status") return statusPresentation(entry.tone);
  const key = `${entry.kind}:${entry.title}`;
  const presentations = {
    "session:Session created": { Icon: PlusCircle, iconName: "plus-circle", label: "会话状态" },
    "session:Session resumed": { Icon: RotateCcw, iconName: "rotate-ccw", label: "会话状态" },
    "turn:Turn started": { Icon: PlayCircle, iconName: "play-circle", label: "轮次状态" },
  } as const;
  return presentations[key as keyof typeof presentations] ?? (
    entry.kind === "turn"
      ? { Icon: CircleDot, iconName: "circle-dot", label: "轮次状态" }
      : { Icon: Radio, iconName: "radio", label: "会话状态" }
  );
}

function QuestionCard({ api, request, onResolved }: { api: Pick<DesktopApi, "respondQuestion">; request: DesktopQuestionRequest; onResolved: () => void }) {
  const [answer, setAnswer] = useState("");
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string>();
  const respond = async () => {
    const cleanAnswer = answer.trim();
    if (!cleanAnswer) return;
    setResponding(true);
    setError(undefined);
    try { await api.respondQuestion({ runId: request.runId, requestId: request.requestId, answer: cleanAnswer }); onResolved(); }
    catch { setError("回答未能提交，请重试。"); }
    finally { setResponding(false); }
  };
  return <article className="timeline-entry question-inline-card" aria-label="Agent 问题">
    <div className="question-inline-heading"><CircleHelp aria-hidden="true" /><span>Agent 询问</span></div>
    <p className="question-inline-prompt">{request.question}</p>
    <textarea aria-label="回答" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="输入你的回答" rows={3} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!responding && answer.trim()) void respond(); } }} />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <footer><span>Ctrl/⌘ + Enter 提交</span><button type="button" className="primary-button" disabled={responding || !answer.trim()} onClick={() => void respond()}>提交回答</button></footer>
  </article>;
}

function commandState(tool: DesktopToolEvent): string {
  if (tool.status === "running" || !tool.completedAt) return "正在运行";
  const started = tool.startedAt ? new Date(tool.startedAt).valueOf() : Number.NaN;
  const completed = new Date(tool.completedAt).valueOf();
  const seconds = Number.isFinite(started)
    ? Math.max(1, Math.round((completed - started) / 1000))
    : 1;
  return `已在 ${seconds}s 内运行`;
}

function commandPreview(tool: DesktopToolEvent): string {
  if (!tool.inputPreview) return tool.summary ?? tool.name;
  try {
    const input = JSON.parse(tool.inputPreview) as Record<string, unknown>;
    if (typeof input.command === "string") return input.command;
  } catch {
    // Truncated previews remain useful as fallback labels.
  }
  return tool.inputPreview;
}
