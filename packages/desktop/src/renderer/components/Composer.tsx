import type { RunMode } from "@dreamcode/shared";
import {
  ArrowUp,
  ClipboardList,
  Folder,
  ShieldAlert,
  ShieldCheck,
  Square,
  Zap,
} from "lucide-react";
import type { DesktopBootstrap } from "../../shared/contracts";
import type { DesktopContextUsage } from "../state/desktop-state";
import { ProviderIcon } from "./ProviderIcon";
import { SelectMenu } from "./SelectMenu";

interface ComposerProps {
  prompt: string;
  mode: RunMode;
  model: string;
  profile?: DesktopBootstrap["profiles"][number];
  preset?: DesktopBootstrap["presets"][number];
  runStatus: string;
  active: boolean;
  starting: boolean;
  canSubmit: boolean;
  workspaceName?: string;
  showWorkspaceContext?: boolean;
  contextUsage?: DesktopContextUsage;
  onPromptChange: (prompt: string) => void;
  onModeChange: (mode: RunMode) => void;
  onModelChange: (model: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}

const modePresentations = {
  plan: { label: "规划模式", Icon: ClipboardList, iconName: "clipboard-list" },
  guided: { label: "引导模式", Icon: ShieldCheck, iconName: "shield-check" },
  yolo: { label: "自动执行", Icon: Zap, iconName: "zap" },
  full: { label: "完全访问", Icon: ShieldAlert, iconName: "shield-alert" },
} satisfies Record<RunMode, { label: string; Icon: typeof ShieldCheck; iconName: string }>;

export function Composer({
  prompt,
  mode,
  model,
  profile,
  preset,
  runStatus,
  active,
  starting,
  canSubmit,
  workspaceName,
  showWorkspaceContext,
  contextUsage,
  onPromptChange,
  onModeChange,
  onModelChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  const modePresentation = modePresentations[mode];
  const ModeIcon = modePresentation.Icon;
  return (
    <section className="composer-stack" aria-label="消息编辑器">
      {showWorkspaceContext && workspaceName ? (
        <div className="composer-context">
          <Folder aria-hidden="true" />
          <span>{workspaceName}</span>
          <small>本地</small>
        </div>
      ) : null}
      <div className="composer">
        <textarea
          aria-label="给 DreamCode 发送消息"
          placeholder="随心输入"
          rows={2}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSubmit && !active && !starting) onSubmit();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-selects">
            <SelectMenu
              label="运行模式"
              value={mode}
              options={Object.entries(modePresentations).map(([value, presentation]) => ({
                value,
                label: presentation.label,
              }))}
              disabled={active || starting}
              accent={mode}
              icon={
                <ModeIcon
                  data-testid="run-mode-icon"
                  data-lucide={modePresentation.iconName}
                  aria-hidden="true"
                />
              }
              onChange={(value) => onModeChange(value as RunMode)}
            />
            <SelectMenu
              label="模型"
              value={model}
              className="model-control"
              icon={profile ? <ProviderIcon provider={profile.provider} size="small" /> : undefined}
              options={modelOptions(profile, preset)}
              disabled={active || starting || !profile}
              onChange={onModelChange}
            />
          </div>
          <span className="run-status" aria-live="polite">
            {statusLabel(starting ? "starting" : runStatus)}
          </span>
          <ContextUsageMeter usage={contextUsage} />
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
              <ArrowUp aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="submit-button"
              aria-label="发送"
              disabled={!canSubmit}
              onClick={onSubmit}
            >
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function ContextUsageMeter({ usage }: { usage?: DesktopContextUsage }) {
  const maxTokens = Math.max(1, usage?.maxTokens ?? 64_000);
  const estimatedTokens = Math.max(0, usage?.estimatedTokens ?? 0);
  const percent = Math.min(100, Math.round((estimatedTokens / maxTokens) * 100));
  const tooltip = usage
    ? `上下文已用 ${percent}% · ${formatTokenCount(estimatedTokens)} / ${formatTokenCount(maxTokens)} tokens`
    : "上下文尚未构建 · 0%";
  return (
    <div
      className="context-usage-meter"
      data-compressed={usage?.compressed === true}
      data-tooltip={tooltip}
      data-tone={percent >= 80 ? "danger" : percent >= 60 ? "warning" : "normal"}
      role="status"
      aria-label={`上下文已用 ${percent}%`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-usage-track" cx="12" cy="12" r="8" pathLength="100" />
        <circle
          className="context-usage-progress"
          cx="12"
          cy="12"
          r="8"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - percent}
        />
      </svg>
    </div>
  );
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function modelOptions(
  profile: DesktopBootstrap["profiles"][number] | undefined,
  preset: DesktopBootstrap["presets"][number] | undefined,
) {
  if (!profile) return [{ value: "", label: "未配置模型" }];
  const options = (preset?.models ?? []).map((item) => ({
    value: item.id,
    label: item.label ?? item.id,
  }));
  if (profile.model && !options.some((item) => item.value === profile.model)) {
    options.unshift({ value: profile.model, label: profile.model });
  }
  return options.length
    ? options
    : [{ value: profile.model ?? "", label: profile.model ?? "未选择模型" }];
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
