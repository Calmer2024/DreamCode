import type { RunMode } from "@dreamcode/shared";
import {
  ArrowUp,
  ClipboardList,
  Folder,
  Image as ImageIcon,
  Music,
  Paperclip,
  Puzzle,
  ShieldAlert,
  ShieldCheck,
  Square,
  Video,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  DesktopApi,
  DesktopAttachment,
  DesktopAttachmentImportResult,
  DesktopBootstrap,
  DesktopSkillItem,
} from "../../shared/contracts";
import type { DesktopContextUsage } from "../state/desktop-state";
import { ProviderIcon } from "./ProviderIcon";
import { SelectMenu } from "./SelectMenu";

interface ComposerProps {
  prompt: string;
  attachments?: DesktopAttachment[];
  attachmentError?: string;
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
  api?: Pick<DesktopApi, "listSkills"> & Partial<Pick<DesktopApi, "chooseAttachments" | "stageAttachmentBytes" | "readAttachment" | "discardAttachments">>;
  workspaceRoot?: string;
  onPromptChange: (prompt: string) => void;
  onAttachmentsChange?: (attachments: DesktopAttachment[]) => void;
  onAttachmentError?: (message?: string) => void;
  onModeChange: (mode: RunMode) => void;
  onModelChange: (model: string) => void;
  onSubmit: (prompt: string) => Promise<boolean>;
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
  attachments = [],
  attachmentError,
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
  onAttachmentsChange = () => undefined,
  onAttachmentError = () => undefined,
  onModeChange,
  onModelChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  const [draft, setDraft] = useState(prompt);
  const [skills, setSkills] = useState<DesktopSkillItem[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [importingAttachments, setImportingAttachments] = useState(false);
  const [draggingAttachmentId, setDraggingAttachmentId] = useState<string>();
  const suggestionListId = useId();
  const suggestionListRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => setDraft(prompt), [prompt]);
  const invocation = /(^|\s)([/$])([A-Za-z0-9_.-]*)$/.exec(draft);
  const suggestions = useMemo(() => {
    if (!invocation || suggestionsDismissed) return [];
    const query = invocation[3]?.toLocaleLowerCase() ?? "";
    return skills
      .filter((skill) => skill.enabled && skill.valid && skill.resolution === "resolved")
      .filter((skill) => !query || `${skill.invocationName ?? skill.name} ${skill.name}`.toLocaleLowerCase().includes(query));
  }, [invocation?.[0], skills, suggestionsDismissed]);
  useEffect(() => {
    setActiveSuggestion(0);
    setSuggestionsDismissed(false);
  }, [invocation?.[0]]);
  useEffect(() => {
    const activeOption = suggestionListRef.current?.querySelector<HTMLElement>(
      `[id="${suggestionListId}-${activeSuggestion}"]`,
    );
    activeOption?.scrollIntoView?.({ block: "nearest" });
  }, [activeSuggestion, suggestionListId, suggestions.length]);
  const chooseSuggestion = (skill: DesktopSkillItem) => {
    if (!invocation) return;
    const start = draft.length - invocation[0].length;
    const prefix = invocation[1] ?? "";
    const marker = invocation[2] ?? "$";
    const nextDraft = `${draft.slice(0, start)}${prefix}${marker}${skill.invocationName ?? skill.name} `;
    setDraft(nextDraft);
    onPromptChange(nextDraft);
  };
  const submitDraft = async () => {
    const submittedDraft = draft;
    if ((!submittedDraft.trim() && !attachments.length) || !canSubmit || active || starting) return;
    const accepted = await onSubmit(submittedDraft);
    if (accepted !== false) {
      setDraft((current) => {
        if (current !== submittedDraft) return current;
        onPromptChange("");
        return "";
      });
    }
  };
  const modePresentation = modePresentations[mode];
  const ModeIcon = modePresentation.Icon;
  return (
    <section
      className="composer-stack"
      aria-label="消息编辑器"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        void importFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {invocation && suggestions.length ? (
        <div
          className="skill-suggestions"
          id={suggestionListId}
          ref={suggestionListRef}
          role="listbox"
          aria-label="技能建议"
        >
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
        {attachments.length ? (
          <div className="composer-attachments" aria-label="待发送附件">
            {attachments.map((attachment, index) => (
              <div
                className="composer-attachment"
                aria-label={`附件 ${index + 1}：${attachment.name}`}
                draggable
                key={attachment.id}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.dropEffect = "move";
                  setDraggingAttachmentId(attachment.id);
                }}
                onDragEnd={() => setDraggingAttachmentId(undefined)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!draggingAttachmentId || draggingAttachmentId === attachment.id) return;
                  const from = attachments.findIndex((item) => item.id === draggingAttachmentId);
                  const to = attachments.findIndex((item) => item.id === attachment.id);
                  if (from < 0 || to < 0) return;
                  const next = [...attachments];
                  const [moved] = next.splice(from, 1);
                  if (moved) next.splice(to, 0, moved);
                  onAttachmentsChange(next);
                }}
              >
                <DraftAttachmentPreview api={api} attachment={attachment} />
                <button
                  type="button"
                  aria-label={`移除附件 ${attachment.name}`}
                  onClick={() => {
                    void api?.discardAttachments?.([attachment.id]);
                    onAttachmentsChange(attachments.filter((item) => item.id !== attachment.id));
                  }}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachmentError ? <p className="attachment-error" role="alert">{attachmentError}</p> : null}
        <textarea
          aria-label="给 DreamCode 发送消息"
          placeholder="随心输入"
          rows={2}
          value={draft}
          aria-controls={suggestions.length ? suggestionListId : undefined}
          aria-activedescendant={suggestions.length ? `${suggestionListId}-${activeSuggestion}` : undefined}
          aria-expanded={suggestions.length > 0}
          onFocus={refreshSkills}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (!files.length) return;
            event.preventDefault();
            void importFiles(files, true);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            onPromptChange(event.target.value);
          }}
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
              void submitDraft();
            }
          }}
          />
        <div className="composer-toolbar">
          <div className="composer-selects">
            <button
              type="button"
              className="attachment-button"
              aria-label="添加附件"
              data-tooltip="添加图片、MP3 或 MP4"
              disabled={importingAttachments}
              onClick={() => void chooseAttachments()}
            >
              <Paperclip aria-hidden="true" />
            </button>
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
              disabled={!canSubmit || (!draft.trim() && !attachments.length)}
              onClick={() => void submitDraft()}
            >
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </section>
  );

  async function chooseAttachments() {
    if (!api?.chooseAttachments) return;
    setImportingAttachments(true);
    try {
      applyImportResult(await api.chooseAttachments(attachments));
    } finally {
      setImportingAttachments(false);
    }
  }

  async function importFiles(files: File[], pasted = false) {
    if (!api?.stageAttachmentBytes || !files.length) return;
    setImportingAttachments(true);
    try {
      const payload = await Promise.all(files.map(async (file, index) => {
        if (pasted && file.type.startsWith("image/")) {
          return {
            name: `pasted-image-${index + 1}.png`,
            bytes: await clipboardImageAsPng(file),
          };
        }
        return {
          name: file.name || "attachment",
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }));
      applyImportResult(await api.stageAttachmentBytes({ files: payload, existing: attachments }));
    } catch {
      onAttachmentError("附件读取失败，请重试。");
    } finally {
      setImportingAttachments(false);
    }
  }

  function applyImportResult(result: DesktopAttachmentImportResult) {
    if (result.attachments.length) onAttachmentsChange([...attachments, ...result.attachments]);
    onAttachmentError(result.errors.length
      ? result.errors.map((error) => `${error.name}：${error.message}`).join("\n")
      : undefined);
  }
}

function DraftAttachmentPreview({
  api,
  attachment,
}: {
  api?: Partial<Pick<DesktopApi, "readAttachment">>;
  attachment: DesktopAttachment;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    void api?.readAttachment?.({ attachmentId: attachment.id }).then((bytes) => {
      if (!active) return;
      const copy = bytes;
      const buffer = new ArrayBuffer(copy.byteLength);
      new Uint8Array(buffer).set(copy);
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: attachment.mimeType }));
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, attachment.id, attachment.mimeType]);
  if (url && attachment.kind === "image") return <img src={url} alt="" />;
  if (url && attachment.kind === "audio") return <audio src={url} controls preload="metadata" />;
  if (url && attachment.kind === "video") return <video src={url} controls preload="metadata" />;
  const Icon = attachment.kind === "image" ? ImageIcon : attachment.kind === "audio" ? Music : Video;
  return <span className="attachment-placeholder"><Icon aria-hidden="true" /></span>;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function clipboardImageAsPng(file: File): Promise<Uint8Array> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new Error("Clipboard image conversion is unavailable.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed.")), "image/png");
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
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
