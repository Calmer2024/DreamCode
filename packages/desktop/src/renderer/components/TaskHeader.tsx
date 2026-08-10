import { Folder, List, PanelRight, SquareTerminal } from "lucide-react";

interface TaskHeaderProps {
  taskTitle: string;
  workspaceRoot?: string;
  workspaceSelectionDisabled: boolean;
  onChooseWorkspace: () => void;
  onOpenDetails: () => void;
  onOpenFiles: () => void;
  onOpenTerminal: () => void;
}

export function TaskHeader({
  taskTitle,
  workspaceRoot,
  workspaceSelectionDisabled,
  onChooseWorkspace,
  onOpenDetails,
  onOpenFiles,
  onOpenTerminal,
}: TaskHeaderProps) {
  return (
    <header className="task-header">
      <div className="task-identity">
        <h2>{taskTitle}</h2>
        <button
          type="button"
          className="workspace-button"
          aria-label={
            workspaceRoot ? `选择工作区：${lastPathSegment(workspaceRoot)}` : "选择工作区"
          }
          disabled={workspaceSelectionDisabled}
          onClick={onChooseWorkspace}
        >
          <Folder aria-hidden="true" />
          <span>{workspaceRoot ? lastPathSegment(workspaceRoot) : "选择工作区"}</span>
        </button>
      </div>
      <div className="header-actions">
        <button type="button" className="icon-button" aria-label="任务详情" onClick={onOpenDetails}>
          <List aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="终端" onClick={onOpenTerminal}>
          <SquareTerminal aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="文件变更" onClick={onOpenFiles}>
          <PanelRight aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
