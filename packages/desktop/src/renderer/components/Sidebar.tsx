import { Bot, Folder, History, Settings, SquarePen } from "lucide-react";
import type { WorkspaceGroup } from "../state/desktop-state";

interface SidebarProps {
  groups: WorkspaceGroup[];
  activeSessionId?: string;
  navigationDisabled: boolean;
  onNewConversation: () => void;
  onOpenHistory: () => void;
  onOpenConfiguration: () => void;
  onOpenSettings: () => void;
  onSelectSession: (sessionId: string) => void;
}

export function Sidebar({
  groups,
  activeSessionId,
  navigationDisabled,
  onNewConversation,
  onOpenHistory,
  onOpenConfiguration,
  onOpenSettings,
  onSelectSession,
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="DreamCode 导航">
      <div className="brand-row">
        <span className="brand-mark" aria-hidden="true">
          D
        </span>
        <span>DreamCode</span>
      </div>

      <nav className="primary-nav" aria-label="主导航">
        <button
          type="button"
          className="nav-item"
          disabled={navigationDisabled}
          onClick={onNewConversation}
        >
          <SquarePen aria-hidden="true" />
          <span>新对话</span>
        </button>
        <button type="button" className="nav-item" onClick={onOpenHistory}>
          <History aria-hidden="true" />
          <span>会话历史</span>
        </button>
        <button type="button" className="nav-item" onClick={onOpenConfiguration}>
          <Bot data-testid="model-config-icon" data-lucide="bot" aria-hidden="true" />
          <span>模型与配置</span>
        </button>
      </nav>

      <div className="workspace-list">
        <p className="section-label">工作区</p>
        {groups.length === 0 ? (
          <p className="sidebar-empty">尚未选择工作区</p>
        ) : (
          groups.map((group) => (
            <section className="workspace-group" key={group.workspaceRoot}>
              <div className="workspace-name" title={group.workspaceRoot}>
                <Folder aria-hidden="true" />
                <span>{lastPathSegment(group.workspaceRoot)}</span>
              </div>
              <div className="session-list">
                {group.sessions.map((session) => (
                  <button
                    type="button"
                    className="session-item"
                    aria-current={session.id === activeSessionId ? "page" : undefined}
                    disabled={navigationDisabled}
                    key={session.id}
                    onClick={() => onSelectSession(session.id)}
                  >
                    {session.title}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <button type="button" className="settings-button" onClick={onOpenSettings}>
        <Settings aria-hidden="true" />
        <span>设置</span>
      </button>
    </aside>
  );
}

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
