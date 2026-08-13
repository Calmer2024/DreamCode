// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { ProjectMoreMenu } from "./ProjectMoreMenu";

function renderMenu() {
  const callbacks = {
    onTogglePin: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
  };
  render(<ProjectMoreMenu projectName="DreamCode" pinned={false} {...callbacks} />);
  return callbacks;
}

describe("ProjectMoreMenu", () => {
  it("expands downwards in the upper viewport and light dismisses", async () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "项目更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect({ top: 80, bottom: 110 }));

    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "DreamCode 项目操作" });
    await waitFor(() => expect(menu).toHaveAttribute("data-state", "open"));
    expect(menu).toHaveAttribute("data-direction", "down");

    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveAttribute("data-state", "closed");
  });

  it("expands upwards in the lower viewport and invokes the selected action", async () => {
    const callbacks = renderMenu();
    const trigger = screen.getByRole("button", { name: "项目更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect({ top: 620, bottom: 650 }));

    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "DreamCode 项目操作" });
    await waitFor(() => expect(menu).toHaveAttribute("data-state", "open"));
    expect(menu).toHaveAttribute("data-direction", "up");

    fireEvent.click(screen.getByRole("menuitem", { name: "置顶项目" }));
    expect(callbacks.onTogglePin).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("restores the complete recovered menu without presenting placeholders as functional", async () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "项目更多操作" }));
    const menu = await screen.findByRole("menu", { name: "DreamCode 项目操作" });
    await waitFor(() => expect(menu).toHaveAttribute("data-state", "open"));

    expect(screen.getByRole("menuitem", { name: "在资源管理器中打开" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /创建永久工作树/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "编辑项目" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /归档聊天/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "移除" })).toBeEnabled();
  });
});

function rect({ top, bottom }: { top: number; bottom: number }): DOMRect {
  return {
    x: 100,
    y: top,
    top,
    bottom,
    left: 100,
    right: 130,
    width: 30,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}
