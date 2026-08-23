import type { RunMode } from "@dreamcode/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  DesktopApi,
  DesktopApprovalRequest,
  DesktopBootstrap,
  DesktopError,
  DesktopQuestionRequest,
  DesktopRunEvent,
  DesktopRunStatus,
  StartTurnRequest,
} from "../../shared/contracts";
import { ApprovalDialog, QuestionDialog } from "../components/ApprovalDialog";
import { Composer } from "../components/Composer";
import { ConfigDialog } from "../components/ConfigDialog";
import { DetailDrawer, type DetailTab } from "../components/DetailDrawer";
import { ProjectCreationDialog } from "../components/ProjectCreationDialog";
import { ProjectRemovalDialog } from "../components/ProjectRemovalDialog";
import { Sidebar } from "../components/Sidebar";
import { TaskHeader } from "../components/TaskHeader";
import { Timeline } from "../components/Timeline";
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
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<RunMode>("guided");
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
  const sessionLoadSequence = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const shouldFollowTimeline = useRef(true);

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
    const unsubscribeRunEvent = api.onRunEvent((message) => {
      if (startingRef.current) {
        pendingRunEvents.current.push(message);
        return;
      }
      dispatch({ type: "run.event", message });
    });
    const unsubscribeRunStatus = api.onRunStatus((status) => {
      if (startingRef.current) {
        pendingRunStatuses.current.push(status);
        return;
      }
      dispatch({ type: "run.status", status });
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
      unsubscribeRunEvent();
      unsubscribeRunStatus();
      unsubscribeApproval();
      unsubscribeQuestion();
    };
  }, [api]);

  const groups = useMemo(() => selectWorkspaceGroups(state), [state]);
  const pinnedSessions = useMemo(() => selectPinnedSessions(state), [state]);
  const timeline = selectTimeline(state);
  const running = state.runStatus === "running" && Boolean(state.activeRunId);
  const busy = running || starting;
  const selectedProfile = state.profiles.find((profile) => profile.id === profileId);
  const selectedPreset = state.presets.find((preset) => preset.id === selectedProfile?.provider);
  const displayedContextUsage = contextUsageForModel(selectedPreset, modelId, state.contextUsage);
  const profileUsable = Boolean(selectedProfile && isProfileUsable(selectedProfile));
  const canSubmit = Boolean(
    prompt.trim() && state.workspaceRoot?.trim() && profileUsable && modelId.trim() && !busy,
  );

  const taskTitle =
    state.sessions.find((session) => session.id === state.activeSessionId)?.title ??
    state.request?.prompt ??
    "新对话";
  const activeProject = state.bootstrap?.projects?.find(
    (project) => project.workspaceRoot === state.workspaceRoot,
  );
  const timelineRevision = `${timeline.length}:${timeline.at(-1)?.detail ?? ""}:${state.request?.prompt ?? ""}`;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (timelineRevision && shouldFollowTimeline.current && container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [timelineRevision]);

  const applyBootstrap = useCallback((bootstrap: DesktopBootstrap) => {
    dispatch({ type: "bootstrap.refreshed", bootstrap });
  }, []);

  const chooseWorkspace = async () => {
    if (busy) return;
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

  const submit = async () => {
    const submittedInput = prompt;
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || !state.workspaceRoot || !profileUsable || busy || startingRef.current)
      return;
    const request: StartTurnRequest = {
      prompt: cleanPrompt,
      workspaceRoot: state.workspaceRoot,
      mode,
      profileId,
      model: modelId,
      ...(state.activeSessionId ? { sessionId: state.activeSessionId } : {}),
    };
    startingRef.current = true;
    pendingRunEvents.current = [];
    pendingRunStatuses.current = [];
    setStarting(true);
    try {
      const { runId } = await api.startTurn(request);
      dispatch({ type: "run.started", runId, request });
      for (const message of pendingRunEvents.current) {
        if (message.runId === runId) dispatch({ type: "run.event", message });
      }
      for (const status of pendingRunStatuses.current) {
        if (status.runId === runId) {
          dispatch({ type: "run.status", status });
          if (status.status !== "running") {
            void api
              .bootstrap()
              .then(applyBootstrap)
              .catch(() => undefined);
          }
        }
      }
      setPrompt((current) => (current === submittedInput ? "" : current));
    } catch (error) {
      dispatch({ type: "error", error: desktopError(error) });
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

  const newConversation = (workspaceRoot?: string) => {
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
          onNewConversation={newConversation}
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
            void api
              .deleteSession(sessionId)
              .then((bootstrap) => {
                applyBootstrap(bootstrap);
                if (state.activeSessionId === sessionId) dispatch({ type: "conversation.new" });
              })
              .catch((error) => dispatch({ type: "error", error: desktopError(error) }));
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
        <main className={`main-pane${state.drawer ? " drawer-open" : ""}`}>
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
                  state={{ ...state, timeline }}
                  workspaceName={projectName(state.bootstrap, state.workspaceRoot)}
                  profileUsable={profileUsable}
                  onPromptSuggestion={setPrompt}
                  onConfigure={() => dispatch({ type: "dialog.set", dialog: { type: "profile" } })}
                  onChooseWorkspace={() => void chooseWorkspace()}
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
          <Composer
            prompt={prompt}
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
              state.workspaceRoot && !state.activeSessionId && !state.request && !timeline.length,
            )}
            contextUsage={displayedContextUsage}
            onPromptChange={setPrompt}
            onModeChange={setMode}
            onModelChange={setModelId}
            onSubmit={() => void submit()}
            onStop={() => void stop()}
          />
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
        {approvalRequest ? (
          <ApprovalDialog
            api={api}
            request={approvalRequest}
            onResolved={() => setApprovalRequest(undefined)}
          />
        ) : null}
        {questionRequest ? (
          <QuestionDialog
            api={api}
            request={questionRequest}
            onResolved={() => setQuestionRequest(undefined)}
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
