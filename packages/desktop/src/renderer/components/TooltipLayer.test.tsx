// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { TooltipLayer } from "./TooltipLayer";

describe("TooltipLayer", () => {
  it("renders tooltips in a fixed body-level layer outside scrolling containers", () => {
    render(
      <div className="workspace-list">
        <button type="button" data-tooltip="置顶">
          触发
        </button>
        <TooltipLayer />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "触发" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 40,
      left: 20,
      top: 40,
      right: 60,
      bottom: 72,
      width: 40,
      height: 32,
      toJSON: () => ({}),
    });

    fireEvent.pointerOver(trigger);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("置顶");
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveStyle({ left: "70px", top: "56px" });
  });
});
