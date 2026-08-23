import type { SessionListItem } from "@dreamcode/store";
import {
  Check,
  ChevronDown,
  Folder,
  HelpCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceGroup } from "../state/desktop-state";
import { ProjectMoreMenu } from "./ProjectMoreMenu";

interface SidebarProps {
  groups: WorkspaceGroup[];
  pinnedSessions?: SessionListItem[];
  activeSessionId?: string;
  navigationDisabled: boolean;
  onNewConversation: (workspaceRoot?: string) => void;
  onCreateProject: () => void;
  onOpenSettings: () => void;
  onSaveProject: (project: { workspaceRoot: string; name: string; pinned?: boolean }) => void;
  onOpenWorkspace: (workspaceRoot: string) => void;
  onRemoveWorkspace: (workspaceRoot: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
  onSelectSession: (sessionId: string) => void;
  renameWorkspaceRoot?: string;
  onRenameWorkspaceHandled?: () => void;
}

export function Sidebar({
  groups,
  pinnedSessions = [],
  activeSessionId,
  navigationDisabled,
  onNewConversation,
  onCreateProject,
  onOpenSettings,
  onSaveProject,
  onOpenWorkspace,
  onRemoveWorkspace,
  onDeleteSession,
  onRenameSession,
  onSetSessionPinned,
  onSelectSession,
  renameWorkspaceRoot,
  onRenameWorkspaceHandled,
}: SidebarProps) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [conversationsExpanded, setConversationsExpanded] = useState(true);
  const [editingProject, setEditingProject] = useState<string>();
  const [projectName, setProjectName] = useState("");
  const projectRenameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingProject) return;
    projectRenameRef.current?.focus();
    projectRenameRef.current?.select();
  }, [editingProject]);

  const beginProjectRename = (group: WorkspaceGroup) => {
    setEditingProject(group.workspaceRoot);
    setProjectName(group.name ?? lastPathSegment(group.workspaceRoot));
  };

  const commitProjectRename = (group: WorkspaceGroup) => {
    const name = projectName.trim();
    if (name) onSaveProject({ workspaceRoot: group.workspaceRoot, name, pinned: group.pinned });
    setEditingProject(undefined);
  };

  useEffect(() => {
    if (!renameWorkspaceRoot) return;
    const group = groups.find((candidate) => candidate.workspaceRoot === renameWorkspaceRoot);
    if (group) {
      setEditingProject(group.workspaceRoot);
      setProjectName(group.name ?? lastPathSegment(group.workspaceRoot));
    }
    onRenameWorkspaceHandled?.();
  }, [groups, renameWorkspaceRoot, onRenameWorkspaceHandled]);

  return (
    <aside className="sidebar" aria-label="DreamCode 导航">
      <div className="brand-row">
        <img className="brand-logo" src="./logo-dreamcode.png" alt="" />
        <span className="brand-wordmark">DreamCode</span>
      </div>

      <nav className="primary-nav" aria-label="主导航">
        <button
          type="button"
          className="nav-item"
          disabled={navigationDisabled}
          onClick={() => onNewConversation()}
        >
          <SquarePen aria-hidden="true" />
          <span>新对话</span>
        </button>
      </nav>

      <div className="workspace-list">
        {pinnedSessions.length ? (
          <>
            <SidebarSectionHeading
              label="置顶"
              expanded={conversationsExpanded}
              onToggle={() => setConversationsExpanded((current) => !current)}
            />
            <div className="projects-collapse" data-expanded={conversationsExpanded}>
              <div className="projects-collapse-inner pinned-conversation-list">
                {pinnedSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    pinned
                    disabled={navigationDisabled}
                    onDelete={onDeleteSession}
                    onRename={onRenameSession}
                    onSetPinned={onSetSessionPinned}
                    onSelect={onSelectSession}
                  />
                ))}
              </div>
            </div>
          </>
        ) : null}

        <div className="projects-heading">
          <span className="sidebar-section-title">项目</span>
          <div className="projects-heading-actions">
            <button
              type="button"
              className="sidebar-section-toggle"
              aria-label={projectsExpanded ? "折叠项目" : "展开项目"}
              aria-expanded={projectsExpanded}
              data-tooltip={projectsExpanded ? "折叠项目" : "展开项目"}
              onClick={() => setProjectsExpanded((current) => !current)}
            >
              <ChevronDown aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="新建项目"
              data-tooltip="新建项目"
              onClick={onCreateProject}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="projects-collapse" data-expanded={projectsExpanded}>
          <div className="projects-collapse-inner">
            {groups.length === 0 ? (
              <p className="sidebar-empty">尚未添加项目</p>
            ) : (
              groups.map((group) => (
                <section className="workspace-group" key={group.workspaceRoot}>
                  <div className="workspace-heading">
                    {editingProject === group.workspaceRoot ? (
                      <form
                        className="inline-rename project-inline-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          commitProjectRename(group);
                        }}
                      >
                        <Folder aria-hidden="true" />
                        <input
                          ref={projectRenameRef}
                          aria-label="项目名称"
                          value={projectName}
                          onChange={(event) => setProjectName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setEditingProject(undefined);
                          }}
                        />
                        <button type="submit" aria-label="保存项目名称" data-tooltip="保存">
                          <Check aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label="取消重命名项目"
                          data-tooltip="取消"
                          onClick={() => setEditingProject(undefined)}
                        >
                          <X aria-hidden="true" />
                        </button>
                      </form>
                    ) : (
                      <>
                        <div className="workspace-name" data-tooltip={group.workspaceRoot}>
                          <Folder aria-hidden="true" />
                          <span>{group.name ?? lastPathSegment(group.workspaceRoot)}</span>
                        </div>
                        <button
                          type="button"
                          className="project-new-conversation"
                          aria-label={`在 ${group.name ?? lastPathSegment(group.workspaceRoot)} 中新对话`}
                          data-tooltip="在此项目中新对话"
                          disabled={navigationDisabled}
                          onClick={() => onNewConversation(group.workspaceRoot)}
                        >
                          <SquarePen aria-hidden="true" />
                        </button>
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
                          onRename={() => beginProjectRename(group)}
                          onRemove={() => onRemoveWorkspace(group.workspaceRoot)}
                        />
                      </>
                    )}
                  </div>
                  <div className="session-list">
                    {group.sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        pinned={false}
                        disabled={navigationDisabled}
                        onDelete={onDeleteSession}
                        onRename={onRenameSession}
                        onSetPinned={onSetSessionPinned}
                        onSelect={onSelectSession}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="sidebar-footer">
        <button type="button" className="settings-button" onClick={onOpenSettings}>
          <Settings aria-hidden="true" />
          <span>设置</span>
        </button>
        <span className="sidebar-help" data-tooltip="帮助" role="img" aria-label="帮助">
          <HelpCircle aria-hidden="true" />
        </span>
      </div>
    </aside>
  );
}

function SidebarSectionHeading({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="projects-heading conversations-heading">
      <span className="sidebar-section-title">{label}</span>
      <div className="projects-heading-actions">
        <button
          type="button"
          className="sidebar-section-toggle"
          aria-label={expanded ? `折叠${label}` : `展开${label}`}
          aria-expanded={expanded}
          data-tooltip={expanded ? `折叠${label}` : `展开${label}`}
          onClick={onToggle}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  pinned,
  disabled,
  onDelete,
  onRename,
  onSetPinned,
  onSelect,
}: {
  session: SessionListItem;
  active: boolean;
  pinned: boolean;
  disabled: boolean;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onSetPinned: (sessionId: string, pinned: boolean) => void;
  onSelect: (sessionId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [title, setTitle] = useState(session.title);
  const renameRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!editing) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = window.setTimeout(() => setConfirmingDelete(false), 3000);
    const resetFromOutsideClick = (event: PointerEvent) => {
      if (!deleteButtonRef.current?.contains(event.target as Node)) setConfirmingDelete(false);
    };
    document.addEventListener("pointerdown", resetFromOutsideClick);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", resetFromOutsideClick);
    };
  }, [confirmingDelete]);

  const commitRename = () => {
    const cleanTitle = title.trim();
    if (cleanTitle && cleanTitle !== session.title) onRename(session.id, cleanTitle);
    else setTitle(session.title);
    setEditing(false);
  };

  return (
    <div className="session-row" data-confirming={confirmingDelete || undefined}>
      {editing ? (
        <form
          className="inline-rename session-inline-rename"
          onSubmit={(event) => {
            event.preventDefault();
            commitRename();
          }}
        >
          <input
            ref={renameRef}
            aria-label="对话名称"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setTitle(session.title);
                setEditing(false);
              }
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          className="session-item"
          aria-current={active ? "page" : undefined}
          data-accent={active ? "purple" : undefined}
          disabled={disabled}
          onClick={() => onSelect(session.id)}
        >
          {session.title}
        </button>
      )}
      {!editing ? (
        <div className="session-actions">
          {!confirmingDelete ? (
            <>
              <button
                type="button"
                aria-label="重命名对话"
                data-tooltip="重命名"
                onClick={() => setEditing(true)}
              >
                <Pencil aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={pinned ? "取消置顶对话" : "置顶对话"}
                data-tooltip={pinned ? "取消置顶" : "置顶"}
                onClick={() => onSetPinned(session.id, !pinned)}
              >
                {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              </button>
            </>
          ) : null}
          <button
            ref={deleteButtonRef}
            type="button"
            className={confirmingDelete ? "session-delete-confirm" : undefined}
            aria-label={confirmingDelete ? "确认删除对话" : "删除对话"}
            data-tooltip={confirmingDelete ? "再次点击永久删除" : "删除"}
            onClick={() => {
              if (confirmingDelete) onDelete(session.id);
              else setConfirmingDelete(true);
            }}
          >
            {confirmingDelete ? <Check aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
