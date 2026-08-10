import type { DesktopState, DesktopTimelineEntry } from "../state/desktop-state";

interface TimelineProps {
  state: DesktopState;
  onConfigure: () => void;
  onChooseWorkspace: () => void;
}

export function Timeline({ state, onConfigure, onChooseWorkspace }: TimelineProps) {
  if (state.profiles.length === 0) {
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
      {state.request ? (
        <article className="timeline-entry user-entry">
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
  if (entry.kind === "assistant") {
    return (
      <article className="timeline-entry assistant-entry">
        <span className="entry-label">DreamCode</span>
        {entry.detail ? <p className="assistant-copy">{entry.detail}</p> : null}
      </article>
    );
  }

  return (
    <article className={`timeline-entry event-entry tone-${entry.tone}`}>
      <div className="event-heading">
        <span>{entry.title}</span>
        <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
      </div>
      {entry.detail ? <p>{entry.detail}</p> : null}
    </article>
  );
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}
