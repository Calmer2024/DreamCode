// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { createDesktopState } from "../state/desktop-state";

const markdownRender = vi.hoisted(() => vi.fn());

vi.mock("./MarkdownContent", () => ({
  MarkdownContent: ({ children }: { children: string }) => {
    markdownRender(children);
    return <div>{children}</div>;
  },
}));

import { Timeline } from "./Timeline";

describe("Timeline render isolation", () => {
  it("does not rerender an unchanged conversation when a sibling input changes", () => {
    const state = {
      ...createDesktopState(),
      workspaceRoot: "D:/workspace",
      timeline: [
        {
          id: "assistant-1",
          kind: "assistant" as const,
          title: "Assistant",
          detail: "An existing Markdown response",
          tone: "muted" as const,
          timestamp: "2026-09-08T00:00:00.000Z",
          turnId: "turn-1",
        },
      ],
    };

    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <>
          <input
            aria-label="draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Timeline state={state} profileUsable onConfigure={noop} onChooseWorkspace={noop} />
        </>
      );
    }

    const view = render(<Harness />);
    expect(markdownRender).toHaveBeenCalledTimes(1);
    fireEvent.change(view.getByLabelText("draft"), { target: { value: "a" } });

    expect(markdownRender).toHaveBeenCalledTimes(1);
  });
});

function noop() {}
