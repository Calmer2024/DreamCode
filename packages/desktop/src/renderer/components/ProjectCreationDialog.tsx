import { Folder, FolderPlus, X } from "lucide-react";
import { useState } from "react";
import type { DesktopApi, DesktopBootstrap } from "../../shared/contracts";

interface ProjectCreationDialogProps {
  api: DesktopApi;
  onCancel: () => void;
  onCreated: (bootstrap: DesktopBootstrap, workspaceRoot: string) => void;
}

export function ProjectCreationDialog({ api, onCancel, onCreated }: ProjectCreationDialogProps) {
  const [name, setName] = useState("");
  const [sourceRoot, setSourceRoot] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const chooseSource = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const workspaceRoot = await api.chooseWorkspace();
      if (!workspaceRoot) return;
      setSourceRoot(workspaceRoot);
      setName((current) => current || lastPathSegment(workspaceRoot));
    } catch {
      setError("无法选择源文件夹，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const projectName = name.trim();
    if (!projectName || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (sourceRoot) {
        const bootstrap = await api.saveProject({ workspaceRoot: sourceRoot, name: projectName });
        onCreated(bootstrap, sourceRoot);
      } else {
        const result = await api.createProject({ name: projectName });
        onCreated(result.bootstrap, result.workspaceRoot);
      }
    } catch {
      setError("项目创建失败，请检查名称或目录后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop modal-priority project-creation-backdrop">
      <section
        className="project-creation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="创建项目"
      >
        <header>
          <h2>创建项目</h2>
          <button type="button" aria-label="关闭创建项目" onClick={onCancel}>
            <X aria-hidden="true" />
          </button>
        </header>

        <label className="project-name-field">
          <Folder aria-hidden="true" />
          <span className="sr-only">项目名称</span>
          <input
            aria-label="项目名称"
            placeholder="项目名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <h3>源文件夹</h3>
        <button
          type="button"
          className="project-source-picker"
          disabled={busy}
          onClick={() => void chooseSource()}
        >
          <FolderPlus aria-hidden="true" />
          <strong>{sourceRoot ? lastPathSegment(sourceRoot) : "选择现有目录"}</strong>
          <span>{sourceRoot ?? "添加 DreamCode 可读取和编辑的文件夹"}</span>
        </button>

        <button
          type="button"
          className="managed-project-option"
          aria-pressed={!sourceRoot}
          onClick={() => setSourceRoot(undefined)}
        >
          <Folder aria-hidden="true" />
          <span>
            <strong>直接新建</strong>
            <small>在 DreamCode 统一管理的 projects 目录中创建</small>
          </span>
        </button>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <button type="button" className="project-create-cancel" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="project-create-submit"
            disabled={!name.trim() || busy}
            onClick={() => void create()}
          >
            {busy ? "正在创建" : "创建项目"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function lastPathSegment(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}
