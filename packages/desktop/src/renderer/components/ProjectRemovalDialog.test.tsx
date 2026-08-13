// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { ProjectRemovalDialog } from "./ProjectRemovalDialog";

describe("ProjectRemovalDialog", () => {
  it("explains that chats are deleted while project files are retained", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ProjectRemovalDialog projectName="DreamCode" onCancel={onCancel} onConfirm={onConfirm} />,
    );

    expect(screen.getByRole("dialog", { name: "移除 DreamCode?" })).toHaveTextContent(
      "永久删除该项目下的 DreamCode 对话记录，但不会删除你电脑上的项目文件",
    );
    fireEvent.click(screen.getByRole("button", { name: "移除项目" }));
    expect(onConfirm).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
