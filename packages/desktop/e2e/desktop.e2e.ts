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

test("launches, completes a Fake task, shows Diff, restarts, and resumes the Session", async () => {
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
      return desktop;
    });
    expect(await readWorkspaceFile(scenario, "src/math.js")).toContain("return a + b;");

    await test.step("inspect the recorded Diff and close the completed app", async () => {
      await first.page.getByRole("button", { name: "文件变更" }).click();
      await expect(first.page.getByRole("combobox", { name: "变更文件" })).toHaveValue(
        "src/math.js",
      );
      await expect(first.page.getByText("+  return a + b;", { exact: false })).toBeVisible();
      await closeDesktopApplication(first.app);
    });

    await test.step("relaunch and resume the same Session", async () => {
      const second = await launchDesktop(scenario);
      await second.page.getByRole("button", { name: prompt }).click();
      await runPrompt(second.page, "Inspect workspace and report status.");
      await expect(second.page.getByText(/^已完成 · 耗时 /)).toBeVisible({
        timeout: 30_000,
      });
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
