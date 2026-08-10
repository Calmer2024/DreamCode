import type { RunMode } from "@dreamcode/shared";
import { ChevronDown, Send, ShieldCheck, Square } from "lucide-react";
import type { DesktopBootstrap } from "../../shared/contracts";

interface ComposerProps {
  prompt: string;
  mode: RunMode;
  profileName: string;
  profiles: DesktopBootstrap["profiles"];
  runStatus: string;
  active: boolean;
  starting: boolean;
  canSubmit: boolean;
  onPromptChange: (prompt: string) => void;
  onModeChange: (mode: RunMode) => void;
  onProfileChange: (profileName: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}

const modeLabels: Record<RunMode, string> = {
  plan: "规划模式",
  guided: "引导模式",
  yolo: "自动执行",
  full: "完全访问",
};

export function Composer({
  prompt,
  mode,
  profileName,
  profiles,
  runStatus,
  active,
  starting,
  canSubmit,
  onPromptChange,
  onModeChange,
  onProfileChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  return (
    <section className="composer" aria-label="消息编辑器">
      <textarea
        aria-label="给 DreamCode 发送消息"
        placeholder="描述任务，按 Ctrl+Enter 发送"
        rows={3}
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.ctrlKey && event.key === "Enter") {
            event.preventDefault();
            if (canSubmit && !active && !starting) onSubmit();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-selects">
          <label className="select-control">
            <ShieldCheck
              data-testid="run-mode-icon"
              data-lucide="shield-check"
              aria-hidden="true"
            />
            <span className="sr-only">运行模式</span>
            <select
              aria-label="运行模式"
              data-accent={mode === "yolo" || mode === "full" ? "orange" : undefined}
              value={mode}
              disabled={active || starting}
              onChange={(event) => onModeChange(event.target.value as RunMode)}
            >
              {Object.entries(modeLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDown className="select-chevron" aria-hidden="true" />
          </label>
          <label className="select-control model-control">
            <span className="sr-only">模型配置</span>
            <select
              aria-label="模型配置"
              value={profileName}
              disabled={active || starting || profiles.length === 0}
              onChange={(event) => onProfileChange(event.target.value)}
            >
              {profiles.length === 0 ? <option value="">未配置模型</option> : null}
              {profiles.map((profile) => (
                <option value={profile.name} key={profile.name}>
                  {profile.model ?? profile.name}
                </option>
              ))}
            </select>
            <ChevronDown className="select-chevron" aria-hidden="true" />
          </label>
        </div>
        <span className="run-status" aria-live="polite">
          {statusLabel(starting ? "starting" : runStatus)}
        </span>
        {active ? (
          <button
            type="button"
            className="submit-button stop-button"
            aria-label="停止"
            onClick={onStop}
          >
            <Square aria-hidden="true" />
          </button>
        ) : starting ? (
          <button type="button" className="submit-button" aria-label="正在启动" disabled>
            <Send aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="submit-button"
            aria-label="发送"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            <Send aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "正在运行";
    case "starting":
      return "正在启动";
    case "completed":
      return "已完成";
    case "failed":
      return "运行失败";
    case "interrupted":
      return "已停止";
    default:
      return "";
  }
}
