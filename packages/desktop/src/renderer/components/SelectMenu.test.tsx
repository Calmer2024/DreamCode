// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { SelectMenu } from "./SelectMenu";
import { Zap } from "lucide-react";

const options = [
  { value: "guided", label: "引导模式" },
  { value: "full", label: "完全访问" },
];

describe("SelectMenu", () => {
  it("dismisses outside, selects an option, and expands upward in the lower viewport", () => {
    const onChange = vi.fn();
    render(<SelectMenu label="运行模式" value="guided" options={options} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "运行模式选项" });
    Object.defineProperty(trigger, "getBoundingClientRect", {
      value: () => ({ top: 700, bottom: 734, left: 900, right: 1020, width: 120, height: 34 }),
    });

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox", { name: "运行模式" })).toHaveAttribute(
      "data-direction",
      "up",
    );
    expect(screen.getByRole("listbox", { name: "运行模式" })).toHaveStyle({
      bottom: "74px",
    });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox", { name: "运行模式" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "运行模式" })).getByRole("option", {
        name: "完全访问",
      }),
    );
    expect(onChange).toHaveBeenCalledWith("full");
  });

  it("renders option icons", () => {
    render(
      <SelectMenu
        label="运行模式"
        value="guided"
        options={[{ value: "guided", label: "引导模式", icon: <Zap data-testid="mode-icon" /> }]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "运行模式选项" }));
    expect(screen.getAllByTestId("mode-icon")).toHaveLength(2);
  });
});
