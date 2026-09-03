// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../shared/contracts";
import "../../test/setup";
import { ApprovalCard, QuestionDialog } from "./ApprovalDialog";

describe("ApprovalCard", () => {
  it("shows a compact command prompt and sends allow-once or deny decisions", async () => {
    const respondApproval = vi.fn().mockResolvedValue(undefined);
    const api = { respondApproval } as unknown as DesktopApi;
    const request = {
      runId: "run_1",
      requestId: "approval_1",
      tool: "shell_command",
      input: { command: "pnpm test", cwd: "D:\\repo" },
      reason: "Command execution needs review",
    };
    const { rerender } = render(
      <ApprovalCard api={api} request={request} onResolved={vi.fn()} />,
    );

    expect(screen.getByRole("region", { name: "需要审批" })).toBeVisible();
    expect(screen.getByText("是否允许我执行这个命令？")).toBeVisible();
    expect(screen.getByText(/pnpm test/)).toBeVisible();
    expect(screen.queryByText("Command execution needs review")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenCalledWith({
        runId: "run_1",
        requestId: "approval_1",
        approved: true,
      }),
    );

    rerender(<ApprovalCard api={api} request={request} onResolved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenLastCalledWith({
        runId: "run_1",
        requestId: "approval_1",
        approved: false,
      }),
    );
  });

  it("supports Enter and Escape shortcuts", async () => {
    const respondApproval = vi.fn().mockResolvedValue(undefined);
    const api = { respondApproval } as unknown as DesktopApi;
    const request = { runId: "run_1", requestId: "approval_1", tool: "pwsh", input: { command: "npm run dev", description: "start dev server" }, reason: "reason" };
    const first = render(<ApprovalCard api={api} request={request} onResolved={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(respondApproval).toHaveBeenCalledWith({ runId: "run_1", requestId: "approval_1", approved: true }));
    first.unmount();
    render(<ApprovalCard api={api} request={request} onResolved={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(respondApproval).toHaveBeenLastCalledWith({ runId: "run_1", requestId: "approval_1", approved: false }));
  });
});

describe("QuestionDialog", () => {
  it("requires a non-empty answer before responding", async () => {
    const respondQuestion = vi.fn().mockResolvedValue(undefined);
    const api = { respondQuestion } as unknown as DesktopApi;
    render(
      <QuestionDialog
        api={api}
        request={{ runId: "run_1", requestId: "question_1", question: "Which file?" }}
        onResolved={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "回答问题" })).toHaveClass("question-card");
    expect(screen.getByRole("dialog", { name: "回答问题" })).not.toHaveAttribute("aria-modal");
    const submit = screen.getByRole("button", { name: "提交回答" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("回答"), { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("回答"), { target: { value: " README.md " } });
    fireEvent.keyDown(screen.getByLabelText("回答"), { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(respondQuestion).toHaveBeenCalledWith({
        runId: "run_1",
        requestId: "question_1",
        answer: "README.md",
      }),
    );
  });
});
