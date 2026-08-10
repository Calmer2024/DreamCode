import { Activity, CircleCheck, CircleDot, FileCode2, Radio, Wrench } from "lucide-react";
import type { DesktopState, DesktopTimelineEntry } from "../state/desktop-state";

interface TimelineProps {
  state: DesktopState;
  profileUsable: boolean;
  onConfigure: () => void;
  onChooseWorkspace: () => void;
}

export function Timeline({ state, profileUsable, onConfigure, onChooseWorkspace }: TimelineProps) {
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
    return (
      <div className="empty-state welcome-state">
        <span className="empty-kicker">DreamCode Desktop</span>
        <h1>准备好一起构建了吗？</h1>
        <p>描述你想完成的任务，DreamCode 会展示思考、工具调用和文件变更。</p>
      </div>
    );
  }

  return (
    <section className="timeline" aria-label="任务时间线">
      {state.request && !state.timeline.some((entry) => entry.kind === "user") ? (
        <article className="timeline-entry user-entry" data-testid="timeline-user">
          <span className="entry-label">你</span>
          <p>{state.request.prompt}</p>
        </article>
      ) : null}
      {state.timeline.map((entry) => (
        <TimelineItem entry={entry} key={entry.id} />
      ))}
    </section>
  );
}

function TimelineItem({ entry }: { entry: DesktopTimelineEntry }) {
  if (entry.kind === "user") {
    return (
      <article className="timeline-entry user-entry" data-testid="timeline-user">
        <span className="entry-label">你</span>
        <p>{entry.detail}</p>
      </article>
    );
  }

  if (entry.kind === "assistant") {
    return (
      <article className="timeline-entry assistant-entry" data-testid="timeline-assistant">
        <span className="entry-label">DreamCode</span>
        {entry.detail ? <p className="assistant-copy">{entry.detail}</p> : null}
      </article>
    );
  }

  if (entry.kind === "tool" || entry.kind === "file") {
    const isTool = entry.kind === "tool";
    const Icon = isTool ? Wrench : FileCode2;
    const label = isTool ? "工具调用" : "文件变更";
    const iconName = isTool ? "wrench" : "file-code-2";
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
    const label =
      entry.kind === "status" ? "运行状态" : entry.kind === "turn" ? "轮次状态" : "会话状态";
    const Icon = entry.kind === "status" ? CircleCheck : entry.kind === "turn" ? CircleDot : Radio;
    return (
      <article
        aria-label={label}
        className={`timeline-entry lifecycle-entry ${entry.kind}-entry tone-${entry.tone}`}
        data-testid={`timeline-${entry.kind}`}
      >
        <Icon aria-hidden="true" />
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
      <Activity aria-hidden="true" />
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

function TimelineTime({ timestamp }: { timestamp: string }) {
  return <time dateTime={timestamp}>{formatTime(timestamp)}</time>;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}
