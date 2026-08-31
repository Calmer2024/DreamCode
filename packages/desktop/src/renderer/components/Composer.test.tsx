// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("Composer Skill invocation", () => {
  it("suggests enabled Skills for slash invocation", async () => {
    const onPromptChange = vi.fn();
    render(
      <Composer
        api={{
          listSkills: vi.fn().mockResolvedValue({
            generation: 1,
            customRoots: [],
            diagnostics: [],
            skills: [{
              skillId: "skill_review",
              name: "review",
              description: "Review a change",
              source: "user",
              provider: "agents",
              capabilities: [],
              allowImplicitInvocation: true,
              path: "C:\\skills\\review",
              enabled: true,
              valid: true,
              resolution: "resolved",
              managed: false,
              canUninstall: false,
              canUpdate: false,
              canRollback: false,
              diagnostics: [],
            }],
          }),
        }}
        prompt="/re"
        mode="guided"
        model="deepseek-chat"
        runStatus=""
        active={false}
        starting={false}
        canSubmit
        onPromptChange={onPromptChange}
        onModeChange={vi.fn()}
        onModelChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const option = await screen.findByRole("option", { name: /review/i });
    fireEvent.mouseDown(option);
    await waitFor(() => expect(onPromptChange).toHaveBeenCalledWith("/review "));
  });

  it("navigates dollar suggestions with the keyboard and selects without submitting", async () => {
    const onPromptChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <Composer
        api={{
          listSkills: vi.fn().mockResolvedValue({
            generation: 1,
            customRoots: [],
            diagnostics: [],
            skills: [
              { ...skill("review", "user"), name: "Review workflow", invocationName: "review" },
              skill("release", "project"),
            ],
          }),
        }}
        prompt="Please $re"
        mode="guided"
        model="deepseek-chat"
        runStatus=""
        active={false}
        starting={false}
        canSubmit
        onPromptChange={onPromptChange}
        onModeChange={vi.fn()}
        onModelChange={vi.fn()}
        onSubmit={onSubmit}
        onStop={vi.fn()}
      />,
    );

    const textbox = screen.getByRole("textbox", { name: "给 DreamCode 发送消息" });
    const options = within(await screen.findByRole("listbox", { name: "技能建议" })).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveTextContent("个人");
    expect(options[1]).toHaveTextContent("项目");
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onPromptChange).toHaveBeenCalledWith("Please $release ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("dismisses suggestions with Escape", async () => {
    const onSubmit = vi.fn();
    render(
      <Composer
        api={{ listSkills: vi.fn().mockResolvedValue({ generation: 1, customRoots: [], diagnostics: [], skills: [skill("review", "plugin")] }) }}
        prompt="/re"
        mode="guided"
        model="deepseek-chat"
        runStatus=""
        active={false}
        starting={false}
        canSubmit
        onPromptChange={vi.fn()}
        onModeChange={vi.fn()}
        onModelChange={vi.fn()}
        onSubmit={onSubmit}
        onStop={vi.fn()}
      />,
    );

    const textbox = screen.getByRole("textbox", { name: "给 DreamCode 发送消息" });
    expect(within(await screen.findByRole("listbox", { name: "技能建议" })).getByRole("option")).toHaveTextContent("插件");
    fireEvent.keyDown(textbox, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "技能建议" })).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

function skill(name: string, source: "built_in" | "system" | "user" | "project" | "plugin") {
  return {
    skillId: `skill_${name}`,
    name,
    description: `${name} description`,
    source,
    provider: source === "plugin" ? "plugin" : "agents",
    capabilities: [],
    allowImplicitInvocation: true,
    path: `C:\\skills\\${name}`,
    enabled: true,
    valid: true,
    resolution: "resolved" as const,
    managed: false,
    canUninstall: false,
    canUpdate: false,
    canRollback: false,
    diagnostics: [],
  };
}
