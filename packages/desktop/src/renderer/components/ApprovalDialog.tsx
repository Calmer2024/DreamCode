import { CircleHelp, FilePenLine, Globe, PlayCircle, ShieldAlert, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  DesktopApi,
  DesktopApprovalRequest,
  DesktopQuestionRequest,
} from "../../shared/contracts";

interface ApprovalCardProps {
  api: DesktopApi;
  request: DesktopApprovalRequest;
  onResolved: () => void;
}

export function ApprovalCard({ api, request, onResolved }: ApprovalCardProps) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string>();
  const cardRef = useRef<HTMLElement>(null);
  const presentation = approvalPresentation(request);

  useEffect(() => {
    cardRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (responding) return;
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        void respond(event.key === "Enter");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [responding]);

  const respond = async (approved: boolean) => {
    setResponding(true);
    setError(undefined);
    try {
      await api.respondApproval({
        runId: request.runId,
        requestId: request.requestId,
        approved,
      });
      onResolved();
    } catch {
      setError("审批响应未能提交，请重试。");
    } finally {
      setResponding(false);
    }
  };

  return (
    <section className="approval-card" ref={cardRef} tabIndex={-1} role="region" aria-label="需要审批">
      <header className="approval-card-heading">
        <span className="approval-card-icon"> <presentation.Icon aria-hidden="true" /> </span>
        <div>
          <p>需要审批</p>
          <h2>{presentation.message}</h2>
        </div>
      </header>
      <code className="approval-card-summary">{presentation.summary}</code>
        {error ? (
          <p className="form-error approval-card-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="approval-card-actions">
          <button
            type="button"
            className="danger-button"
            disabled={responding}
            onClick={() => void respond(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={responding}
            onClick={() => void respond(true)}
          >
            允许一次
          </button>
        </footer>
    </section>
  );
}

export const ApprovalDialog = ApprovalCard;

function approvalPresentation(request: DesktopApprovalRequest) {
  const input = request.input && typeof request.input === "object" ? request.input as Record<string, unknown> : {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const path = typeof input.path === "string" ? input.path : undefined;
  const url = typeof input.url === "string" ? input.url : undefined;
  if (request.tool === "shell.run" || request.tool === "shell_command") {
    return { Icon: SquareTerminal, message: "是否允许我执行这个命令？", summary: command ?? "命令执行" };
  }
  if (request.tool === "process.start") {
    return { Icon: PlayCircle, message: "是否允许我启动这个进程？", summary: command ?? String(input.label ?? "进程启动") };
  }
  if (request.tool === "file.write" || request.tool === "file.patch") {
    return { Icon: FilePenLine, message: "是否允许我修改这个文件？", summary: path ?? "文件修改" };
  }
  if (request.tool.startsWith("web.") || request.tool.includes("fetch")) {
    return { Icon: Globe, message: "是否允许我访问这个网络资源？", summary: url ?? "网络访问" };
  }
  return { Icon: Wrench, message: "是否允许我执行这个操作？", summary: request.tool };
}

interface QuestionDialogProps {
  api: DesktopApi;
  request: DesktopQuestionRequest;
  onResolved: () => void;
}

export function QuestionDialog({ api, request, onResolved }: QuestionDialogProps) {
  const [answer, setAnswer] = useState("");
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string>();

  const respond = async () => {
    const cleanAnswer = answer.trim();
    if (!cleanAnswer) return;
    setResponding(true);
    setError(undefined);
    try {
      await api.respondQuestion({
        runId: request.runId,
        requestId: request.requestId,
        answer: cleanAnswer,
      });
      onResolved();
    } catch {
      setError("回答未能提交，请重试。");
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="question-card-layer modal-priority">
      <section
        className="dialog-card question-dialog question-card"
        role="dialog"
        aria-label="回答问题"
      >
        <header className="dialog-header approval-heading">
          <CircleHelp aria-hidden="true" />
          <div>
            <p className="dialog-kicker">需要输入</p>
            <h2>{request.question}</h2>
          </div>
        </header>
        <label className="question-answer">
          回答
          <textarea
            aria-label="回答"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={4}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                if (!responding && answer.trim()) void respond();
              }
            }}
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="dialog-actions">
          <button
            type="button"
            className="primary-button"
            disabled={responding || !answer.trim()}
            onClick={() => void respond()}
          >
            提交回答
          </button>
        </footer>
      </section>
    </div>
  );
}

function normalizeInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}
