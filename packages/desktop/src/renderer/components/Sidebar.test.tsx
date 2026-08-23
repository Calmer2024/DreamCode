// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("supports project collapse, creation, and project-scoped conversations", () => {
    const onNewConversation = vi.fn();
    const onCreateProject = vi.fn();
    render(
      <Sidebar
        groups={[
          {
            workspaceRoot: "D:\\Projects\\DreamCode",
            name: "DreamCode",
            sessions: [],
          },
        ]}
        navigationDisabled={false}
        onNewConversation={onNewConversation}
        onCreateProject={onCreateProject}
        onOpenSettings={vi.fn()}
        onSaveProject={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onRemoveWorkspace={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onSetSessionPinned={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "在 DreamCode 中新对话" }));
    expect(onNewConversation).toHaveBeenCalledWith("D:\\Projects\\DreamCode");
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    expect(onCreateProject).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "折叠项目" }));
    expect(screen.getByRole("button", { name: "展开项目" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "展开项目" }));
    expect(screen.getByRole("button", { name: "折叠项目" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("置顶")).not.toBeInTheDocument();
  });

  it("renders pinned conversations separately and uses inline rename and delete confirmation", () => {
    const onRenameSession = vi.fn();
    const onDeleteSession = vi.fn();
    const pinnedSession = {
      id: "sess_1",
      workspaceRoot: "D:\\Projects\\DreamCode",
      status: "completed" as const,
      title: "原始对话",
      firstPrompt: "原始对话",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      changedFileCount: 0,
      commandCount: 0,
      totalCostUsd: 0,
      eventLogPath: "events.jsonl",
    };
    render(
      <Sidebar
        groups={[]}
        pinnedSessions={[pinnedSession]}
        navigationDisabled={false}
        onNewConversation={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenSettings={vi.fn()}
        onSaveProject={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onRemoveWorkspace={vi.fn()}
        onDeleteSession={onDeleteSession}
        onRenameSession={onRenameSession}
        onSetSessionPinned={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );

    expect(screen.getByText("置顶")).toBeVisible();
    expect(screen.getByRole("button", { name: "折叠置顶" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重命名对话" }));
    const input = screen.getByRole("textbox", { name: "对话名称" });
    fireEvent.change(input, { target: { value: "新的名称" } });
    fireEvent.submit(input.closest("form")!);
    expect(onRenameSession).toHaveBeenCalledWith("sess_1", "新的名称");

    fireEvent.click(screen.getByRole("button", { name: "删除对话" }));
    expect(onDeleteSession).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("button", { name: "删除对话" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "删除对话" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除对话" }));
    expect(onDeleteSession).toHaveBeenCalledWith("sess_1");
  });
});
