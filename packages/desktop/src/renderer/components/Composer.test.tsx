// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { Composer } from "./Composer";

describe("Composer context usage", () => {
  it("shows a compact percentage meter with exact context details", () => {
    render(
      <Composer
        prompt=""
        mode="guided"
        model="deepseek-chat"
        runStatus="completed"
        active={false}
        starting={false}
        canSubmit={false}
        contextUsage={{ estimatedTokens: 9_548, maxTokens: 64_000, compressed: false }}
        onPromptChange={vi.fn()}
        onModeChange={vi.fn()}
        onModelChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const meter = screen.getByRole("status", { name: "上下文已用 15%" });
    expect(meter).toHaveAttribute("data-tooltip", "上下文已用 15% · 9,548 / 64,000 tokens");
    expect(meter.querySelector(".context-usage-progress")).toHaveAttribute(
      "stroke-dashoffset",
      "85",
    );
  });
});
