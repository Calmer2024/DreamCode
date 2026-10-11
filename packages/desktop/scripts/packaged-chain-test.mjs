import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.join(packageRoot, "release");
const { version } = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const executablePath = path.join(releaseDirectory, `DreamCode-Portable-${version}-x64.exe`);
const reportPath = path.join(releaseDirectory, "chain-test-report.json");
const startedAt = new Date().toISOString();
const assertions = {
  startupVisible: false,
  taskCompleted: false,
  fileChanged: false,
  commandExitCodeZero: false,
  usageReported: false,
  sessionResumed: false,
  traceConfigPreserved: false,
  traceUploaded: false,
};

let scenarioRoot;
let activeApplication;
let executableSha256 = "";
let commandResults = [];
let traceReceiver;
const tracedRuns = new Map();

try {
  const executable = await readFile(executablePath);
  executableSha256 = createHash("sha256").update(executable).digest("hex");

  scenarioRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-packaged-chain-"));
  const home = path.join(scenarioRoot, "home");
  const workspace = path.join(scenarioRoot, "workspace");
  await mkdir(home, { recursive: true });
  await createFixtureWorkspace(workspace);
  traceReceiver = createHttpServer(async (request, response) => {
    try {
      if (request.url === "/info") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ batch_ingest_config: { use_multipart_endpoint: false } }));
        return;
      }
      if (request.url !== "/runs/batch" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const batch = JSON.parse(body);
      for (const run of [...(batch.post ?? []), ...(batch.patch ?? [])]) {
        tracedRuns.set(run.id, { ...tracedRuns.get(run.id), ...run });
      }
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve) => traceReceiver.listen(0, "127.0.0.1", resolve));
  const traceEndpoint = `http://127.0.0.1:${traceReceiver.address().port}`;
  await writeFile(
    path.join(home, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        currentProfile: "fake-packaged",
        profiles: { "fake-packaged": { provider: "fake", model: "fake" } },
        langsmith: {
          enabled: true,
          apiKey: "synthetic-packaged-trace-key",
          projectName: "packaged-trace-test",
          endpoint: traceEndpoint,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const first = await launchPackagedApplication({ home, workspace });
  activeApplication = first.app;
  assertions.startupVisible = await first.page.getByText("DreamCode", { exact: true }).isVisible();
  await chooseWorkspace(first.page);
  await runPrompt(first.page, "修复当前项目的测试失败, 并运行测试确认。");
  await first.page.getByText("已完成", { exact: true }).waitFor({ timeout: 30_000 });
  assertions.taskCompleted = true;
  assertions.fileChanged = (
    await readFile(path.join(workspace, "src", "math.js"), "utf8")
  ).includes("return a + b;");
  await closeApplication(first.app);
  activeApplication = undefined;

  const sessionDirectory = await readOnlySessionDirectory(home);
  let events = await readEvents(sessionDirectory);
  assertions.commandExitCodeZero = events.some(
    (event) =>
      event.type === "tool.completed" &&
      event.payload?.tool === (process.platform === "win32" ? "pwsh" : "bash") &&
      (event.payload?.execution?.exitCode ?? event.payload?.data?.exitCode) === 0,
  );
  commandResults = events
    .filter(
      (event) =>
        event.type === "tool.completed" &&
        event.payload?.tool === (process.platform === "win32" ? "pwsh" : "bash"),
    )
    .map((event) => ({
      status: event.payload.status,
      execution: event.payload.execution,
      error: event.payload.error,
      summary: event.payload.summary,
      streams: event.payload.streams,
    }));
  assertions.usageReported = events.some(
    (event) => event.type === "model.usage" && event.payload?.usage?.inputTokens > 0,
  );

  const second = await launchPackagedApplication({ home, workspace });
  activeApplication = second.app;
  await second.page
    .getByRole("button", { name: "修复当前项目的测试失败, 并运行测试确认。" })
    .click();
  const completedBeforeResume = (await readEvents(sessionDirectory)).filter(
    (event) => event.type === "turn.completed",
  ).length;
  await runPrompt(second.page, "Inspect workspace and report status.");
  await waitForNewTurnCompletion(sessionDirectory, completedBeforeResume);
  await closeApplication(second.app);
  activeApplication = undefined;

  events = await readEvents(sessionDirectory);
  assertions.sessionResumed = events.some((event) => event.type === "session.resumed");
  assertions.traceConfigPreserved =
    JSON.parse(await readFile(path.join(home, "config.json"), "utf8")).langsmith?.enabled === true;
  for (let attempt = 0; attempt < 50; attempt++) {
    const runs = [...tracedRuns.values()];
    const roots = runs.filter(
      (run) => !run.parent_run_id && run.outputs?.status === "turn.completed",
    );
    assertions.traceUploaded =
      roots.length >= 2 &&
      roots.every((root) => {
        const children = runs.filter((run) => run.parent_run_id === root.id);
        return (
          root.end_time &&
          children.some((run) => run.run_type === "llm") &&
          children.every((run) => run.end_time && run.trace_id === root.id)
        );
      }) &&
      runs.some((run) => run.run_type === "tool");
    if (assertions.traceUploaded) break;
    await delay(100);
  }
  const failedAssertions = Object.entries(assertions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedAssertions.length > 0) {
    throw new Error(`Packaged chain assertions failed: ${failedAssertions.join(", ")}`);
  }

  await writeReport({ status: "passed" });
  console.log(`Packaged chain test passed: ${reportPath}`);
} catch (error) {
  await writeReport({ status: "failed", error: readErrorMessage(error) });
  throw error;
} finally {
  if (activeApplication) {
    await closeApplication(activeApplication).catch(() => undefined);
  }
  if (scenarioRoot) {
    const resolvedRoot = path.resolve(scenarioRoot);
    if (
      path.dirname(resolvedRoot) === path.resolve(os.tmpdir()) &&
      path.basename(resolvedRoot).startsWith("dreamcode-packaged-chain-")
    ) {
      await rm(resolvedRoot, { recursive: true, force: true }).catch(() => undefined);
    } else console.error("Refused unexpected test cleanup directory.");
  }
  if (traceReceiver) await new Promise((resolve) => traceReceiver.close(resolve));
}

async function launchPackagedApplication({ home, workspace }) {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...environment } = process.env;
  for (const key of Object.keys(environment)) {
    if (/^(LANGSMITH_|LANGCHAIN_)/.test(key)) delete environment[key];
  }
  const debuggingPort = await reserveTcpPort();
  const childProcess = spawn(
    executablePath,
    [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debuggingPort}`],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...environment,
        DREAMCODE_HOME: home,
        DREAMCODE_E2E: "1",
        DREAMCODE_E2E_WORKSPACE: workspace,
      },
    },
  );
  const processExit = new Promise((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const application = { browser: undefined, childProcess, page: undefined, processExit };
  try {
    await waitForCdpEndpoint(debuggingPort, processExit);
    application.browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
    const context = application.browser.contexts()[0];
    if (!context) {
      throw new Error("Portable app exposed no Playwright browser context.");
    }
    application.page =
      context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 15_000 }));
    await application.page.waitForLoadState("domcontentloaded");
    return { app: application, page: application.page };
  } catch (error) {
    await closeApplication(application).catch(() => undefined);
    throw error;
  }
}

async function reserveTcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) {
    throw new Error("Failed to reserve a loopback debugging port.");
  }
  return port;
}

async function waitForCdpEndpoint(port, processExit) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      processExit.then(({ code, signal }) => ({ exited: true, code, signal })),
      fetch(`http://127.0.0.1:${port}/json/version`)
        .then((response) => ({ ready: response.ok }))
        .catch(() => ({ ready: false })),
    ]);
    if (outcome.exited) {
      throw new Error(
        `Portable app exited before CDP was ready (code ${outcome.code}, signal ${outcome.signal}).`,
      );
    }
    if (outcome.ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Portable app did not expose CDP within 30 seconds.");
}

async function chooseWorkspace(page) {
  await page.getByLabel("选择工作区", { exact: true }).click();
  await page.getByRole("button", { name: /在资源管理器中打开：workspace/ }).waitFor();
}

async function runPrompt(page, prompt) {
  await page.getByRole("combobox", { name: "运行模式" }).selectOption("workspace-write");
  await page.getByRole("textbox", { name: "给 DreamCode 发送消息" }).fill(prompt);
  await page.getByRole("button", { name: "发送" }).click();
}

async function waitForNewTurnCompletion(sessionDirectory, previousCount) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const completedCount = (await readEvents(sessionDirectory)).filter(
      (event) => event.type === "turn.completed",
    ).length;
    if (completedCount > previousCount) return;
    await delay(100);
  }
  throw new Error("Session did not persist a new turn.completed event within 30 seconds.");
}

async function closeApplication(application) {
  if (application.page) {
    await application.page.evaluate(() => window.close()).catch(() => undefined);
  }
  let exit;
  try {
    exit = await Promise.race([
      application.processExit,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Portable wrapper did not exit after browser close.")),
          15_000,
        ),
      ),
    ]);
  } catch (error) {
    await terminateProcessTree(application.childProcess.pid);
    await Promise.race([application.processExit, delay(5_000)]);
    throw error;
  } finally {
    await application.browser?.close().catch(() => undefined);
  }
  if (exit.code !== 0) {
    throw new Error(`Portable wrapper exited with code ${exit.code} (signal ${exit.signal}).`);
  }
}

async function terminateProcessTree(pid) {
  if (!pid) return;
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    killer.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readOnlySessionDirectory(home) {
  const sessionsRoot = path.join(home, "sessions");
  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  const sessions = entries.filter((entry) => entry.isDirectory());
  if (sessions.length !== 1) {
    throw new Error(`Expected one persisted Session, found ${sessions.length}.`);
  }
  return path.join(sessionsRoot, sessions[0].name);
}

async function createFixtureWorkspace(workspace) {
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "test"), { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    // Run tests in the existing sandboxed Node process; the fixture needs no child test workers.
    '{"type":"module","scripts":{"test":"node --test --test-isolation=none"}}\n',
    "utf8",
  );
  await writeFile(
    path.join(workspace, "src", "math.js"),
    "export function add(a, b) { return a - b; }\n",
    "utf8",
  );
  await writeFile(
    path.join(workspace, "test", "math.test.js"),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.js';\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
    "utf8",
  );
}

async function readEvents(sessionDirectory) {
  const contents = await readFile(path.join(sessionDirectory, "events.jsonl"), "utf8");
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeReport({ status, error }) {
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        executable: path.basename(executablePath),
        executableSha256,
        assertions,
        commandResults,
        status,
        ...(error ? { error } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
