import type { ChangedFile, MediaAttachment } from "@dreamcode/shared";
import {
  Activity,
  BrainCircuit,
  Bug,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleStop,
  CircleX,
  Clock,
  Copy,
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
import { memo, type ReactNode, useEffect, useId, useRef, useState } from "react";
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
import { useAutoGrowingTextarea } from "./useAutoGrowingTextarea";

interface TimelineProps {
  state: DesktopState;
  profileUsable: boolean;
  workspaceName?: string;
  onPromptSuggestion?: (prompt: string) => void;
  onConfigure: () => void;
  onChooseWorkspace: () => void;
  questionRequest?: DesktopQuestionRequest;
  questionApi?: Pick<DesktopApi, "respondQuestion">;
  mediaApi?: Pick<DesktopApi, "readAttachment">;
  onQuestionResolved?: () => void;
}

export const Timeline = memo(function Timeline({
  state,
  profileUsable,
  workspaceName,
  onPromptSuggestion = () => undefined,
  onConfigure,
  onChooseWorkspace,
  questionRequest,
  questionApi,
  mediaApi,
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
      {conversationBlocks(state.timeline, state.tools, state.turnUsage, state.changedFilesByTurn, mediaApi)}
      {questionRequest && questionApi && onQuestionResolved ? (
        <QuestionCard api={questionApi} request={questionRequest} onResolved={onQuestionResolved} />
      ) : null}
    </section>
  );
});

function conversationBlocks(
  entries: DesktopTimelineEntry[],
  tools: DesktopToolEvent[],
  turnUsage: Record<string, DesktopTurnUsage>,
  _changedFilesByTurn: Record<string, ChangedFile[]>,
  mediaApi?: Pick<DesktopApi, "readAttachment">,
): ReactNode[] {
  const blocks: ReactNode[] = [];
  const pendingActivity: ActivityBlock[] = [];
  const terminalTurns = new Set(
    entries.filter((entry) => isTerminalEntry(entry) && entry.turnId).map((entry) => entry.turnId as string),
  );
  const turnTimings = new Map<string, { start: number; end?: number }>();
  for (const entry of entries) {
    if (!entry.turnId) continue;
    const timestamp = new Date(entry.timestamp).valueOf();
    if (!Number.isFinite(timestamp)) continue;
    const timing = turnTimings.get(entry.turnId);
    turnTimings.set(entry.turnId, {
      start: timing ? Math.min(timing.start, timestamp) : timestamp,
      end: isTerminalEntry(entry) ? timestamp : timing?.end,
    });
  }
  const activeTurnId = [...turnTimings.keys()].reverse().find((turnId) => !terminalTurns.has(turnId));
  const assistantOutputsByTurn = new Map<string, DesktopTimelineEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== "assistant" || !entry.detail?.trim() || !entry.turnId) continue;
    const outputs = assistantOutputsByTurn.get(entry.turnId) ?? [];
    outputs.push(entry);
    assistantOutputsByTurn.set(entry.turnId, outputs);
  }
  const lastAssistantOutputByTurn = new Map<string, string>();
  for (const [turnId, outputs] of assistantOutputsByTurn) {
    const last = outputs.at(-1);
    if (!last) continue;
    lastAssistantOutputByTurn.set(turnId, last.id);
  }
  const renderedWorkTime = new Set<string>();
  const renderedTools = new Set<string>();
  const completedTurnHistory = new Map<string, ReactNode[]>();
  const isCompletedTurn = (turnId: string | undefined) =>
    Boolean(turnId && terminalTurns.has(turnId) && lastAssistantOutputByTurn.has(turnId));
  const pushBlock = (node: ReactNode, turnId?: string) => {
    const history = turnId ? completedTurnHistory.get(turnId) : undefined;
    if (history) {
      history.push(node);
    } else {
      blocks.push(node);
    }
  };
  const flushActivity = () => {
    const first = pendingActivity.at(0);
    if (!first) return;
    if (pendingActivity.length === 1) {
      pushBlock(first.node, first.turnId);
    } else {
      pushBlock(
        <ActivityGroup
          active={first.active}
          items={pendingActivity.map((item) => item.node)}
          key={`activity-${first.kind}-${first.key}`}
          kind={first.kind}
          running={pendingActivity.some((item) => item.running)}
        />,
        first.turnId,
      );
    }
    pendingActivity.length = 0;
  };
  const queueActivity = (activity: ActivityBlock) => {
    const first = pendingActivity.at(0);
    if (first && (first.kind !== activity.kind || first.turnId !== activity.turnId)) {
      flushActivity();
    }
    ensureWorkTime(activity.turnId);
    pendingActivity.push(activity);
  };
  const ensureWorkTime = (turnId: string | undefined) => {
    if (!turnId || renderedWorkTime.has(turnId)) return;
    const timing = turnTimings.get(turnId);
    if (!timing) return;
    renderedWorkTime.add(turnId);
    if (isCompletedTurn(turnId)) {
      const history: ReactNode[] = [];
      completedTurnHistory.set(turnId, history);
      blocks.push(
        <CompletedTurnHistory
          end={timing.end}
          items={history}
          key={`working-${turnId}`}
          start={timing.start}
        />,
      );
      return;
    }
    blocks.push(<TurnWorkingTime active end={timing.end} key={`working-${turnId}`} start={timing.start} />);
  };

  for (const entry of entries) {
    if (entry.kind === "session" || entry.kind === "turn") continue;
    if (entry.kind === "user") {
      flushActivity();
      blocks.push(<TimelineItem entry={entry} mediaApi={mediaApi} key={entry.id} />);
      continue;
    }
    if (entry.kind === "assistant") {
      const isLastAssistant = Boolean(entry.turnId && lastAssistantOutputByTurn.get(entry.turnId) === entry.id);
      const node = (
        <TimelineItem
          entry={entry}
          mediaApi={mediaApi}
          usage={isLastAssistant && entry.turnId ? turnUsage[entry.turnId] : undefined}
          key={entry.id}
        />
      );
      if (isReasoningOnlyEntry(entry)) {
        queueActivity({
          active: entry.turnId === activeTurnId,
          key: entry.id,
          kind: "think",
          node,
          running: entry.turnId === activeTurnId,
          turnId: entry.turnId,
        });
      } else {
        flushActivity();
        ensureWorkTime(entry.turnId);
        if (isLastAssistant) {
          blocks.push(node);
        } else {
          pushBlock(node, entry.turnId);
        }
      }
      continue;
    }
    if (entry.kind === "tool") {
      const tool = toolForTimelineEntry(entry, tools, renderedTools);
      if (tool) {
        renderedTools.add(tool.id);
        queueActivity({
          active: entry.turnId === activeTurnId,
          key: tool.id,
          kind: "tool",
          node: <CommandRow tool={tool} key={`tool-${tool.id}`} />,
          running: tool.status === "queued" || tool.status === "running",
          turnId: entry.turnId,
        });
      }
      continue;
    }
    if (entry.title === "Skill loaded") {
      const skillTool = tools.find((tool) =>
        tool.turnId === entry.turnId && tool.name === "skill" && !renderedTools.has(tool.id),
      );
      const tool = skillTool ?? skillToolFromEntry(entry);
      if (skillTool) {
        renderedTools.add(skillTool.id);
      }
      queueActivity({
        active: entry.turnId === activeTurnId,
        key: tool.id,
        kind: "tool",
        node: <CommandRow tool={tool} key={`tool-${tool.id}`} />,
        running: tool.status === "queued" || tool.status === "running",
        turnId: entry.turnId,
      });
      continue;
    }
    if (isTerminalEntry(entry) && entry.title !== "Turn completed") {
      flushActivity();
      ensureWorkTime(entry.turnId);
      blocks.push(<TimelineItem entry={entry} mediaApi={mediaApi} key={entry.id} />);
    }
  }

  flushActivity();
  const hasRunningTool = activeTurnId
    ? tools.some((tool) => tool.turnId === activeTurnId && (tool.status === "queued" || tool.status === "running"))
    : false;
  const hasAssistantOutput = activeTurnId
    ? entries.some((entry) =>
        entry.kind === "assistant" &&
        entry.turnId === activeTurnId &&
        Boolean(entry.detail?.trim() || entry.reasoning?.trim()),
      )
    : false;
  if (activeTurnId && !hasRunningTool && !hasAssistantOutput) {
    ensureWorkTime(activeTurnId);
    blocks.push(
      <div className="execution-live-status" role="status" aria-live="polite" key={`thinking-${activeTurnId}`}>
        <span className="status-shimmer">正在思考</span>
      </div>,
    );
  }
  return blocks;
}

type ActivityKind = "think" | "tool";

interface ActivityBlock {
  active: boolean;
  key: string;
  kind: ActivityKind;
  node: ReactNode;
  running: boolean;
  turnId?: string;
}

const ActivityGroup = memo(function ActivityGroup({
  active,
  items,
  kind,
  running,
}: {
  active: boolean;
  items: ReactNode[];
  kind: ActivityKind;
  running: boolean;
}) {
  const [open, setOpen] = useState(() => kind === "tool" && active);
  const previousActive = useRef(active);
  const isThink = kind === "think";
  const label = isThink ? "Think" : "工具调用";
  const countLabel = isThink ? `${items.length} 段` : `${items.length} 项`;

  useEffect(() => {
    if (previousActive.current && !active) {
      setOpen(false);
    }
    previousActive.current = active;
  }, [active]);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={`activity-group activity-group-${kind}`}
      data-testid={`activity-group-${kind}`}
    >
      <summary aria-label={`${label}，${countLabel}`}>
        {isThink ? <BrainCircuit aria-hidden="true" /> : <Wrench aria-hidden="true" />}
        <span className={running ? "status-shimmer" : undefined}>{label}</span>
        <span className="activity-group-count">{countLabel}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="activity-group-rows">{items}</div>
    </details>
  );
});

const CompletedTurnHistory = memo(function CompletedTurnHistory({
  end,
  items,
  start,
}: {
  end?: number;
  items: ReactNode[];
  start: number;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) {
    return <TurnWorkingTime active={false} end={end} start={start} />;
  }
  const elapsed = formatElapsedMilliseconds(Math.max(0, (end ?? Date.now()) - start));
  return (
    <details
      className="turn-history"
      data-testid="turn-history"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={`已工作 ${elapsed}，展开历史内容`}>
        <span>{`已工作 ${elapsed}`}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="turn-history-content">{items}</div>
    </details>
  );
});

function TurnWorkingTime({ start, end, active }: { start: number; end?: number; active: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);

  return (
    <div className="turn-working-time" data-testid="turn-working-time">
      <span>{`已工作 ${formatElapsedMilliseconds(Math.max(0, (end ?? now) - start))}`}</span>
    </div>
  );
}

function isTerminalEntry(entry: DesktopTimelineEntry): boolean {
  return entry.kind === "status" && (
    entry.title === "Turn completed" ||
    entry.title === "Turn failed" ||
    entry.title === "Turn interrupted"
  );
}

function isReasoningOnlyEntry(entry: DesktopTimelineEntry): boolean {
  return Boolean(entry.reasoning?.trim()) && !entry.detail?.trim();
}

function toolForTimelineEntry(
  entry: DesktopTimelineEntry,
  tools: DesktopToolEvent[],
  rendered: Set<string>,
): DesktopToolEvent | undefined {
  return tools.find((tool) =>
    !rendered.has(tool.id) && tool.turnId === entry.turnId &&
    (tool.startedAt === entry.timestamp || tool.completedAt === entry.timestamp),
  ) ?? tools.find((tool) =>
    !rendered.has(tool.id) && tool.turnId === entry.turnId &&
    `${entry.title} ${entry.detail ?? ""}`.includes(tool.name),
  );
}

function skillToolFromEntry(entry: DesktopTimelineEntry): DesktopToolEvent {
  return {
    id: entry.id,
    turnId: entry.turnId,
    name: "skill",
    status: "success",
    summary: entry.detail,
    inputPreview: entry.detail,
    startedAt: entry.timestamp,
    completedAt: entry.timestamp,
  };
}

const CommandRow = memo(function CommandRow({ tool }: { tool: DesktopToolEvent }) {
  const running = tool.status === "running" || tool.status === "queued";
  const ToolIcon = tool.name === "skill" ? Wrench : tool.name.startsWith("mcp__") ? Globe : SquareTerminal;
  return (
    <details
      className={`command-row tool-call-row tone-${tool.status}`}
      aria-label={`工具调用：${tool.name}`}
      data-testid="tool-call-row"
    >
      <summary>
        <ToolIcon aria-hidden="true" />
        <span className={`tool-call-label${running ? " status-shimmer" : ""}`}>
          <span className="command-state">{toolAction(tool, running)}</span>
          <span className={running ? "status-shimmer" : undefined}>{toolDisplayText(tool)}</span>
        </span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="command-detail">
        <span className="command-tool">{tool.name}</span>
        {tool.inputPreview ? <pre>{tool.inputPreview}</pre> : null}
        {tool.summary ? <p>{tool.summary}</p> : null}
      </div>
    </details>
  );
});

const TimelineItem = memo(function TimelineItem({
  entry,
  usage,
  liveStatus,
  mediaApi,
}: {
  entry: DesktopTimelineEntry;
  usage?: DesktopTurnUsage;
  liveStatus?: string;
  mediaApi?: Pick<DesktopApi, "readAttachment">;
}) {
  if (entry.kind === "user") {
    return (
      <UserMessage
        content={entry.detail ?? ""}
        timestamp={entry.timestamp}
        attachments={entry.attachments}
        sessionId={entry.sessionId}
        mediaApi={mediaApi}
      />
    );
  }

  if (entry.kind === "assistant") {
    return (
      <article className="timeline-entry assistant-entry" data-testid="timeline-assistant">
        {entry.reasoning ? <AssistantReasoning content={entry.reasoning} /> : null}
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
});

function UserMessage({
  content,
  timestamp,
  attachments = [],
  sessionId,
  mediaApi,
}: {
  content: string;
  timestamp: string;
  attachments?: MediaAttachment[];
  sessionId?: string;
  mediaApi?: Pick<DesktopApi, "readAttachment">;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const collapsible = content.length > 600 || content.split(/\r?\n/).length > 8;
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
      <div className="user-bubble">
        <div
          className={`user-bubble-content${collapsible && !expanded ? " is-collapsed" : ""}`}
          id={contentId}
        >
          {content ? <span>{content}</span> : null}
          {attachments.length ? (
            <div className="message-attachments">
              {attachments.map((attachment, index) => (
                <HistoryAttachment
                  key={attachment.id}
                  attachment={attachment}
                  index={index}
                  sessionId={sessionId}
                  api={mediaApi}
                />
              ))}
            </div>
          ) : null}
        </div>
        {collapsible ? (
          <button
            type="button"
            className="user-message-toggle"
            aria-controls={contentId}
            aria-expanded={expanded}
            aria-label={expanded ? "折叠用户消息" : "展开用户消息"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "收起" : "展开"}
            <ChevronDown aria-hidden="true" />
          </button>
        ) : null}
      </div>
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

function formatElapsedMilliseconds(elapsedMs: number): string {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes ? `${minutes}分钟 ${seconds}秒` : `${seconds}秒`;
}

function HistoryAttachment({
  attachment,
  index,
  sessionId,
  api,
}: {
  attachment: MediaAttachment;
  index: number;
  sessionId?: string;
  api?: Pick<DesktopApi, "readAttachment">;
}) {
  const [url, setUrl] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!api || !sessionId) return;
    let active = true;
    let objectUrl: string | undefined;
    void api.readAttachment({ attachmentId: attachment.id, sessionId }).then((bytes) => {
      if (!active) return;
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: attachment.mimeType }));
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, attachment.id, attachment.mimeType, sessionId]);
  return (
    <figure className="message-attachment">
      {attachment.kind === "image" && url ? (
        <button type="button" className="message-image-button" aria-label={`放大图片 ${attachment.name}`} onClick={() => setExpanded(true)}>
          <img src={url} alt={attachment.name} />
        </button>
      ) : null}
      {attachment.kind === "audio" && url ? <audio src={url} controls preload="metadata" /> : null}
      {attachment.kind === "video" && url ? <video src={url} controls preload="metadata" /> : null}
      {!url ? <div className="message-attachment-loading">正在载入附件…</div> : null}
      <figcaption>
        <strong>附件 {index + 1} · {attachment.name}</strong>
        <small>{attachment.mimeType} · {formatAttachmentSize(attachment.size)}</small>
      </figcaption>
      {expanded && url ? (
        <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={() => setExpanded(false)}>
          <button type="button" aria-label="关闭图片预览" onClick={() => setExpanded(false)}>关闭</button>
          <img src={url} alt={attachment.name} onClick={(event) => event.stopPropagation()} />
        </div>
      ) : null}
    </figure>
  );
}

const AssistantReasoning = memo(function AssistantReasoning({ content }: { content: string }) {
  return (
    <details className="assistant-reasoning" data-testid="assistant-reasoning">
      <summary aria-label="Think">
        <BrainCircuit aria-hidden="true" />
        <span>Think</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="assistant-reasoning-body">
        <MarkdownContent>{content}</MarkdownContent>
      </div>
    </details>
  );
});

function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
  const answerRef = useAutoGrowingTextarea();
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
    <header className="approval-card-heading question-inline-heading">
      <span className="approval-card-icon"><CircleHelp aria-hidden="true" /></span>
      <div>
        <p className="request-card-kicker">需要输入</p>
        <MarkdownContent className="request-markdown request-card-message question-inline-prompt" disableStrong>{request.question}</MarkdownContent>
      </div>
    </header>
    <textarea ref={answerRef} aria-label="回答" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="输入你的回答" rows={3} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!responding && answer.trim()) void respond(); } }} />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <footer><span>Ctrl+Enter 提交</span><button type="button" className="question-submit-button" aria-label="提交回答" title="提交回答" disabled={responding || !answer.trim()} onClick={() => void respond()}><Check aria-hidden="true" /></button></footer>
  </article>;
}

function toolAction(tool: DesktopToolEvent, running: boolean): string {
  if (tool.name === "skill") return running ? "Loading" : "Loaded";
  if (tool.name.startsWith("mcp__")) return running ? "Calling" : "Called";
  return running ? "Running" : "Ran";
}

function toolDisplayText(tool: DesktopToolEvent): string {
  if (!isShellTool(tool.name)) {
    if (tool.name === "skill") return skillName(tool.inputPreview) ?? tool.summary ?? "Skill";
    return tool.name;
  }
  if (!tool.inputPreview) return tool.summary ?? tool.name;
  try {
    const input = JSON.parse(tool.inputPreview) as Record<string, unknown>;
    if (typeof input.command === "string") return input.command;
  } catch {
    // Truncated previews remain useful as fallback labels.
  }
  return tool.inputPreview;
}

function isShellTool(name: string): boolean {
  return name === "shell" || name === "process" || name === "pwsh" || name === "bash";
}

function skillName(inputPreview: string | undefined): string | undefined {
  if (!inputPreview) return undefined;
  try {
    const input = JSON.parse(inputPreview) as Record<string, unknown>;
    if (typeof input.name === "string") return input.name;
  } catch {
    return inputPreview;
  }
  return inputPreview;
}
