import type { AgentEvent, ChangedFile } from "@dreamcode/shared";
import type { ReplayedSessionState } from "@dreamcode/store";
import { Braces, CheckCircle2, FileDiff, RotateCcw, SquareTerminal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { DesktopApi } from "../../shared/contracts";
import type { DesktopTerminalEntry } from "../state/desktop-state";

export type DetailTab = "diff" | "terminal" | "event" | "session";

interface DetailDrawerProps {
  api: DesktopApi;
  sessionId?: string;
  session?: ReplayedSessionState;
  changedFile?: ChangedFile;
  terminalEntries?: DesktopTerminalEntry[];
  events?: AgentEvent[];
  initialTab?: DetailTab;
  onClose: () => void;
  onSessionRefresh?: (session: ReplayedSessionState) => void;
}

const outputLimit = 200 * 1024;
const tabs: Array<{ id: DetailTab; label: string }> = [
  { id: "diff", label: "Diff" },
  { id: "terminal", label: "终端" },
  { id: "event", label: "事件" },
  { id: "session", label: "会话" },
];

export function DetailDrawer({
  api,
  sessionId: activeSessionId,
  session,
  changedFile,
  terminalEntries = [],
  events = [],
  initialTab = "diff",
  onClose,
  onSessionRefresh,
}: DetailDrawerProps) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [selectedPath, setSelectedPath] = useState(
    changedFile?.path ?? session?.changedFiles[0]?.path,
  );
  const availableFiles = session?.changedFiles ?? (changedFile ? [changedFile] : []);
  const selectedFile =
    availableFiles.find((file) => file.path === selectedPath) ??
    (changedFile?.path === selectedPath ? changedFile : undefined);
  const sessionId = activeSessionId ?? session?.session?.id;
  const [diff, setDiff] = useState(selectedFile?.diff ?? "");
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [evidence, setEvidence] = useState<{ tone: "success" | "error"; text: string }>();

  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => {
    setSelectedPath(changedFile?.path ?? session?.changedFiles[0]?.path);
  }, [changedFile?.path, session?.changedFiles]);

  useEffect(() => {
    if (!sessionId || !selectedFile) {
      setDiff(selectedFile?.diff ?? "");
      return;
    }
    let current = true;
    setLoadingDiff(true);
    void api
      .readDiff({ sessionId, filePath: selectedFile.path })
      .then((nextDiff) => {
        if (current) setDiff(nextDiff);
      })
      .catch(() => {
        if (current) setEvidence({ tone: "error", text: `无法读取 ${selectedFile.path} 的 Diff` });
      })
      .finally(() => {
        if (current) setLoadingDiff(false);
      });
    return () => {
      current = false;
    };
  }, [api, selectedFile, sessionId]);

  const terminalOutput = useMemo(() => stringify(terminalEntries), [terminalEntries]);
  const eventOutput = useMemo(() => stringify(events), [events]);
  const sessionOutput = useMemo(() => stringify(session), [session]);

  const rollback = async () => {
    if (!sessionId || !selectedFile) return;
    setRollingBack(true);
    setEvidence(undefined);
    try {
      const result = await api.rollback({ sessionId, filePath: selectedFile.path });
      const refreshed = await api.readSession(sessionId);
      onSessionRefresh?.(refreshed);
      const refreshedDiff = await api.readDiff({ sessionId, filePath: selectedFile.path });
      setDiff(refreshedDiff);
      if (result.failedFiles.length > 0) {
        setEvidence({
          tone: "error",
          text: result.failedFiles.map((file) => `${file.path}: ${file.reason}`).join("\n"),
        });
      } else {
        setEvidence({ tone: "success", text: `已回滚 ${selectedFile.path}` });
      }
    } catch {
      setEvidence({ tone: "error", text: `回滚 ${selectedFile.path} 失败` });
    } finally {
      setConfirmingRollback(false);
      setRollingBack(false);
    }
  };

  return (
    <div className="drawer-backdrop">
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="任务证据">
        <header className="drawer-header">
          <div>
            <p className="dialog-kicker">审查与证据</p>
            <h2>任务证据</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭详情" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="drawer-tabs" role="tablist" aria-label="证据类型">
          {tabs.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className="drawer-tab"
              key={item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {tab === "diff" ? (
            <section className="drawer-panel" role="tabpanel">
              <div className="drawer-toolbar">
                <label>
                  <span className="sr-only">变更文件</span>
                  <select
                    aria-label="变更文件"
                    value={selectedPath ?? ""}
                    disabled={availableFiles.length === 0}
                    onChange={(event) => setSelectedPath(event.target.value)}
                  >
                    {!selectedPath ? <option value="">没有变更文件</option> : null}
                    {availableFiles.map((file) => (
                      <option value={file.path} key={file.path}>
                        {file.path}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="danger-button rollback-button"
                  disabled={!sessionId || !selectedFile || rollingBack}
                  onClick={() => setConfirmingRollback(true)}
                >
                  <RotateCcw aria-hidden="true" />
                  回滚文件
                </button>
              </div>
              {loadingDiff ? (
                <p className="drawer-empty">正在读取 Diff</p>
              ) : (
                <EvidenceOutput
                  icon={<FileDiff aria-hidden="true" />}
                  text={diff}
                  empty="没有可显示的 Diff"
                />
              )}
            </section>
          ) : null}
          {tab === "terminal" ? (
            <section className="drawer-panel" role="tabpanel">
              <EvidenceOutput
                icon={<SquareTerminal aria-hidden="true" />}
                text={terminalOutput}
                empty="没有终端输出"
              />
            </section>
          ) : null}
          {tab === "event" ? (
            <section className="drawer-panel" role="tabpanel">
              <EvidenceOutput
                icon={<Braces aria-hidden="true" />}
                text={eventOutput}
                empty="没有事件记录"
              />
            </section>
          ) : null}
          {tab === "session" ? (
            <section className="drawer-panel" role="tabpanel">
              <EvidenceOutput
                icon={<CheckCircle2 aria-hidden="true" />}
                text={sessionOutput}
                empty="尚未选择会话"
              />
            </section>
          ) : null}
          {evidence ? (
            <p
              className={`rollback-evidence tone-${evidence.tone}`}
              role={evidence.tone === "success" ? "status" : "alert"}
            >
              {evidence.text}
            </p>
          ) : null}
        </div>
      </aside>

      {confirmingRollback && selectedFile ? (
        <div className="modal-backdrop modal-priority">
          <section
            className="dialog-card rollback-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="确认回滚文件"
          >
            <header className="dialog-header">
              <div>
                <p className="dialog-kicker">不可自动撤销</p>
                <h2>确认回滚文件</h2>
              </div>
            </header>
            <p>将使用会话快照恢复以下精确路径：</p>
            <code className="rollback-path">{selectedFile.path}</code>
            <footer className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={rollingBack}
                onClick={() => setConfirmingRollback(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={rollingBack}
                onClick={() => void rollback()}
              >
                {rollingBack ? "正在回滚" : "确认回滚"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function EvidenceOutput({ icon, text, empty }: { icon: ReactNode; text: string; empty: string }) {
  if (!text) return <p className="drawer-empty">{empty}</p>;
  return (
    <div className="evidence-output-wrap">
      <span className="evidence-output-icon">{icon}</span>
      <pre className="evidence-output" data-testid="detail-output">
        {boundOutput(text)}
      </pre>
    </div>
  );
}

function stringify(value: unknown): string {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export function boundOutput(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= outputLimit) return value;
  const marker = "\n[输出已截断至 200 KB]";
  const byteBudget = outputLimit - encoder.encode(marker).byteLength;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= byteBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const safeEnd = low > 0 && isHighSurrogate(value.charCodeAt(low - 1)) ? low - 1 : low;
  return `${value.slice(0, safeEnd)}${marker}`;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}
