// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import type { DesktopState } from "../state/desktop-state";
import { createDesktopState } from "../state/desktop-state";
import { Timeline } from "./Timeline";

describe("Timeline", () => {
  it("renders semantic user, tool, file, and status entries without duplicating the prompt", () => {
    const state: DesktopState = {
      ...createDesktopState({ profiles: [], presets: [], sessions: [] }),
      workspaceRoot: "D:\\Projects\\DreamCode",
      request: {
        prompt: "Fix the timeline",
        workspaceRoot: "D:\\Projects\\DreamCode",
        mode: "guided",
      },
      timeline: [
        entry("user", "User message", "Fix the timeline"),
        entry("tool", "Running shell.run", "pnpm test"),
        entry("file", "update src/app.ts", "diff --git"),
        entry("status", "Turn completed", "All tests passed"),
      ],
    };

    render(
      <Timeline state={state} profileUsable onConfigure={vi.fn()} onChooseWorkspace={vi.fn()} />,
    );

    expect(screen.getAllByText("Fix the timeline")).toHaveLength(1);
    expect(screen.getByTestId("timeline-user")).toBeVisible();
    expect(screen.getByTestId("timeline-tool")).toHaveTextContent("pnpm test");
    expect(screen.getByTestId("timeline-file")).toHaveTextContent("src/app.ts");
    expect(screen.getByTestId("timeline-status")).toHaveTextContent("All tests passed");
  });
});

function entry(kind: "user" | "tool" | "file" | "status", title: string, detail: string) {
  return {
    id: `entry-${kind}`,
    kind,
    title,
    detail,
    tone: "muted" as const,
    timestamp: "2026-08-10T00:00:00.000Z",
  };
}
