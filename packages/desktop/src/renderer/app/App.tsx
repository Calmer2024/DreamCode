import type { RunMode } from "@dreamcode/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  DesktopApi,
  DesktopError,
  DesktopRunEvent,
  DesktopRunStatus,
  StartTurnRequest,
} from "../../shared/contracts";
import { Composer } from "../components/Composer";
import { Sidebar } from "../components/Sidebar";
import { TaskHeader } from "../components/TaskHeader";
import { Timeline } from "../components/Timeline";
import {
  createDesktopState,
  desktopReducer,
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
  const [profileName, setProfileName] = useState("");
  const startingRef = useRef(false);
  const pendingRunEvents = useRef<DesktopRunEvent[]>([]);
  const pendingRunStatuses = useRef<DesktopRunStatus[]>([]);
  const sessionLoadSequence = useRef(0);

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
        (profile) => profile.name === bootstrap.currentProfile && profile.apiKeyConfigured,
      );
      const availableProfile =
        currentProfile ?? bootstrap.profiles.find((profile) => profile.apiKeyConfigured);
      setProfileName(availableProfile?.name ?? bootstrap.profiles[0]?.name ?? "");
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
    });
    return () => {
      unsubscribeRunEvent();
      unsubscribeRunStatus();
    };
  }, [api]);

  const groups = useMemo(() => selectWorkspaceGroups(state), [state]);
  const timeline = selectTimeline(state);
  const running = state.runStatus === "running" && Boolean(state.activeRunId);
  const busy = running || starting;
  const selectedProfile = state.profiles.find((profile) => profile.name === profileName);
  const canSubmit = Boolean(
    prompt.trim() && state.workspaceRoot?.trim() && selectedProfile?.apiKeyConfigured && !busy,
  );

  const chooseWorkspace = async () => {
    if (busy) return;
    try {
      const workspaceRoot = await api.chooseWorkspace();
      if (workspaceRoot) dispatch({ type: "workspace.selected", workspaceRoot });
    } catch (error) {
      dispatch({ type: "error", error: desktopError(error) });
    }
  };

  const submit = async () => {
    const cleanPrompt = prompt.trim();
    if (
      !cleanPrompt ||
      !state.workspaceRoot ||
      !selectedProfile?.apiKeyConfigured ||
      busy ||
      startingRef.current
    )
      return;
    const request: StartTurnRequest = {
      prompt: cleanPrompt,
      workspaceRoot: state.workspaceRoot,
      mode,
      profileName,
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
        if (status.runId === runId) dispatch({ type: "run.status", status });
      }
      setPrompt("");
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

  return (
    <div className="app-shell">
      <Sidebar
        groups={groups}
        activeSessionId={state.activeSessionId}
        navigationDisabled={busy}
        onNewConversation={() => dispatch({ type: "session.selected", sessionId: undefined })}
        onOpenHistory={() => dispatch({ type: "drawer.open", drawer: "sessions" })}
        onOpenConfiguration={() => dispatch({ type: "dialog.set", dialog: { type: "profile" } })}
        onOpenSettings={() => dispatch({ type: "dialog.set", dialog: { type: "settings" } })}
        onSelectSession={(sessionId) => void selectSession(sessionId)}
      />
      <main className="main-pane">
        <TaskHeader
          workspaceRoot={state.workspaceRoot}
          workspaceSelectionDisabled={busy}
          onChooseWorkspace={() => void chooseWorkspace()}
          onOpenDetails={() => dispatch({ type: "drawer.open", drawer: "details" })}
          onOpenFiles={() => dispatch({ type: "drawer.open", drawer: "files" })}
          onOpenTerminal={() => dispatch({ type: "drawer.open", drawer: "terminal" })}
        />
        <div className="conversation-scroll">
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
                onConfigure={() => dispatch({ type: "dialog.set", dialog: { type: "profile" } })}
                onChooseWorkspace={() => void chooseWorkspace()}
              />
            )}
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
          profileName={profileName}
          profiles={state.profiles}
          runStatus={state.runStatus}
          active={running}
          starting={starting}
          canSubmit={canSubmit}
          onPromptChange={setPrompt}
          onModeChange={setMode}
          onProfileChange={setProfileName}
          onSubmit={() => void submit()}
          onStop={() => void stop()}
        />
      </main>
    </div>
  );
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
