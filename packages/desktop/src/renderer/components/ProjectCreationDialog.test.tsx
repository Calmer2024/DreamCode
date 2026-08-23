// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi, DesktopBootstrap } from "../../shared/contracts";
import "../../test/setup";
import { ProjectCreationDialog } from "./ProjectCreationDialog";

const bootstrap: DesktopBootstrap = { profiles: [], presets: [], sessions: [] };

describe("ProjectCreationDialog", () => {
  it("creates a managed project when no source directory is selected", async () => {
    const createProject = vi.fn().mockResolvedValue({
      bootstrap,
      workspaceRoot: "D:\\DreamCode\\projects\\Managed App",
    });
    const onCreated = vi.fn();
    render(
      <ProjectCreationDialog
        api={{ createProject } as unknown as DesktopApi}
        onCancel={vi.fn()}
        onCreated={onCreated}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), {
      target: { value: "Managed App" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: "Managed App" }));
    expect(onCreated).toHaveBeenCalledWith(bootstrap, "D:\\DreamCode\\projects\\Managed App");
  });

  it("registers a selected existing directory as the project source", async () => {
    const chooseWorkspace = vi.fn().mockResolvedValue("D:\\Projects\\Existing");
    const saveProject = vi.fn().mockResolvedValue(bootstrap);
    render(
      <ProjectCreationDialog
        api={{ chooseWorkspace, saveProject } as unknown as DesktopApi}
        onCancel={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /选择现有目录/ }));
    await screen.findByText("D:\\Projects\\Existing");
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() =>
      expect(saveProject).toHaveBeenCalledWith({
        workspaceRoot: "D:\\Projects\\Existing",
        name: "Existing",
      }),
    );
  });
});
