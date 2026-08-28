import { CircleHelp, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type {
  DesktopApi,
  DesktopApprovalRequest,
  DesktopQuestionRequest,
} from "../../shared/contracts";

interface ApprovalDialogProps {
  api: DesktopApi;
  request: DesktopApprovalRequest;
  onResolved: () => void;
}

export function ApprovalDialog({ api, request, onResolved }: ApprovalDialogProps) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string>();

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
    <div className="modal-backdrop modal-priority approval-backdrop">
      <section
        className="dialog-card approval-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="工具审批"
      >
        <header className="dialog-header approval-heading">
          <ShieldAlert aria-hidden="true" />
          <div>
            <p className="dialog-kicker">需要审批</p>
            <h2>{request.tool}</h2>
          </div>
        </header>
        <dl className="approval-evidence">
          <div>
            <dt>输入</dt>
            <dd>
              <pre>{normalizeInput(request.input)}</pre>
            </dd>
          </div>
          <div>
            <dt>原因</dt>
            <dd>{request.reason}</dd>
          </div>
        </dl>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="dialog-actions">
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
            允许
          </button>
        </footer>
      </section>
    </div>
  );
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
