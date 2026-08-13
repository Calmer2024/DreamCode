import { X } from "lucide-react";
import { useEffect, useRef } from "react";

interface ProjectRemovalDialogProps {
  projectName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ProjectRemovalDialog({
  projectName,
  onCancel,
  onConfirm,
}: ProjectRemovalDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop project-removal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="dialog-card project-removal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-removal-title"
        aria-describedby="project-removal-description"
      >
        <button type="button" className="dialog-close-button" aria-label="关闭" onClick={onCancel}>
          <X aria-hidden="true" />
        </button>
        <h2 id="project-removal-title">移除 {projectName}?</h2>
        <p id="project-removal-description">
          这会永久删除该项目下的 DreamCode 对话记录，但不会删除你电脑上的项目文件。
        </p>
        <footer className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            取消
          </button>
          <button ref={confirmRef} type="button" className="danger-button" onClick={onConfirm}>
            移除项目
          </button>
        </footer>
      </section>
    </div>
  );
}
