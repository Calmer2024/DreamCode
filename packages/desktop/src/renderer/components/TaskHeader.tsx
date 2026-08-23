import { Folder, ScrollText, SquareTerminal } from "lucide-react";
import { ProjectMoreMenu } from "./ProjectMoreMenu";

interface TaskHeaderProps {
  taskTitle: string;
  workspaceRoot?: string;
  projectName?: string;
  projectPinned?: boolean;
  workspaceSelectionDisabled: boolean;
  onChooseWorkspace: () => void;
  onOpenWorkspace: () => void;
  onToggleProjectPin: () => void;
  onRenameProject: () => void;
  onRemoveProject: () => void;
  onOpenLogs: () => void;
  onOpenTerminal: () => void;
}

export function TaskHeader({
  taskTitle,
  workspaceRoot,
  projectName,
  projectPinned = false,
  workspaceSelectionDisabled,
  onChooseWorkspace,
  onOpenWorkspace,
  onToggleProjectPin,
  onRenameProject,
  onRemoveProject,
  onOpenLogs,
  onOpenTerminal,
}: TaskHeaderProps) {
  return (
    <header className="task-header">
      <div className="task-identity">
        <button
          type="button"
          className="workspace-button"
          aria-label={
            workspaceRoot
              ? `在资源管理器中打开：${projectName ?? lastPathSegment(workspaceRoot)}`
              : "选择工作区"
          }
          disabled={!workspaceRoot && workspaceSelectionDisabled}
          onClick={workspaceRoot ? onOpenWorkspace : onChooseWorkspace}
        >
          <Folder aria-hidden="true" />
          <span className="sr-only">
            {workspaceRoot ? lastPathSegment(workspaceRoot) : "选择工作区"}
          </span>
        </button>
        <h2>{taskTitle}</h2>
        {workspaceRoot ? (
          <ProjectMoreMenu
            projectName={projectName ?? lastPathSegment(workspaceRoot)}
            pinned={projectPinned}
            triggerClassName="header-more-button"
            triggerLabel="当前项目更多操作"
            onTogglePin={onToggleProjectPin}
            onOpenWorkspace={onOpenWorkspace}
            onRename={onRenameProject}
            onRemove={onRemoveProject}
          />
        ) : null}
      </div>
      <div className="header-actions">
        <button type="button" className="icon-button" aria-label="日志" onClick={onOpenLogs}>
          <ScrollText aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="终端" onClick={onOpenTerminal}>
          <SquareTerminal aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
