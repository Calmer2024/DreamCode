// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi, DesktopBootstrap } from "../../shared/contracts";
import "../../test/setup";
import { ConfigDialog } from "./ConfigDialog";

const bootstrap: DesktopBootstrap = {
  profiles: [
    {
      id: "profile_work",
      alias: "工作",
      provider: "openai",
      model: "gpt-existing",
      baseURL: "https://api.openai.com/v1",
      credentialSource: "inline",
      credentialAvailable: true,
    },
  ],
  currentProfileId: "profile_work",
  presets: [
    {
      id: "openai",
      displayName: "OpenAI",
      defaultModel: "gpt-default",
      models: [{ id: "gpt-default", label: "GPT Default" }],
    },
    {
      id: "openai-compatible",
      displayName: "自定义 OpenAI-compatible",
      defaultModel: "custom-default",
      requiresBaseURL: true,
    },
  ],
  sessions: [],
};

function api(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    updateProfile: vi.fn().mockResolvedValue(bootstrap),
    createProfile: vi.fn().mockResolvedValue(bootstrap),
    deleteProfile: vi.fn().mockResolvedValue(bootstrap),
    setDefaultProfile: vi.fn().mockResolvedValue(bootstrap),
    testProfile: vi.fn().mockResolvedValue({ ok: true, message: "连接测试成功。" }),
    updateWebSearchCredential: vi.fn().mockResolvedValue(bootstrap),
    ...overrides,
  } as DesktopApi;
}

describe("ConfigDialog", () => {
  it("shows the low-density auto-discovered Skill manager", async () => {
    const listSkills = vi.fn().mockResolvedValue({
      generation: 1,
      customRoots: [],
      diagnostics: [],
      skills: [{
        skillId: "skill_review",
        name: "Review",
        description: "Review a change before it ships.",
        source: "user",
        provider: "agents",
        capabilities: ["filesystem.read"],
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
    });
    render(
      <ConfigDialog
        api={api({ listSkills })}
        bootstrap={bootstrap}
        open
        initialSection="skills"
        workspaceRoot="D:/project"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Review a change before it ships.")).toBeInTheDocument();
    expect(screen.getByText("读取文件")).toBeInTheDocument();
    expect(screen.getByText("未声明版本")).toBeInTheDocument();
    expect(screen.getByText(/自动发现/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("详情"));
    expect(screen.getByText("C:\\skills\\review")).toBeVisible();
    expect(screen.getByText("允许隐式调用，也可用 / 或 $ 显式调用")).toBeVisible();
  });

  it("filters by source and forwards Git ref and subpath during installation", async () => {
    const snapshot = {
      generation: 1,
      customRoots: [],
      diagnostics: [],
      skills: [
        { ...desktopSkill("Project helper", "project"), skillId: "project" },
        { ...desktopSkill("User helper", "user"), skillId: "user" },
      ],
    };
    const installSkill = vi.fn().mockResolvedValue(snapshot);
    render(
      <ConfigDialog
        api={api({ listSkills: vi.fn().mockResolvedValue(snapshot), installSkill })}
        bootstrap={bootstrap}
        open
        initialSection="skills"
        workspaceRoot="D:/project"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Project helper")).toBeVisible();
    fireEvent.change(screen.getByLabelText("按来源筛选"), { target: { value: "project" } });
    expect(screen.getByText("Project helper")).toBeVisible();
    expect(screen.queryByText("User helper")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.change(screen.getByLabelText("来源类型"), { target: { value: "git" } });
    fireEvent.change(screen.getByLabelText("技能来源"), { target: { value: "https://example.test/skills.git" } });
    fireEvent.change(screen.getByLabelText("Git ref"), { target: { value: "v2.1.0" } });
    fireEvent.change(screen.getByLabelText("仓库子目录"), { target: { value: "skills/review" } });
    fireEvent.click(screen.getByRole("button", { name: "安装" }));

    await waitFor(() => expect(installSkill).toHaveBeenCalledWith({
      workspaceRoot: "D:/project",
      scope: "project",
      source: {
        type: "git",
        location: "https://example.test/skills.git",
        ref: "v2.1.0",
        subpath: "skills/review",
      },
      confirmations: undefined,
    }));
  });

  it("saves the Exa API key from General settings", async () => {
    const updateWebSearchCredential = vi.fn().mockResolvedValue({
      ...bootstrap,
      webSearch: { provider: "exa", credentialSource: "inline", credentialAvailable: true },
    });
    render(
      <ConfigDialog
        api={api({ updateWebSearchCredential })}
        bootstrap={bootstrap}
        open
        initialSection="general"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "网页搜索 API" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Exa API Key"), {
      target: { value: "exa-replacement-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(updateWebSearchCredential).toHaveBeenCalledWith({
        mode: "inline",
        apiKey: "exa-replacement-key",
      }),
    );
  });

  it("preserves a stored secret unless the user replaces it", async () => {
    const updateProfile = vi.fn().mockResolvedValue(bootstrap);
    render(
      <ConfigDialog api={api({ updateProfile })} bootstrap={bootstrap} open onClose={vi.fn()} />,
    );

    expect(screen.queryByDisplayValue("secret-value")).not.toBeInTheDocument();
    expect(screen.getByText("当前凭证可用")).toBeVisible();
    fireEvent.change(screen.getByLabelText("新的 API Key"), {
      target: { value: "replacement-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "profile_work",
          alias: "工作",
          credential: { mode: "inline", apiKey: "replacement-key" },
        }),
      ),
    );
  });

  it("creates a second profile for the same provider with a distinct alias", async () => {
    const createProfile = vi.fn().mockResolvedValue(bootstrap);
    render(
      <ConfigDialog api={api({ createProfile })} bootstrap={bootstrap} open onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新建配置" }));
    fireEvent.change(screen.getByLabelText("配置别名"), { target: { value: "个人" } });
    fireEvent.click(screen.getByRole("button", { name: "本地保存" }));
    fireEvent.change(screen.getByLabelText("新的 API Key"), { target: { value: "new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(createProfile).toHaveBeenCalledWith(
        expect.objectContaining({ alias: "个人", provider: "openai" }),
      ),
    );
  });

  it("preserves an existing custom model and tests the draft without saving", async () => {
    const testProfile = vi.fn().mockResolvedValue({ ok: true, message: "连接测试成功。" });
    render(
      <ConfigDialog api={api({ testProfile })} bootstrap={bootstrap} open onClose={vi.fn()} />,
    );

    expect(screen.getByLabelText("自定义模型 ID")).toHaveValue("gpt-existing");
    fireEvent.change(screen.getByLabelText("自定义模型 ID"), {
      target: { value: "gpt-next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() =>
      expect(testProfile).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-next" })),
    );
    expect(await screen.findByText("连接测试成功。")).toBeVisible();
  });

  it("asks before discarding unsaved changes", () => {
    render(<ConfigDialog api={api()} bootstrap={bootstrap} open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("配置别名"), { target: { value: "已修改" } });
    fireEvent.click(screen.getByRole("button", { name: "返回应用" }));

    expect(screen.getByRole("dialog", { name: "放弃未保存更改" })).toBeVisible();
  });

  it("applies the saved profile selected in the configuration list", () => {
    const onApplyProfile = vi.fn();
    const withPersonalProfile: DesktopBootstrap = {
      ...bootstrap,
      profiles: [
        ...bootstrap.profiles,
        {
          ...bootstrap.profiles[0]!,
          id: "profile_personal",
          alias: "个人",
          model: "gpt-default",
        },
      ],
    };
    render(
      <ConfigDialog
        api={api()}
        bootstrap={withPersonalProfile}
        activeProfileId="profile_work"
        open
        onClose={vi.fn()}
        onApplyProfile={onApplyProfile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /OpenAI · 个人/ }));

    expect(onApplyProfile).toHaveBeenCalledWith("profile_personal");
    expect(screen.getByRole("button", { name: /OpenAI · 个人/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("keeps the editor open and reports a set-default failure", async () => {
    const nonDefault = {
      ...bootstrap,
      currentProfileId: undefined,
    };
    const setDefaultProfile = vi.fn().mockRejectedValue(new Error("unavailable"));
    render(
      <ConfigDialog
        api={api({ setDefaultProfile })}
        bootstrap={nonDefault}
        open
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "设为默认" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("设置默认配置失败，请稍后重试。");
    expect(screen.getByLabelText("配置别名")).toHaveValue("工作");
  });

  it("keeps the profile and reports a delete failure", async () => {
    const deleteProfile = vi.fn().mockRejectedValue(new Error("unavailable"));
    render(
      <ConfigDialog api={api({ deleteProfile })} bootstrap={bootstrap} open onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("配置删除失败，请稍后重试。");
    expect(screen.getByLabelText("配置别名")).toHaveValue("工作");
  });
});

function desktopSkill(name: string, source: "user" | "project") {
  return {
    skillId: name,
    name,
    description: `${name} description`,
    source,
    provider: "dreamcode",
    capabilities: [],
    allowImplicitInvocation: true,
    path: `D:\\skills\\${name}`,
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
