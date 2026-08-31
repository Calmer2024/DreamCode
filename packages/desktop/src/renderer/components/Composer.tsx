import type { RunMode } from "@dreamcode/shared";
import {
  ArrowUp,
  ClipboardList,
  Folder,
  Puzzle,
  ShieldAlert,
  ShieldCheck,
  Square,
  Zap,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { DesktopApi, DesktopBootstrap, DesktopSkillItem } from "../../shared/contracts";
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
  api?: Pick<DesktopApi, "listSkills">;
  workspaceRoot?: string;
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
  api,
  workspaceRoot,
  onPromptChange,
  onModeChange,
  onModelChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  const [skills, setSkills] = useState<DesktopSkillItem[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const suggestionListId = useId();
  const refreshSkills = () => {
    if (!api) return;
    void api.listSkills(workspaceRoot).then((snapshot) => setSkills(snapshot.skills)).catch(() => undefined);
  };
  useEffect(() => {
    let active = true;
    if (!api) return;
    void api.listSkills(workspaceRoot).then((snapshot) => {
      if (active) setSkills(snapshot.skills);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, workspaceRoot]);
  const invocation = /(^|\s)([/$])([A-Za-z0-9_.-]*)$/.exec(prompt);
  const suggestions = useMemo(() => {
    if (!invocation || suggestionsDismissed) return [];
    const query = invocation[3]?.toLocaleLowerCase() ?? "";
    return skills
      .filter((skill) => skill.enabled && skill.valid && skill.resolution === "resolved")
      .filter((skill) => !query || `${skill.invocationName ?? skill.name} ${skill.name}`.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [invocation?.[0], skills, suggestionsDismissed]);
  useEffect(() => {
    setActiveSuggestion(0);
    setSuggestionsDismissed(false);
  }, [invocation?.[0]]);
  const chooseSuggestion = (skill: DesktopSkillItem) => {
    if (!invocation) return;
    const start = prompt.length - invocation[0].length;
    const prefix = invocation[1] ?? "";
    const marker = invocation[2] ?? "$";
    onPromptChange(`${prompt.slice(0, start)}${prefix}${marker}${skill.invocationName ?? skill.name} `);
  };
  const modePresentation = modePresentations[mode];
  const ModeIcon = modePresentation.Icon;
  return (
    <section className="composer-stack" aria-label="消息编辑器">
      {invocation && suggestions.length ? (
        <div className="skill-suggestions" id={suggestionListId} role="listbox" aria-label="技能建议">
          {suggestions.map((skill, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === activeSuggestion}
              id={`${suggestionListId}-${index}`}
              key={skill.skillId}
              onMouseDown={(event) => {
                event.preventDefault();
                chooseSuggestion(skill);
              }}
              onMouseEnter={() => setActiveSuggestion(index)}
            >
              <PuzzleIcon />
              <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
              <em>{skillSourceLabel(skill.source)}</em>
            </button>
          ))}
        </div>
      ) : null}
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
          aria-controls={suggestions.length ? suggestionListId : undefined}
          aria-activedescendant={suggestions.length ? `${suggestionListId}-${activeSuggestion}` : undefined}
          aria-expanded={suggestions.length > 0}
          onFocus={refreshSkills}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (suggestions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setActiveSuggestion((current) =>
                event.key === "ArrowDown"
                  ? (current + 1) % suggestions.length
                  : (current - 1 + suggestions.length) % suggestions.length,
              );
              return;
            }
            if (suggestions.length && event.key === "Escape") {
              event.preventDefault();
              setSuggestionsDismissed(true);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              const suggestion = suggestions[activeSuggestion];
              if (suggestion) {
                chooseSuggestion(suggestion);
                return;
              }
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
                icon: <presentation.Icon aria-hidden="true" data-lucide={presentation.iconName} />,
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

function skillSourceLabel(source: DesktopSkillItem["source"]): string {
  return ({ built_in: "内置", system: "系统", user: "个人", project: "项目", plugin: "插件" } as const)[source];
}

function PuzzleIcon() {
  return <span className="composer-skill-icon" aria-hidden="true"><Puzzle /></span>;
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
