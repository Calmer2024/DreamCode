import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupScenario,
  closeAllDesktopApplications,
  closeDesktopApplication,
  launchDesktop,
  prepareScenario,
  readWorkspaceFile,
  runPrompt,
  saveFakeProfile,
  selectWorkspace,
} from "./fixtures";

test.afterEach(async () => {
  await closeAllDesktopApplications();
});

test("launches, completes a Fake task, reviews inline changes, restarts, and resumes the Session", async () => {
  test.slow();
  const scenario = await prepareScenario("failing-test-js");
  const prompt = "修复当前项目的测试失败, 并运行测试确认。";
  try {
    const first = await test.step("complete the initial Fake task", async () => {
      const desktop = await launchDesktop(scenario);
      await expect(desktop.page.getByText("DreamCode", { exact: true })).toBeVisible();
      await expect(desktop.page.getByRole("heading", { level: 2, name: "新对话" })).toBeVisible();
      await expect(desktop.page.getByText("拉取请求", { exact: true })).toHaveCount(0);
      expect(desktop.consoleMessages).not.toContainEqual(
        expect.stringMatching(/Insecure Content-Security-Policy/i),
      );
      await selectWorkspace(desktop.page);
      await saveFakeProfile(desktop.page);
      await runPrompt(desktop.page, prompt);
      await expect(desktop.page.getByText(/^已完成 · 耗时 /)).toBeVisible({
        timeout: 30_000,
      });
      await expect(desktop.page.getByText("DreamCode", { exact: true })).toBeVisible();
      await expect(desktop.page.getByRole("heading", { level: 2, name: prompt })).toBeVisible();
      await expect(desktop.page.getByRole("status", { name: /上下文已用 \d+%/ })).toBeVisible();
      await expect(desktop.page.getByRole("status", { name: "本轮 Token 用量" })).toContainText(
        /tokens · 输入 .* · 输出 /,
      );
      expect(await desktop.page.evaluate(() => window.scrollY)).toBe(0);
      const conversationScroll = desktop.page.locator(".conversation-scroll");
      await expect(conversationScroll).toHaveCSS("overflow-y", "scroll");
      await expect(conversationScroll).toHaveCSS("scrollbar-gutter", "stable");
      return desktop;
    });
    expect(await readWorkspaceFile(scenario, "src/math.js")).toContain("return a + b;");

    await test.step("inspect the inline change card and close the completed app", async () => {
      const changes = first.page.getByLabel("已编辑 1 个文件");
      await expect(changes).toContainText("src/math.js");
      await changes.getByRole("button", { name: "审核" }).click();
      await expect(changes.getByText("+  return a + b;", { exact: false })).toBeVisible();
      await closeDesktopApplication(first.app);
    });

    await test.step("relaunch and resume the same Session", async () => {
      const second = await launchDesktop(scenario);
      await second.page.getByRole("button", { name: prompt }).click();
      await runPrompt(second.page, "Inspect workspace and report status.");
      await expect(second.page.getByText(/^已完成 · 耗时 /)).toBeVisible({
        timeout: 30_000,
      });
      await expect(second.page.getByText("DreamCode", { exact: true })).toBeVisible();
      await expect(second.page.getByRole("heading", { level: 2, name: prompt })).toBeVisible();
      expect(await second.page.evaluate(() => window.scrollY)).toBe(0);
      await closeDesktopApplication(second.app);
    });

    const sessions = await readdir(path.join(scenario.home, "sessions"));
    expect(sessions).toHaveLength(1);
    const events = await readFile(
      path.join(scenario.home, "sessions", sessions[0] as string, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"type":"session.resumed"');
  } finally {
    await cleanupScenario(scenario);
  }
});

for (const decision of ["允许", "拒绝"] as const) {
  test(`handles a guided Fake Provider approval decision: ${decision}`, async () => {
    const scenario = await prepareScenario("readme-update", "fake");
    const original = await readWorkspaceFile(scenario, "README.md");
    try {
      const desktop = await launchDesktop(scenario);
      await selectWorkspace(desktop.page);
      await runPrompt(desktop.page, "Update README with usage instructions.", "guided");
      const approval = desktop.page.getByRole("alertdialog", { name: "工具审批" });
      await expect(approval).toBeVisible();
      await approval.getByRole("button", { name: decision }).click();
      await expect(desktop.page.getByText(/^已完成 · 耗时 /)).toBeVisible({
        timeout: 30_000,
      });
      const updated = await readWorkspaceFile(scenario, "README.md");
      expect(updated === original).toBe(decision === "拒绝");
      await closeDesktopApplication(desktop.app);
    } finally {
      await cleanupScenario(scenario);
    }
  });
}

test("stops an E2E-only blocking Fake Provider", async () => {
  const scenario = await prepareScenario("failing-test-js", "e2e-blocking");
  try {
    const desktop = await test.step("start the blocking provider", async () => {
      const app = await launchDesktop(scenario);
      await selectWorkspace(app.page);
      await runPrompt(app.page, "Keep running until stopped.");
      return app;
    });
    await test.step("stop the blocking provider", async () => {
      await desktop.page.getByRole("button", { name: "停止" }).click();
      await expect(desktop.page.getByText("已停止", { exact: true })).toBeVisible();
    });
    await test.step("close the stopped app", () => closeDesktopApplication(desktop.app));
  } finally {
    await cleanupScenario(scenario);
  }
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object-destructured fixture argument.
test("keeps model profile settings aligned and responsive", async ({}, testInfo) => {
  const scenario = await prepareScenario("failing-test-js", "fake");
  try {
    const desktop = await launchDesktop(scenario);
    await desktop.page.setViewportSize({ width: 1280, height: 800 });
    await desktop.page.getByRole("button", { name: "设置", exact: true }).click();
    await desktop.page.getByRole("button", { name: "模型", exact: true }).click();

    await expect
      .poll(() =>
        desktop.page.evaluate(async () => {
          await document.fonts.ready;
          return document.fonts.check('14px "Noto Sans SC"', "中文界面");
        }),
      )
      .toBe(true);
    for (const locator of [
      desktop.page.locator("body"),
      desktop.page.getByRole("button", { name: "返回应用", exact: true }),
      desktop.page.getByLabel("配置别名"),
    ]) {
      await expect(locator).toHaveCSS("font-family", /Noto Sans SC/);
    }

    const contentHeader = desktop.page.locator(".settings-content-header");
    const modelGroup = desktop.page.locator(".model-settings-group");
    const modelHeaderBox = await contentHeader.boundingBox();
    const modelGroupBox = await modelGroup.boundingBox();
    expect(modelHeaderBox && modelGroupBox).toBeTruthy();
    const modelGap = modelGroupBox!.y - (modelHeaderBox!.y + modelHeaderBox!.height);

    await expect(modelGroup.getByRole("heading", { name: "模型配置" })).toHaveCSS(
      "font-weight",
      /^(6[0-9]{2}|bold)$/,
    );
    await expect(desktop.page.getByLabel("配置别名")).toHaveCSS("font-weight", "400");
    await expect(desktop.page.getByRole("button", { name: "提供商选项" })).toHaveCSS(
      "font-weight",
      "400",
    );
    await expect(desktop.page.getByRole("button", { name: "模型选项" })).toHaveCSS(
      "font-weight",
      "400",
    );
    const profileListBox = await desktop.page.locator(".profile-list").boundingBox();
    const profileEditorBox = await desktop.page.locator(".profile-editor").boundingBox();
    expect(profileListBox && profileEditorBox).toBeTruthy();
    expect(profileEditorBox!.y).toBeGreaterThanOrEqual(profileListBox!.y + profileListBox!.height);
    expect(Math.abs(profileListBox!.width - profileEditorBox!.width)).toBeLessThanOrEqual(1);
    for (const action of ["测试连接", "保存"] as const) {
      const button = desktop.page.getByRole("button", { name: action, exact: true });
      await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(button).toHaveCSS("font-size", "12px");
    }
    await desktop.page.screenshot({ path: testInfo.outputPath("model-config-standard.png") });
    await desktop.page.getByRole("button", { name: "保存", exact: true }).scrollIntoViewIfNeeded();
    await desktop.page.screenshot({ path: testInfo.outputPath("model-config-actions.png") });

    await desktop.page.getByRole("button", { name: "常规", exact: true }).click();
    const generalGroup = desktop.page.locator(".settings-group");
    const generalHeaderBox = await contentHeader.boundingBox();
    const generalGroupBox = await generalGroup.boundingBox();
    expect(generalHeaderBox && generalGroupBox).toBeTruthy();
    const generalGap = generalGroupBox!.y - (generalHeaderBox!.y + generalHeaderBox!.height);
    expect(Math.abs(modelGap - generalGap)).toBeLessThanOrEqual(1);

    await desktop.page.getByRole("button", { name: "模型", exact: true }).click();
    await desktop.page.setViewportSize({ width: 820, height: 720 });
    await expect(desktop.page.locator(".profile-manager")).toHaveCSS(
      "grid-template-columns",
      /^\d+(\.\d+)?px$/,
    );
    expect(
      await desktop.page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await desktop.page.screenshot({ path: testInfo.outputPath("model-config-narrow.png") });
    await closeDesktopApplication(desktop.app);
  } finally {
    await cleanupScenario(scenario);
  }
});

test("opens an interactive project terminal with Ctrl+backtick and resizes the workspace", async () => {
  const scenario = await prepareScenario("failing-test-js", "fake");
  try {
    const desktop = await launchDesktop(scenario);
    await selectWorkspace(desktop.page);

    await desktop.page.keyboard.press("Control+Backquote");
    const panel = desktop.page.getByRole("dialog", { name: "底部面板" });
    const terminal = desktop.page.getByRole("application", { name: "系统终端" });
    await expect(panel).toBeVisible();
    await expect(desktop.page.getByRole("tab", { name: "终端" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(terminal).toHaveCSS("background-color", "rgb(255, 255, 255)");

    await terminal.click();
    await desktop.page.keyboard.type("Write-Output DREAMCODE_TERMINAL_READY; (Get-Location).Path");
    await desktop.page.keyboard.press("Enter");
    await expect(terminal).toContainText("DREAMCODE_TERMINAL_READY", { timeout: 15_000 });
    await expect(terminal).toContainText(scenario.workspace);

    const composer = desktop.page.locator(".composer-stack");
    const conversation = desktop.page.locator(".conversation-scroll");
    const handle = desktop.page.getByRole("button", { name: "调整底部栏高度" });
    const beforeComposer = await composer.boundingBox();
    const beforeConversation = await conversation.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(beforeComposer && beforeConversation && handleBox).toBeTruthy();
    await desktop.page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 5);
    await desktop.page.mouse.down();
    await desktop.page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 100, {
      steps: 8,
    });
    await desktop.page.mouse.up();
    const afterComposer = await composer.boundingBox();
    const afterConversation = await conversation.boundingBox();
    expect(afterComposer!.y).toBeLessThan(beforeComposer!.y - 70);
    expect(afterConversation!.height).toBeLessThan(beforeConversation!.height - 70);

    await desktop.page.keyboard.press("Control+Backquote");
    await expect(panel).toBeHidden();
    await closeDesktopApplication(desktop.app);
  } finally {
    await cleanupScenario(scenario);
  }
});
