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

  it("renders approval details as markdown without bold text", () => {
    const api = { respondApproval: vi.fn() } as unknown as DesktopApi;
    const { container } = render(
      <ApprovalCard
        api={api}
        request={{ runId: "run_1", requestId: "approval_1", tool: "file.write", input: { path: "**README.md**" }, reason: "reason" }}
        onResolved={vi.fn()}
      />,
    );

    expect(screen.getByText("README.md").tagName).toBe("SPAN");
    expect(container.querySelector(".approval-card-summary strong")).toBeNull();
  });
});

describe("QuestionDialog", () => {
  it("requires a non-empty answer before responding", async () => {
    const respondQuestion = vi.fn().mockResolvedValue(undefined);
    const api = { respondQuestion } as unknown as DesktopApi;
    render(
      <QuestionDialog
        api={api}
        request={{ runId: "run_1", requestId: "question_1", question: "Which **file**?" }}
        onResolved={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "回答问题" })).toHaveClass("question-card");
    expect(screen.getByRole("dialog", { name: "回答问题" })).not.toHaveAttribute("aria-modal");
    expect(screen.getByText("需要输入")).toHaveClass("request-card-kicker");
    expect(screen.getByText("需要输入").closest("header")?.querySelector(".approval-card-icon")).not.toBeNull();
    expect(screen.getByText("file").tagName).toBe("SPAN");
    expect(screen.getByText("Ctrl+Enter 提交")).toBeVisible();
    const submit = screen.getByRole("button", { name: "提交回答" });
    expect(submit).not.toHaveTextContent("提交回答");
    expect(submit.querySelector("svg")).not.toBeNull();
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

  it("grows the answer until its maximum height and only then enables scrolling", () => {
    const api = { respondQuestion: vi.fn() } as unknown as DesktopApi;
    render(
      <QuestionDialog
        api={api}
        request={{ runId: "run_1", requestId: "question_1", question: "Explain" }}
        onResolved={vi.fn()}
      />,
    );
    const answer = screen.getByLabelText("回答") as HTMLTextAreaElement;
    Object.defineProperty(answer, "scrollHeight", {
      configurable: true,
      get: () => answer.value.includes("\n") ? 320 : 80,
    });

    fireEvent.change(answer, { target: { value: "short" } });
    expect(Number.parseFloat(answer.style.height)).toBeLessThan(240);
    expect(answer.style.overflowY).toBe("hidden");

    fireEvent.change(answer, { target: { value: "long\nanswer" } });
    expect(answer.style.height).toBe("240px");
    expect(answer.style.overflowY).toBe("auto");
  });
});
