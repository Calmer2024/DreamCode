// @vitest-environment jsdom

import type { ChangedFile } from "@dreamcode/shared";
import type { ReplayedSessionState } from "@dreamcode/store";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../shared/contracts";
import "../../test/setup";
import { DetailDrawer } from "./DetailDrawer";

const changedFile: ChangedFile = { path: "src/index.ts", operation: "update" };
const session: ReplayedSessionState = {
  session: {
    id: "sess_1",
    workspaceRoot: "D:\\repo",
    sessionDir: "D:\\sessions\\sess_1",
    createdAt: "2026-08-10T00:00:00.000Z",
  },
  turns: [],
  status: "completed",
  todoItems: [],
  changedFiles: [changedFile],
  commands: [{ command: "pnpm test", summary: "passed", exitCode: 0 }],
  artifacts: [],
  approvals: [],
  costUsd: 0,
  warnings: [],
};

describe("DetailDrawer", () => {
  it("requires exact-path modal confirmation before rollback and refreshes evidence", async () => {
    const refreshed = { ...session, status: "rolled_back" as const };
    const readDiff = vi.fn().mockResolvedValue("-old\n+new");
    const rollback = vi.fn().mockResolvedValue({
      rolledBackFiles: [changedFile.path],
      failedFiles: [],
    });
    const readSession = vi.fn().mockResolvedValue(refreshed);
    const onSessionRefresh = vi.fn();
    const api = { readDiff, rollback, readSession } as unknown as DesktopApi;
    render(
      <DetailDrawer
        api={api}
        session={session}
        changedFile={changedFile}
        onClose={vi.fn()}
        onSessionRefresh={onSessionRefresh}
      />,
    );

    expect(await screen.findByText(/-old/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "回滚文件" }));
    expect(rollback).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认回滚文件" })).toHaveTextContent("src/index.ts");
    fireEvent.click(screen.getByRole("button", { name: "确认回滚" }));

    await waitFor(() =>
      expect(rollback).toHaveBeenCalledWith({
        sessionId: "sess_1",
        filePath: changedFile.path,
      }),
    );
    await waitFor(() => expect(readSession).toHaveBeenCalledWith("sess_1"));
    await waitFor(() => expect(readDiff).toHaveBeenCalledTimes(2));
    expect(onSessionRefresh).toHaveBeenCalledWith(refreshed);
    expect(await screen.findByRole("status")).toHaveTextContent("已回滚 src/index.ts");
  });

  it("exposes diff, terminal, event, and session tabs", async () => {
    const api = { readDiff: vi.fn().mockResolvedValue("diff evidence") } as unknown as DesktopApi;
    render(
      <DetailDrawer
        api={api}
        session={session}
        changedFile={changedFile}
        terminalEntries={[
          {
            id: "terminal_1",
            toolCallId: "tool_1",
            tool: "shell_command",
            status: "success",
            stream: "stdout",
            text: "terminal evidence",
            timestamp: "2026-08-10T00:00:00.000Z",
          },
        ]}
        events={[
          {
            id: "event_1",
            sessionId: "sess_1",
            turnId: "turn_1",
            type: "turn.completed",
            timestamp: "2026-08-10T00:00:00.000Z",
            payload: { summary: "event evidence" },
          },
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("diff evidence")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "终端" }));
    expect(screen.getByText(/terminal evidence/)).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "事件" }));
    expect(screen.getByText(/event evidence/)).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    expect(screen.getByText(/pnpm test/)).toBeVisible();
  });

  it("limits each visible evidence view to 200 KB", async () => {
    const huge = `start-${"界".repeat(210 * 1024)}-hidden-tail`;
    const api = { readDiff: vi.fn().mockResolvedValue(huge) } as unknown as DesktopApi;
    render(
      <DetailDrawer api={api} session={session} changedFile={changedFile} onClose={vi.fn()} />,
    );

    const evidence = await screen.findByTestId("detail-output");
    expect(new TextEncoder().encode(evidence.textContent ?? "").byteLength).toBeLessThanOrEqual(
      200 * 1024,
    );
    expect(evidence).not.toHaveTextContent("hidden-tail");
  });

  it("loads live-run diff evidence from an active session id before replay is loaded", async () => {
    const readDiff = vi.fn().mockResolvedValue("live diff");
    const api = { readDiff } as unknown as DesktopApi;
    render(
      <DetailDrawer api={api} sessionId="sess_live" changedFile={changedFile} onClose={vi.fn()} />,
    );

    expect(await screen.findByText("live diff")).toBeVisible();
    expect(readDiff).toHaveBeenCalledWith({ sessionId: "sess_live", filePath: changedFile.path });
    expect(screen.getByRole("button", { name: "回滚文件" })).toBeEnabled();
  });
});
