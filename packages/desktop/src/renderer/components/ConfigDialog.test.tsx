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
