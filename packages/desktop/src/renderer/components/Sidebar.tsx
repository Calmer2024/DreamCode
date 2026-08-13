import { Bot, Folder, History, Pin, PinOff, Settings, SquarePen, Trash2 } from "lucide-react";
import type { WorkspaceGroup } from "../state/desktop-state";
import { ProjectMoreMenu } from "./ProjectMoreMenu";

interface SidebarProps {
  groups: WorkspaceGroup[];
  activeSessionId?: string;
  navigationDisabled: boolean;
  onNewConversation: () => void;
  onOpenHistory: () => void;
  onOpenConfiguration: () => void;
  onOpenSettings: () => void;
  onSaveProject: (project: { workspaceRoot: string; name: string; pinned?: boolean }) => void;
  onOpenWorkspace: (workspaceRoot: string) => void;
  onRemoveWorkspace: (workspaceRoot: string) => void;
  pinnedSessionIds?: string[];
  onDeleteSession: (sessionId: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
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
  onSaveProject,
  onOpenWorkspace,
  onRemoveWorkspace,
  pinnedSessionIds = [],
  onDeleteSession,
  onSetSessionPinned,
  onSelectSession,
}: SidebarProps) {
  const pinnedSessions = new Set(pinnedSessionIds);
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
              <div className="workspace-heading">
                <div className="workspace-name" title={group.workspaceRoot}>
                  <Folder aria-hidden="true" />
                  <span>{group.name ?? lastPathSegment(group.workspaceRoot)}</span>
                </div>
                <ProjectMoreMenu
                  projectName={group.name ?? lastPathSegment(group.workspaceRoot)}
                  pinned={group.pinned === true}
                  onTogglePin={() =>
                    onSaveProject({
                      workspaceRoot: group.workspaceRoot,
                      name: group.name ?? lastPathSegment(group.workspaceRoot),
                      pinned: !group.pinned,
                    })
                  }
                  onOpenWorkspace={() => onOpenWorkspace(group.workspaceRoot)}
                  onRename={() => {
                    const name = window
                      .prompt("项目名称", group.name ?? lastPathSegment(group.workspaceRoot))
                      ?.trim();
                    if (name) onSaveProject({ workspaceRoot: group.workspaceRoot, name });
                  }}
                  onRemove={() => onRemoveWorkspace(group.workspaceRoot)}
                />
              </div>
              <div className="session-list">
                {group.sessions.map((session) => (
                  <div className="session-row" key={session.id}>
                    <button
                      type="button"
                      className="session-item"
                      aria-current={session.id === activeSessionId ? "page" : undefined}
                      data-accent={session.id === activeSessionId ? "purple" : undefined}
                      disabled={navigationDisabled}
                      onClick={() => onSelectSession(session.id)}
                    >
                      {session.title}
                    </button>
                    <div className="session-actions">
                      <button
                        type="button"
                        aria-label={pinnedSessions.has(session.id) ? "取消置顶对话" : "置顶对话"}
                        title={pinnedSessions.has(session.id) ? "取消置顶" : "置顶"}
                        onClick={() =>
                          onSetSessionPinned(session.id, !pinnedSessions.has(session.id))
                        }
                      >
                        {pinnedSessions.has(session.id) ? (
                          <PinOff aria-hidden="true" />
                        ) : (
                          <Pin aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label="删除对话"
                        title="永久删除对话"
                        onClick={() => {
                          if (window.confirm("永久删除该对话及其本地事件、快照和产物？")) {
                            onDeleteSession(session.id);
                          }
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </div>
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
