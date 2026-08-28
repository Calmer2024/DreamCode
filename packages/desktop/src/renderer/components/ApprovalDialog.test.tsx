// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../shared/contracts";
import "../../test/setup";
import { ApprovalDialog, QuestionDialog } from "./ApprovalDialog";

describe("ApprovalDialog", () => {
  it("shows approval evidence and sends allow or deny decisions", async () => {
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
      <ApprovalDialog api={api} request={request} onResolved={vi.fn()} />,
    );

    expect(screen.getByText("shell_command")).toBeVisible();
    expect(screen.getByText(/pnpm test/)).toBeVisible();
    expect(screen.getByText("Command execution needs review")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenCalledWith({
        runId: "run_1",
        requestId: "approval_1",
        approved: true,
      }),
    );

    rerender(<ApprovalDialog api={api} request={request} onResolved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenLastCalledWith({
        runId: "run_1",
        requestId: "approval_1",
        approved: false,
      }),
    );
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
