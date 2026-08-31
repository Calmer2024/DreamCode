import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const launchedApplications = new Set<ElectronApplication>();

export interface DesktopScenario {
  root: string;
  home: string;
  workspace: string;
}

export async function prepareScenario(
  fixtureName: "failing-test-js" | "readme-update" | "skill-system",
  profileModel?: string,
): Promise<DesktopScenario> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-e2e-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home, { recursive: true });
  const fixturePath = path.join(repositoryRoot, "evals", "fixtures", fixtureName);
  if (existsSync(fixturePath)) {
    await cp(fixturePath, workspace, { recursive: true });
  } else {
    await createFallbackFixture(workspace, fixtureName);
  }
  if (profileModel) {
    await writeFile(
      path.join(home, "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          currentProfile: "fake-e2e",
          profiles: { "fake-e2e": { provider: "fake", model: profileModel } },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return { root, home, workspace };
}

async function createFallbackFixture(
  workspace: string,
  fixtureName: "failing-test-js" | "readme-update" | "skill-system",
): Promise<void> {
  await mkdir(workspace, { recursive: true });
  if (fixtureName !== "failing-test-js") {
    await writeFile(path.join(workspace, "README.md"), `# ${fixtureName} E2E workspace\n`, "utf8");
    return;
  }
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "test"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({
    name: "dreamcode-failing-test-e2e",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, "src", "math.js"), "export function add(a, b) {\n  return a - b;\n}\n", "utf8");
  await writeFile(path.join(workspace, "test", "math.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "../src/math.js";',
    "",
    'test("adds numbers", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"), "utf8");
}

export async function launchDesktop(scenario: DesktopScenario): Promise<{
  app: ElectronApplication;
  consoleMessages: string[];
  page: Page;
}> {
  const app = await electron.launch({
    args: [path.join(packageRoot, "dist-main", "main", "index.js")],
    env: {
      ...process.env,
      DREAMCODE_HOME: scenario.home,
      DREAMCODE_E2E: "1",
      DREAMCODE_E2E_WORKSPACE: scenario.workspace,
    },
  });
  launchedApplications.add(app);
  const consoleMessages: string[] = [];
  const processMessages: string[] = [];
  app.process().stdout?.on("data", (chunk) => processMessages.push(String(chunk)));
  app.process().stderr?.on("data", (chunk) => processMessages.push(String(chunk)));
  app.on("window", (window) => {
    window.on("console", (message) => {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    });
  });
  const page = await Promise.race([
    app.firstWindow(),
    new Promise<never>((_, reject) => {
      const process = app.process();
      const fail = (code: number | null) => reject(new Error(
        `Electron exited before creating a window (code ${code ?? "unknown"}).${processMessages.length ? `\n${processMessages.join("")}` : ""}`,
      ));
      if (process.exitCode !== null) fail(process.exitCode);
      else process.once("exit", fail);
    }),
  ]);
  await page.waitForLoadState("domcontentloaded");
  return { app, consoleMessages, page };
}

export async function closeAllDesktopApplications(): Promise<void> {
  const applications = [...launchedApplications];
  launchedApplications.clear();
  await Promise.all(applications.map((application) => quitDesktopApplication(application)));
}

export async function closeDesktopApplication(application: ElectronApplication): Promise<void> {
  await quitDesktopApplication(application);
  launchedApplications.delete(application);
}

async function quitDesktopApplication(application: ElectronApplication): Promise<void> {
  const electronProcess = application.process();
  const exited =
    electronProcess.exitCode === null
      ? new Promise<void>((resolve) => electronProcess.once("exit", () => resolve()))
      : Promise.resolve();
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await exited;
}

export async function selectWorkspace(page: Page): Promise<void> {
  await page.getByLabel("选择工作区", { exact: true }).click();
  await page.getByRole("button", { name: /在资源管理器中打开：workspace/ }).waitFor();
}

export async function saveFakeProfile(page: Page): Promise<void> {
  await page.getByText("模型未配置", { exact: true }).waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByLabel("配置别名").fill("fake-e2e");
  await page.getByRole("combobox", { name: "提供商" }).selectOption("fake");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("编辑配置", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await page.getByRole("main", { name: "设置" }).waitFor({ state: "detached" });
}

export async function runPrompt(page: Page, prompt: string, mode = "yolo"): Promise<void> {
  await page.getByRole("combobox", { name: "运行模式" }).selectOption(mode);
  await page.getByRole("textbox", { name: "给 DreamCode 发送消息" }).fill(prompt);
  await page.getByRole("button", { name: "发送" }).click();
}

export async function readWorkspaceFile(scenario: DesktopScenario, relativePath: string) {
  return readFile(path.join(scenario.workspace, relativePath), "utf8");
}

export async function cleanupScenario(scenario: DesktopScenario): Promise<void> {
  await rm(scenario.root, { recursive: true, force: true });
}
