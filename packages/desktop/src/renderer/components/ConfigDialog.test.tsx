// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi, DesktopBootstrap } from "../../shared/contracts";
import "../../test/setup";
import { ConfigDialog } from "./ConfigDialog";

const bootstrap: DesktopBootstrap = {
  profiles: [
    {
      name: "work",
      provider: "openai",
      model: "gpt-existing",
      baseURL: "https://api.openai.com/v1",
      apiKeyConfigured: true,
    },
  ],
  currentProfile: "work",
  presets: [
    {
      id: "openai",
      displayName: "OpenAI",
      defaultModel: "gpt-default",
      models: [{ id: "gpt-default", label: "GPT Default" }],
    },
    { id: "custom-provider", displayName: "Custom", defaultModel: "custom-default" },
  ],
  sessions: [],
};

describe("ConfigDialog", () => {
  it("saves a profile without rendering an existing secret", async () => {
    const saveProfile = vi.fn().mockResolvedValue(bootstrap);
    const api = { saveProfile } as unknown as DesktopApi;
    const bootstrapWithConfiguredSecret = {
      ...bootstrap,
      profiles: [{ ...bootstrap.profiles[0]!, apiKey: "secret-value" }],
    } as unknown as DesktopBootstrap;

    render(
      <ConfigDialog api={api} bootstrap={bootstrapWithConfiguredSecret} open onClose={vi.fn()} />,
    );

    expect(screen.queryByDisplayValue("secret-value")).not.toBeInTheDocument();
    expect(screen.getByText("API Key 已配置")).toBeVisible();
    expect(screen.getByText(/明文存储/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("新的 API Key"), {
      target: { value: "replacement-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(saveProfile).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "replacement-key", name: "work" }),
      ),
    );
  });

  it("preserves an existing custom model and saves a new custom model", async () => {
    const saveProfile = vi.fn().mockResolvedValue(bootstrap);
    const api = { saveProfile } as unknown as DesktopApi;
    render(<ConfigDialog api={api} bootstrap={bootstrap} open onClose={vi.fn()} />);

    expect(screen.getByLabelText("自定义模型 ID")).toHaveValue("gpt-existing");
    fireEvent.change(screen.getByLabelText("自定义模型 ID"), {
      target: { value: "gpt-next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-next" })),
    );
  });

  it("switches from a preset model to custom model input", () => {
    const presetBootstrap: DesktopBootstrap = {
      ...bootstrap,
      profiles: [{ ...bootstrap.profiles[0]!, model: "gpt-default" }],
    };
    render(
      <ConfigDialog api={{} as DesktopApi} bootstrap={presetBootstrap} open onClose={vi.fn()} />,
    );

    expect(screen.queryByLabelText("自定义模型 ID")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "__custom__" } });
    expect(screen.getByLabelText("自定义模型 ID")).toBeVisible();
  });
});
