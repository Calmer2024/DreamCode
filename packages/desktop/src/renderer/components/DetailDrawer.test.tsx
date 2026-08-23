// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import type { DesktopTerminalEntry } from "../state/desktop-state";
import { DetailDrawer } from "./DetailDrawer";

vi.mock("./TerminalView", () => ({
  TerminalView: ({ terminalId, output }: { terminalId: string; output: string }) => (
    <div role="application" aria-label="系统终端" data-terminal-id={terminalId}>
      {output}
    </div>
  ),
}));

const terminalEntries: DesktopTerminalEntry[] = [
  {
    id: "terminal_1",
    toolCallId: "tool_1",
    tool: "shell_command",
    status: "success" as const,
    stream: "stdout" as const,
    text: "terminal evidence",
    timestamp: "2026-08-10T00:00:00.000Z",
  },
];

const events = [
  {
    id: "event_1",
    sessionId: "sess_1",
    turnId: "turn_1",
    type: "turn.completed" as const,
    timestamp: "2026-08-10T00:00:00.000Z",
    payload: { summary: "log evidence" },
  },
];

describe("DetailDrawer", () => {
  it("only exposes Codex-style logs and terminal tabs", () => {
    render(
      <DetailDrawer
        terminalEntries={terminalEntries}
        events={events}
        initialTab="logs"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "日志" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText(/log evidence/)[0]).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Diff" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "事件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "会话" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "终端" }));
    expect(screen.getByText("terminal evidence")).toBeVisible();
  });

  it("limits visible output to 200 KB", () => {
    const huge = `start-${"界".repeat(210 * 1024)}-hidden-tail`;
    render(
      <DetailDrawer
        terminalEntries={[{ ...terminalEntries[0]!, text: huge }]}
        initialTab="terminal"
        onClose={vi.fn()}
      />,
    );

    const output = screen.getByTestId("detail-output");
    expect(new TextEncoder().encode(output.textContent ?? "").byteLength).toBeLessThanOrEqual(
      200 * 1024,
    );
    expect(output).not.toHaveTextContent("hidden-tail");
  });

  it("closes from the panel tab bar", () => {
    const onClose = vi.fn();
    render(<DetailDrawer onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("starts a project-scoped system terminal", async () => {
    const startTerminal = vi.fn().mockResolvedValue({ terminalId: "terminal_live" });
    const api = {
      startTerminal,
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      onTerminalOutput: vi.fn().mockReturnValue(() => undefined),
    } as never;
    render(
      <DetailDrawer
        api={api}
        workspaceRoot={"D:\\Projects\\DreamCode"}
        initialTab="terminal"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(startTerminal).toHaveBeenCalledWith("D:\\Projects\\DreamCode"));
    expect(await screen.findByLabelText("系统终端")).toHaveAttribute(
      "data-terminal-id",
      "terminal_live",
    );
  });

  it("keeps terminal output emitted before the start request resolves", async () => {
    let deliverOutput:
      | ((output: { terminalId: string; stream: "stdout"; text: string }) => void)
      | undefined;
    let resolveStart: ((value: { terminalId: string }) => void) | undefined;
    const startTerminal = vi.fn(
      () =>
        new Promise<{ terminalId: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const api = {
      startTerminal,
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      onTerminalOutput: vi.fn((listener) => {
        deliverOutput = listener;
        return () => undefined;
      }),
    } as never;
    render(
      <DetailDrawer
        api={api}
        workspaceRoot={"D:\\Projects\\DreamCode"}
        initialTab="terminal"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(startTerminal).toHaveBeenCalledOnce());
    deliverOutput?.({
      terminalId: "terminal_live",
      stream: "stdout",
      text: "PS D:\\Projects\\DreamCode> ",
    });
    resolveStart?.({ terminalId: "terminal_live" });

    expect(await screen.findByLabelText("系统终端")).toHaveTextContent(
      "PS D:\\Projects\\DreamCode>",
    );
  });
});
