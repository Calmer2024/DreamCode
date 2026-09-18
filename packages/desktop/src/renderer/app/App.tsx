import type { RunMode } from "@dreamcode/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  DesktopApi,
  DesktopAttachment,
  DesktopApprovalRequest,
  DesktopBootstrap,
  DesktopError,
  DesktopQuestionRequest,
  DesktopRunEvent,
  DesktopRunStatus,
  StartTurnRequest,
} from "../../shared/contracts";
import { ApprovalCard } from "../components/ApprovalDialog";
import { Composer } from "../components/Composer";
import { ConfigDialog } from "../components/ConfigDialog";
import { DetailDrawer, type DetailTab } from "../components/DetailDrawer";
import { ProjectCreationDialog } from "../components/ProjectCreationDialog";
import { ProjectRemovalDialog } from "../components/ProjectRemovalDialog";
import { Sidebar } from "../components/Sidebar";
import { TaskHeader } from "../components/TaskHeader";
import { Timeline } from "../components/Timeline";
import { TodoPanel } from "../components/TodoPanel";
import { TooltipLayer } from "../components/TooltipLayer";
import {
  createDesktopState,
  desktopReducer,
  selectPinnedSessions,
  selectTimeline,
  selectWorkspaceGroups,
} from "../state/desktop-state";
import "./app.css";

interface AppProps {
  api?: DesktopApi;
}

export function App({ api = window.dreamcode }: AppProps) {
  const [state, dispatch] = useReducer(desktopReducer, undefined, () => createDesktopState());
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [promptSeed, setPromptSeed] = useState({ value: "", revision: 0 });
  const [draftAttachments, setDraftAttachments] = useState<DesktopAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [mode, setMode] = useState<RunMode>("workspace-write");
  const [profileId, setProfileId] = useState("");
  const [modelId, setModelId] = useState("");
  const [approvalRequest, setApprovalRequest] = useState<DesktopApprovalRequest>();
  const [questionRequest, setQuestionRequest] = useState<DesktopQuestionRequest>();
  const [workspacePendingRemoval, setWorkspacePendingRemoval] = useState<string>();
  const [projectCreationOpen, setProjectCreationOpen] = useState(false);
  const [workspacePendingRename, setWorkspacePendingRename] = useState<string>();
  const startingRef = useRef(false);
  const pendingRunEvents = useRef<DesktopRunEvent[]>([]);
  const pendingRunStatuses = useRef<DesktopRunStatus[]>([]);
  const pendingSubmission = useRef<{
    runId?: string;
    prompt: string;
    attachments: DesktopAttachment[];
  } | undefined>(undefined);
  const liveDraft = useRef("");
  const sessionLoadSequence = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const mainPaneRef = useRef<HTMLElement>(null);
  const composerStackRef = useRef<HTMLDivElement>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const shouldFollowTimeline = useRef(true);
  const pendingScrollFrame = useRef<number | undefined>(undefined);
  const previousTimelineLength = useRef(0);
  const pendingStreamEvents = useRef<DesktopRunEvent[]>([]);
  const pendingStreamFrame = useRef<number | undefined>(undefined);

  const applyDraftStatus = useCallback((status: DesktopRunStatus) => {
    const pending = pendingSubmission.current;
    if (!pending || (pending.runId && pending.runId !== status.runId) || status.status === "running") return;
    if (status.draftRestored) {
      const restoredPrompt =
        liveDraft.current === pending.prompt
          ? pending.prompt
          : [pending.prompt, liveDraft.current].filter((part) => part.length > 0).join("\n\n");
      liveDraft.current = restoredPrompt;
      setPromptSeed((current) => ({ value: restoredPrompt, revision: current.revision + 1 }));
      setDraftAttachments((current) => {
        const restoredIds = new Set(pending.attachments.map((attachment) => attachment.id));
        const merged = [
          ...pending.attachments,
          ...current.filter((attachment) => !restoredIds.has(attachment.id)),
        ];
        if (merged.length > 10) {
          setAttachmentError("回退后的附件草稿超过 10 个，请移除部分附件后再发送。");
        }
        return merged;
      });
    }
    pendingSubmission.current = undefined;
  }, []);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    dispatch({ type: "error", error: undefined });
    try {
      const bootstrap = await api.bootstrap();
      dispatch({ type: "bootstrap.loaded", bootstrap });
      dispatch({
        type: "workspace.selected",
        workspaceRoot: bootstrap.sessions[0]?.workspaceRoot,
      });
      const currentProfile = bootstrap.profiles.find(
        (profile) => profile.id === bootstrap.currentProfileId && isProfileUsable(profile),
      );
      const availableProfile = currentProfile ?? bootstrap.profiles.find(isProfileUsable);
      setProfileId(availableProfile?.id ?? bootstrap.profiles[0]?.id ?? "");
      setModelId(modelForProfile(bootstrap, availableProfile ?? bootstrap.profiles[0]));
    } catch (error) {
      dispatch({ type: "error", error: desktopError(error) });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    const toggleTerminal = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.code !== "Backquote") return;
      event.preventDefault();
      dispatch(
        state.drawer === "terminal"
          ? { type: "drawer.close" }
          : { type: "drawer.open", drawer: "terminal" },
      );
    };
    window.addEventListener("keydown", toggleTerminal);
    return () => window.removeEventListener("keydown", toggleTerminal);
  }, [state.drawer]);

  useEffect(() => {
    const flushStreamEvents = () => {
      const events = pendingStreamEvents.current;
      pendingStreamEvents.current = [];
      // DeepSeek can emit hundreds of tiny chunks per frame. Collapse adjacent chunks before reducing them.
      for (const message of coalesceStreamingEvents(events)) {
        dispatch({ type: "run.event", message });
      }
    };
    const scheduleStreamFlush = () => {
      if (pendingStreamFrame.current !== undefined) return;
      const flush = () => {
        pendingStreamFrame.current = undefined;
        flushStreamEvents();
      };
      pendingStreamFrame.current =
        typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame(flush)
          : window.setTimeout(flush, 16);
    };
    const enqueueRunEvent = (message: DesktopRunEvent) => {
      if (startingRef.current) {
        pendingRunEvents.current.push(message);
        return;
      }
      if (!isStreamingDelta(message)) {
        flushStreamEvents();
        dispatch({ type: "run.event", message });
        return;
      }
      pendingStreamEvents.current.push(message);
      scheduleStreamFlush();
    };
    const unsubscribeRunEvent = api.onRunEvent((message) => {
      enqueueRunEvent(message);
    });
    const unsubscribeRunStatus = api.onRunStatus((status) => {
      if (pendingStreamFrame.current !== undefined) {
        if (typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(pendingStreamFrame.current);
        }
        window.clearTimeout(pendingStreamFrame.current);
        pendingStreamFrame.current = undefined;
      }
      flushStreamEvents();
      if (startingRef.current) {
        pendingRunStatuses.current.push(status);
        return;
      }
      dispatch({ type: "run.status", status });
      applyDraftStatus(status);
      if (status.status !== "running") {
        void api
          .bootstrap()
          .then((bootstrap) => dispatch({ type: "bootstrap.refreshed", bootstrap }))
          .catch(() => undefined);
      }
    });
    const unsubscribeApproval = api.onApprovalRequest(setApprovalRequest);
    const unsubscribeQuestion = api.onQuestionRequest(setQuestionRequest);
    return () => {
      if (pendingStreamFrame.current !== undefined) {
        if (typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(pendingStreamFrame.current);
        }
        window.clearTimeout(pendingStreamFrame.current);
        pendingStreamFrame.current = undefined;
      }
      pendingStreamEvents.current = [];
      unsubscribeRunEvent();
      unsubscribeRunStatus();
      unsubscribeApproval();
      unsubscribeQuestion();
    };
  }, [api, applyDraftStatus]);

  const groups = useMemo(() => selectWorkspaceGroups(state), [state]);
  const pinnedSessions = useMemo(() => selectPinnedSessions(state), [state]);
  const timeline = selectTimeline(state);
  const running = state.runStatus === "running" && Boolean(state.activeRunId);
  const busy = running || starting;
  const approvalPending = Boolean(approvalRequest);
  const selectedProfile = state.profiles.find((profile) => profile.id === profileId);
  const selectedPreset = state.presets.find((preset) => preset.id === selectedProfile?.provider);
  const displayedContextUsage = contextUsageForModel(selectedPreset, modelId, state.contextUsage);
  const profileUsable = Boolean(selectedProfile && isProfileUsable(selectedProfile));
  const canSubmit = Boolean(
    state.workspaceRoot?.trim() &&
      profileUsable &&
      modelId.trim() &&
      draftAttachments.length <= 10 &&
      !busy &&
      !approvalPending,
  );

  const taskTitle =
    state.sessions.find((session) => session.id === state.activeSessionId)?.title ??
    (state.request ? requestTitle(state.request, pendingSubmission.current?.attachments) : undefined) ??
    "新对话";
  const activeProject = state.bootstrap?.projects?.find(
    (project) => project.workspaceRoot === state.workspaceRoot,
  );
  const lastTimelineEntry = timeline.at(-1);
  const timelineRevision = `${timeline.length}:${lastTimelineEntry?.detail?.length ?? 0}:${lastTimelineEntry?.reasoning?.length ?? 0}:${state.request?.prompt ?? ""}`;

  useEffect(() => {
    const mainPane = mainPaneRef.current;
    const composerStack = composerStackRef.current;
    if (!mainPane || !composerStack) return;
    const composer = composerStack.querySelector<HTMLElement>(".composer-stack, .approval-card");
    const todo = composerStack.querySelector<HTMLElement>(".todo-panel");
    if (!composer) return;
    const updateHeight = () => {
      const composerHeight = composer.getBoundingClientRect().height;
      const todoHeight = todo?.getBoundingClientRect().height ?? 0;
      mainPane.style.setProperty("--composer-height", `${composerHeight}px`);
      mainPane.style.setProperty(
        "--timeline-bottom-padding",
        `${composerHeight + (todo ? todoHeight + 30 : 0) + 32}px`,
      );
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(composer);
    if (todo) observer.observe(todo);
    return () => observer.disconnect();
  }, [approvalRequest, loading, state.workspaceRoot, state.activeSessionId, state.request, state.todoItems.length, state.drawer, timeline.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!timelineRevision || !shouldFollowTimeline.current || !container) return;
    previousTimelineLength.current = timeline.length;
    container.scrollTop = container.scrollHeight;
  }, [timelineRevision]);
  const applyBootstrap = useCallback((bootstrap: DesktopBootstrap) => {
    dispatch({ type: "bootstrap.refreshed", bootstrap });
  }, []);

  const discardAttachmentDraft = async (): Promise<boolean> => {
    if (!draftAttachments.length) return true;
    if (!window.confirm("切换后将丢弃尚未发送的附件草稿，是否继续？")) return false;
    await api.discardAttachments(draftAttachments.map((attachment) => attachment.id)).catch(() => undefined);
    setDraftAttachments([]);
    setAttachmentError(undefined);
    return true;
  };

  const chooseWorkspace = async () => {
    if (busy) return;
    if (!(await discardAttachmentDraft())) return;
    try {
      const workspaceRoot = await api.chooseWorkspace();
      if (workspaceRoot) {
        applyBootstrap(
          await api.saveProject({
            workspaceRoot,
            name: lastPathSegment(workspaceRoot),
          }),
        );
        sessionLoadSequence.current += 1;
        dispatch({ type: "workspace.selected", workspaceRoot });
      }
    } catch (error) {
      dispatch({ type: "error", error: desktopError(error) });
    }
  };

  const submit = async (submittedInput: string): Promise<boolean> => {
    const cleanPrompt = submittedInput.trim();
    if ((!cleanPrompt && !draftAttachments.length) || !state.workspaceRoot || !profileUsable || busy || startingRef.current)
      return false;
    const request: StartTurnRequest = {
      prompt: cleanPrompt,
      workspaceRoot: state.workspaceRoot,
      mode,
      profileId,
      model: modelId,
      ...(draftAttachments.length ? { attachmentIds: draftAttachments.map((attachment) => attachment.id) } : {}),
      ...(state.activeSessionId ? { sessionId: state.activeSessionId } : {}),
    };
    startingRef.current = true;
    pendingRunEvents.current = [];
    pendingRunStatuses.current = [];
    setStarting(true);
    pendingSubmission.current = {
      prompt: submittedInput,
      attachments: draftAttachments,
    };
    try {
      const { runId } = await api.startTurn(request);
      let restoredWhileStarting = false;
      pendingSubmission.current = { ...pendingSubmission.current!, runId };
      setDraftAttachments([]);
      setAttachmentError(undefined);
      dispatch({ type: "run.started", runId, request });
      for (const message of pendingRunEvents.current) {
        if (message.runId === runId) dispatch({ type: "run.event", message });
      }
      for (const status of pendingRunStatuses.current) {
        if (status.runId === runId) {
          dispatch({ type: "run.status", status });
          applyDraftStatus(status);
          restoredWhileStarting ||= Boolean(status.draftRestored);
          if (status.status !== "running") {
            void api
              .bootstrap()
              .then(applyBootstrap)
              .catch(() => undefined);
          }
        }
      }
      return !restoredWhileStarting;
    } catch (error) {
      pendingSubmission.current = undefined;
      dispatch({ type: "error", error: desktopError(error) });
      return false;
    } finally {
      pendingRunEvents.current = [];
      pendingRunStatuses.current = [];
      startingRef.current = false;
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!state.activeRunId) return;
    try {
      await api.stopTurn(state.activeRunId);
    } catch (error) {
      dispatch({ type: "error", error: desktopError(error) });
    }
  };

  const selectSession = async (sessionId: string) => {
    if (busy) return;
    const sequence = ++sessionLoadSequence.current;
    dispatch({ type: "session.selected", sessionId });
    try {
      const session = await api.readSession(sessionId);
      if (sequence !== sessionLoadSequence.current) return;
      dispatch({ type: "session.loaded", sessionId, session });
    } catch (error) {
      if (sequence !== sessionLoadSequence.current) return;
      dispatch({ type: "error", error: desktopError(error) });
    }
  };

  const newConversation = async (workspaceRoot?: string) => {
    if (!(await discardAttachmentDraft())) return;
    sessionLoadSequence.current += 1;
    dispatch(
      workspaceRoot ? { type: "workspace.selected", workspaceRoot } : { type: "conversation.new" },
    );
  };

  const saveProject = async (project: {
    workspaceRoot: string;
    name: string;
    pinned?: boolean;
  }) => {
    try {
      applyBootstrap(await api.saveProject(project));
    } catch (error) {
      dispatch({ type: "error", error: desktopError(error) });
    }
  };

  const removeWorkspace = async (workspaceRoot: string) => {
    if (state.workspaceRoot === workspaceRoot && !(await discardAttachmentDraft())) return;
    try {
      applyBootstrap(await api.deleteProject(workspaceRoot));
      if (state.workspaceRoot === workspaceRoot) {
        sessionLoadSequence.current += 1;
        dispatch({ type: "workspace.selected" });
      }
      setWorkspacePendingRemoval(undefined);
    } catch (error) {
      dispatch({ type: "error", error: desktopError(error) });
    }
  };

  const trackScrollPosition = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (pendingScrollFrame.current !== undefined) {
      window.cancelAnimationFrame(pendingScrollFrame.current);
      pendingScrollFrame.current = undefined;
    }
    shouldFollowTimeline.current =
      container.scrollHeight - container.scrollTop - container.clientHeight <= 120;
  };

  const drawerTab: DetailTab = state.drawer === "terminal" ? "terminal" : "logs";

  if ((state.dialog?.type === "profile" || state.dialog?.type === "settings") && state.bootstrap) {
    return (
      <ConfigDialog
        api={api}
        bootstrap={state.bootstrap}
        open
        initialSection={state.dialog.type === "settings" ? "general" : "model"}
        workspaceRoot={state.workspaceRoot}
        activeProfileId={profileId}
        onClose={() => dispatch({ type: "dialog.set" })}
        onApplyProfile={(nextProfileId) => {
          const nextProfile = state.bootstrap?.profiles.find(
            (profile) => profile.id === nextProfileId && isProfileUsable(profile),
          );
          if (!nextProfile || !state.bootstrap) return;
          setProfileId(nextProfile.id);
          setModelId(modelForProfile(state.bootstrap, nextProfile));
        }}
        onSaved={(bootstrap) => {
          dispatch({ type: "bootstrap.refreshed", bootstrap });
          const retained = bootstrap.profiles.find(
            (profile) => profile.id === profileId && isProfileUsable(profile),
          );
          const currentDefault = bootstrap.profiles.find(
            (profile) => profile.id === bootstrap.currentProfileId && isProfileUsable(profile),
          );
          const nextProfile =
            retained ?? currentDefault ?? bootstrap.profiles.find(isProfileUsable);
          setProfileId(nextProfile?.id ?? "");
          setModelId(modelForProfile(bootstrap, nextProfile));
        }}
      />
    );
  }

  return (
    <>
      <TooltipLayer />
      <div className="app-shell">
        <Sidebar
          groups={groups}
          pinnedSessions={pinnedSessions}
          activeSessionId={state.activeSessionId}
          navigationDisabled={busy}
          onNewConversation={(workspaceRoot) => void newConversation(workspaceRoot)}
          onCreateProject={() => setProjectCreationOpen(true)}
          onOpenSettings={() => dispatch({ type: "dialog.set", dialog: { type: "settings" } })}
          onSaveProject={(project) => void saveProject(project)}
          onOpenWorkspace={(workspaceRoot) => {
            void api.openWorkspace(workspaceRoot).catch((error) => {
              dispatch({ type: "error", error: desktopError(error) });
            });
          }}
          onRemoveWorkspace={setWorkspacePendingRemoval}
          onDeleteSession={(sessionId) => {
            void (async () => {
              if (state.activeSessionId === sessionId && !(await discardAttachmentDraft())) return;
              await api
                .deleteSession(sessionId)
                .then((bootstrap) => {
                  applyBootstrap(bootstrap);
                  if (state.activeSessionId === sessionId) dispatch({ type: "conversation.new" });
                })
                .catch((error) => dispatch({ type: "error", error: desktopError(error) }));
            })();
          }}
          onRenameSession={(sessionId, title) => {
            void api
              .renameSession({ sessionId, title })
              .then(applyBootstrap)
              .catch((error) => dispatch({ type: "error", error: desktopError(error) }));
          }}
          onSetSessionPinned={(sessionId, pinned) => {
            void api
              .setSessionPinned({ sessionId, pinned })
              .then(applyBootstrap)
              .catch((error) => dispatch({ type: "error", error: desktopError(error) }));
          }}
          onSelectSession={(sessionId) => void selectSession(sessionId)}
          renameWorkspaceRoot={workspacePendingRename}
          onRenameWorkspaceHandled={() => setWorkspacePendingRename(undefined)}
        />
        <main ref={mainPaneRef} className={`main-pane${state.drawer ? " drawer-open" : ""}`}>
          <TaskHeader
            taskTitle={taskTitle}
            workspaceRoot={state.workspaceRoot}
            projectName={activeProject?.name}
            projectPinned={activeProject?.pinned}
            workspaceSelectionDisabled={busy}
            onChooseWorkspace={() => void chooseWorkspace()}
            onOpenWorkspace={() => {
              if (!state.workspaceRoot) return;
              void api.openWorkspace(state.workspaceRoot).catch((error) => {
                dispatch({ type: "error", error: desktopError(error) });
              });
            }}
            onToggleProjectPin={() => {
              if (!state.workspaceRoot) return;
              void saveProject({
                workspaceRoot: state.workspaceRoot,
                name: activeProject?.name ?? lastPathSegment(state.workspaceRoot),
                pinned: !activeProject?.pinned,
              });
            }}
            onRenameProject={() => setWorkspacePendingRename(state.workspaceRoot)}
            onRemoveProject={() => setWorkspacePendingRemoval(state.workspaceRoot)}
            onOpenLogs={() => dispatch({ type: "drawer.open", drawer: "logs" })}
            onOpenTerminal={() => dispatch({ type: "drawer.open", drawer: "terminal" })}
          />
          <div
            className="conversation-scroll"
            ref={scrollContainerRef}
            onScroll={trackScrollPosition}
          >
            <div className="conversation">
              {loading ? (
                <div className="loading-state" role="status">
                  正在载入 DreamCode
                </div>
              ) : state.error?.code === "config_load_failed" ? (
                <div className="empty-state error-state" role="alert">
                  <span className="empty-kicker">配置载入失败</span>
                  <h1>无法打开 DreamCode 配置</h1>
                  <p>{state.error.message}</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void loadBootstrap()}
                  >
                    重新加载
                  </button>
                </div>
              ) : (
                <Timeline
                  state={state}
                  workspaceName={projectName(state.bootstrap, state.workspaceRoot)}
                  profileUsable={profileUsable}
                  onPromptSuggestion={(value) =>
                    setPromptSeed((current) => ({ value, revision: current.revision + 1 }))
                  }
                  onConfigure={() => dispatch({ type: "dialog.set", dialog: { type: "profile" } })}
                  onChooseWorkspace={() => void chooseWorkspace()}
                  questionRequest={questionRequest}
                  questionApi={api}
                  mediaApi={api}
                  onQuestionResolved={() => setQuestionRequest(undefined)}
                />
              )}
              <div ref={timelineEndRef} aria-hidden="true" />
            </div>
          </div>
          {state.error && state.error.code !== "config_load_failed" ? (
            <div className="error-banner" role="alert">
              {state.error.message}
            </div>
          ) : null}
          <div ref={composerStackRef} className="composer-stack-anchor">
            {state.todoItems.length ? <TodoPanel items={state.todoItems} /> : null}
            {approvalRequest ? (
              <ApprovalCard
                api={api}
                request={approvalRequest}
                onResolved={() => setApprovalRequest(undefined)}
              />
            ) : (
              <Composer
                key={promptSeed.revision}
                api={api}
                workspaceRoot={state.workspaceRoot}
                prompt={promptSeed.value}
                attachments={draftAttachments}
                attachmentError={attachmentError}
                mode={mode}
                model={modelId}
                profile={selectedProfile}
                preset={selectedPreset}
                runStatus={state.runStatus}
                active={running}
                starting={starting}
                canSubmit={canSubmit}
                workspaceName={projectName(state.bootstrap, state.workspaceRoot)}
                showWorkspaceContext={Boolean(
                  state.workspaceRoot &&
                    !state.activeSessionId &&
                    !state.request &&
                    !timeline.length,
                )}
                contextUsage={displayedContextUsage}
                onPromptChange={(prompt) => {
                  liveDraft.current = prompt;
                }}
                onAttachmentsChange={setDraftAttachments}
                onAttachmentError={setAttachmentError}
                onModeChange={setMode}
                onModelChange={setModelId}
                onSubmit={submit}
                onStop={() => void stop()}
              />
            )}
          </div>
        </main>
        {state.drawer ? (
          <DetailDrawer
            terminalEntries={state.terminalEntries}
            events={state.rawEvents}
            api={api}
            workspaceRoot={state.workspaceRoot}
            initialTab={drawerTab}
            onClose={() => dispatch({ type: "drawer.close" })}
          />
        ) : null}
        {workspacePendingRemoval ? (
          <ProjectRemovalDialog
            projectName={lastPathSegment(workspacePendingRemoval)}
            onCancel={() => setWorkspacePendingRemoval(undefined)}
            onConfirm={() => void removeWorkspace(workspacePendingRemoval)}
          />
        ) : null}
        {projectCreationOpen ? (
          <ProjectCreationDialog
            api={api}
            onCancel={() => setProjectCreationOpen(false)}
            onCreated={(bootstrap, workspaceRoot) => {
              applyBootstrap(bootstrap);
              sessionLoadSequence.current += 1;
              dispatch({ type: "workspace.selected", workspaceRoot });
              setProjectCreationOpen(false);
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function isStreamingDelta(message: DesktopRunEvent): boolean {
  return message.event.type === "model.delta" || message.event.type === "model.reasoning_delta";
}

function coalesceStreamingEvents(events: DesktopRunEvent[]): DesktopRunEvent[] {
  const merged: DesktopRunEvent[] = [];
  for (const message of events) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.runId === message.runId &&
      previous.event.type === message.event.type &&
      isStreamingDelta(previous) &&
      isStreamingDelta(message)
    ) {
      const previousText = streamingDeltaText(previous);
      const nextText = streamingDeltaText(message);
      merged[merged.length - 1] = {
        ...message,
        event: {
          ...message.event,
          payload: { text: previousText + nextText },
        },
      };
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function streamingDeltaText(message: DesktopRunEvent): string {
  const payload = message.event.payload;
  if (!payload || typeof payload !== "object" || !("text" in payload)) return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function projectName(bootstrap: DesktopBootstrap | undefined, workspaceRoot: string | undefined) {
  if (!workspaceRoot) return undefined;
  return (
    bootstrap?.projects?.find((project) => project.workspaceRoot === workspaceRoot)?.name ??
    lastPathSegment(workspaceRoot)
  );
}

function isProfileUsable(profile: { provider: string; credentialAvailable: boolean }): boolean {
  return profile.provider === "fake" || profile.credentialAvailable;
}

function modelForProfile(
  bootstrap: DesktopBootstrap,
  profile: DesktopBootstrap["profiles"][number] | undefined,
): string {
  if (!profile) return "";
  return (
    profile.model ??
    bootstrap.presets.find((preset) => preset.id === profile.provider)?.defaultModel ??
    ""
  );
}

function requestTitle(
  request: StartTurnRequest,
  attachments: DesktopAttachment[] | undefined,
): string {
  if (request.prompt.trim()) return request.prompt.trim();
  const first = attachments?.[0];
  if (!first) return "分析多模态附件";
  return first.name.toLowerCase().startsWith("pasted-image")
    ? "分析粘贴的图片"
    : `分析 ${first.name}`;
}

function contextUsageForModel(
  preset: DesktopBootstrap["presets"][number] | undefined,
  model: string,
  current: { estimatedTokens: number; maxTokens: number; compressed: boolean } | undefined,
) {
  const configured = preset?.models?.find((candidate) => candidate.id === model)?.contextWindowTokens;
  const maxTokens = configured ?? current?.maxTokens ?? 64_000;
  return current ? { ...current, maxTokens } : { estimatedTokens: 0, maxTokens, compressed: false };
}

function desktopError(error: unknown): DesktopError {
  if (error && typeof error === "object") {
    const candidate = error as Partial<DesktopError>;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string" &&
      typeof candidate.recoverable === "boolean"
    ) {
      return candidate as DesktopError;
    }
  }
  return { code: "renderer_error", message: "操作未能完成，请重试。", recoverable: true };
}
