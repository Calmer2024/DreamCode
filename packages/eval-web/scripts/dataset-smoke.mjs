// Actual server/browser integration; copied historical evidence, zero paid model calls.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { summarize } from "../../evals/dist/dataset/index.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(root, "packages/evals/package.json"));
const { chromium } = require("@playwright/test");
const output = await mkdtemp(path.join(tmpdir(), "dreameval-dataset-web-"));
const trials = JSON.parse(
  await readFile(path.join(root, "evals/dataset/preparation/trials.json"), "utf8"),
);
const records = [],
  keys = [];
for (const trial of trials.trials.filter((item) => item.datasetVersion === "1.0.1")) {
  const source = path.join(root, trial.record),
    record = JSON.parse(await readFile(source, "utf8"));
  const relative = path.join(`${record.caseId}-${record.id}`, "record.json");
  await mkdir(path.join(output, "dataset", path.dirname(relative)), { recursive: true });
  await copyFile(source, path.join(output, "dataset", relative));
  records.push(record);
  keys.push(Buffer.from(relative).toString("base64url"));
}
assert.equal(records.length, 2);
const job = {
  id: randomUUID(),
  status: "completed",
  caseIds: records.map((record) => record.caseId),
  model: "mimo-v2.5-pro",
  judgeModel: "mimo-v2.5-pro",
  repeats: 1,
  createdAt: new Date().toISOString(),
  completed: 2,
  total: 2,
  datasetVersion: "1.0.1",
  datasetDigest: records[0].configuration.datasetDigest,
  records: keys,
  errors: [],
  summary: summarize(
    records,
    records.map((record) => record.caseId),
    { "CASE-013": { scenario: "feature" }, "CASE-055": { scenario: "review" } },
  ),
};
await mkdir(path.join(output, "dataset/web-jobs"), { recursive: true });
await writeFile(path.join(output, "dataset/web-jobs", `${job.id}.json`), JSON.stringify(job));
const port = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const child = spawn(process.execPath, ["packages/eval-web/dist-server/server.js"], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, DREAMCODE_EVAL_WEB_PORT: String(port), DREAMCODE_EVAL_RUNS_ROOT: output },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk));
child.stderr.on("data", (chunk) => (logs += chunk));
const base = `http://127.0.0.1:${port}`,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
try {
  for (let index = 0; index < 150; index++) {
    if (
      await fetch(`${base}/api/dataset/tasks`)
        .then((response) => response.ok)
        .catch(() => false)
    )
      break;
    await sleep(100);
    if (index === 149) throw Error(logs);
  }
  const tasks = await fetch(`${base}/api/dataset/tasks`).then((response) => response.json());
  assert.equal(tasks.length, 60);
  assert.equal(new Set(tasks.map((task) => task.metadata.scenario)).size, 10);
  assert(
    tasks.every((task) => task.instructionTranslated && /[\u4e00-\u9fff]/.test(task.instruction)),
  );
  assert(
    tasks.every(
      (task) =>
        task.case.environment &&
        task.case.acceptance &&
        task.acceptanceConfig.criteria &&
        task.runtimeConfig.image,
    ),
  );
  const config = await fetch(`${base}/api/dataset/config`).then((response) => response.json());
  assert.equal(config.version, "1.0.1");
  assert.equal(config.ready, true);
  assert(!JSON.stringify(config).includes("apiKey"));
  const scoredJobs = await fetch(`${base}/api/dataset/jobs`).then((response) => response.json());
  assert.equal(scoredJobs[0].summary.scoringPolicy.version, "composite-v1-token");
  assert.equal(scoredJobs[0].summary.scoringPolicy.tokenBaseline, 100000);
  assert.equal(
    scoredJobs[0].summary.compositeScore,
    summarize(records, job.caseIds, undefined, 1).compositeScore,
  );
  for (const route of ["/legacy", "/api/v2/tasks", "/api/config", "/api/tasks"]) {
    assert.equal((await fetch(`${base}${route}`)).status, 404, route);
  }
  const invalid = await fetch(`${base}/api/dataset/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseIds: ["UNKNOWN"], model: "mimo-v2.5-pro" }),
  });
  assert.equal(invalid.status, 400);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(base);
  await page.getByText("任务成功率", { exact: true }).first().waitFor();
  await page.getByText("综合分", { exact: true }).first().waitFor();
  await page
    .getByText(/评分 composite-v1-token/)
    .first()
    .waitFor();
  await page.getByText("数据集 1.0.1", { exact: true }).waitFor();
  await page.getByText("50.0%", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(output, "overview.png"), fullPage: true });
  await page.getByRole("button", { name: "测评集", exact: true }).click();
  await page.getByRole("heading", { name: /CASE-060/ }).waitFor();
  await page.getByRole("heading", { name: "数据集组成", exact: true }).waitFor();
  const composition = page.getByRole("region", { name: "数据集组成总览" });
  assert.match(await composition.locator(".composition-totals").innerText(), /60/);
  await composition
    .getByRole("img", { name: /程序验收 49 题.*Judge 验收 10 题.*联合验收 1 题/ })
    .waitFor();
  await composition.getByRole("button", { name: "筛选缺陷修复，12 道题", exact: true }).click();
  await page.getByText("12 / 60 道题", { exact: true }).waitFor();
  await composition.getByRole("button", { name: "筛选缺陷修复，12 道题", exact: true }).click();
  await page.getByText("60 / 60 道题", { exact: true }).waitFor();
  await composition.getByRole("button", { name: "筛选httpx，20 道题", exact: true }).click();
  await page.getByText("20 / 60 道题", { exact: true }).waitFor();
  await composition.getByRole("button", { name: "筛选httpx，20 道题", exact: true }).click();
  await page.getByText("60 / 60 道题", { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, "composition.png") });
  await page.getByRole("textbox", { name: "搜索题目" }).fill("CASE-013");
  await page.getByText("1 / 60 道题", { exact: true }).waitFor();
  const card = page
    .locator("article.panel")
    .filter({ has: page.getByRole("heading", { name: "CASE-013", exact: true }) });
  await card.getByRole("heading", { name: "初始环境 environment", exact: true }).waitFor();
  await card.getByRole("heading", { name: "验收标准 acceptance", exact: true }).waitFor();
  await card.getByRole("heading", { name: "修改约束 constraints", exact: true }).waitFor();
  assert.match(await card.locator(".case-instruction").innerText(), /增加可选 Zstandard/);
  assert.equal(await card.locator(".metadata-tag").count(), 2);
  await card.locator(".case-json").filter({ hasText: "完整 case JSON" }).locator("summary").click();
  const original = JSON.parse(
    await card
      .locator(".case-json")
      .filter({ hasText: "完整 case JSON" })
      .locator("pre")
      .innerText(),
  );
  assert.deepEqual(original, tasks.find((task) => task.id === "CASE-013").case);
  await card.locator(".case-json").filter({ hasText: "完整 case JSON" }).locator("summary").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, "dataset.png"), fullPage: true });
  assert.equal(await page.locator("nav button svg").count(), 4);
  assert.equal(await page.locator("input[type=number], select").count(), 0);
  await page.getByRole("combobox", { name: "筛选场景" }).click();
  await page.getByRole("option", { name: "功能开发", exact: true }).click();
  await page.getByText("1 / 60 道题", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "评测此题", exact: true }).count(), 0);
  await page.locator("[data-new-eval-trigger]").click();
  await page.getByText("60 题 × 1 次", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("checkbox").count(), 0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "测评组", exact: true }).click();
  await page.getByRole("heading", { name: "测评组 · 2", exact: true }).waitFor();
  await page.getByRole("button", { name: "新建测评组", exact: true }).click();
  await page.getByRole("textbox", { name: "测评组名称", exact: true }).fill("浏览器验证组");
  await page.getByRole("textbox", { name: "搜索组内候选题目", exact: true }).fill("CASE-013");
  await page.getByRole("checkbox", { name: "选择 CASE-013", exact: true }).check();
  await page.getByRole("button", { name: "保存测评组", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const savedGroup = (
    await fetch(`${base}/api/dataset/groups`).then((response) => response.json())
  ).find((group) => group.name === "浏览器验证组");
  assert.deepEqual(savedGroup.caseIds, ["CASE-013"]);
  await page
    .getByRole("heading", { name: "浏览器验证组", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "使用此组评测", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("combobox", { name: "Agent 框架" }).click();
  for (const name of ["Claude Code", "Pi", "DeepSeek Harness", "OpenCode"])
    assert.equal(await page.getByRole("option", { name: new RegExp(name) }).count(), 1);
  await page.getByRole("option", { name: /Claude Code/ }).click();
  assert.match(await page.getByRole("combobox", { name: "Agent 框架" }).innerText(), /Claude Code/);
  await page.getByText("1 题 × 1 次", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "每题重复次数" }).click();
  await page.getByRole("option", { name: "2 次", exact: true }).click();
  await page.getByText("1 题 × 2 次", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "每题重复次数" }).click();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.activeElement?.textContent === "1 次");
  await page.keyboard.press("Enter");
  await page.getByText("1 题 × 1 次", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("checkbox").count(), 0);
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
  );
  await page.screenshot({ path: path.join(output, "launch.png") });
  let launched;
  await page.route("**/api/dataset/jobs", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    launched = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ id: "mock-claude-launch" }),
    });
  });
  await page.getByRole("button", { name: "开始评测", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(launched.agent, "claude-code");
  assert.equal(launched.groupId, savedGroup.id);
  assert.equal(launched.caseIds, undefined);
  assert.equal(launched.model, "mimo-v2.5-pro");
  await page.unroute("**/api/dataset/jobs");
  await page.getByRole("button", { name: "评测记录", exact: true }).click();
  await page.getByRole("heading", { name: "评测批次 · 1", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^CASE-013/ }).count(), 0);
  await page.screenshot({ path: path.join(output, "batch-list.png"), fullPage: true });
  await page.getByRole("button", { name: `查看批次 ${job.id}`, exact: true }).click();
  await page.getByRole("heading", { name: "题目明细 · 2 题", exact: true }).waitFor();
  await page.getByText("50.0%", { exact: true }).first().waitFor();
  await page.locator(".batch-case").filter({ hasText: "CASE-013" }).locator("summary").click();
  await page.screenshot({ path: path.join(output, "batch-detail.png"), fullPage: true });
  await page.getByRole("button", { name: "查看 CASE-013 第 1 次执行", exact: true }).click();
  await page.getByRole("heading", { name: "验收检查", exact: true }).waitFor();
  await page.getByRole("heading", { name: "过程评价", exact: true }).waitFor();
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
  );
  await page.screenshot({ path: path.join(output, "detail.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "题目明细 · 2 题", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回批次列表", exact: true }).click();
  await page.getByRole("heading", { name: "评测批次 · 1", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "评测总览", exact: true }).click();
  await page.mouse.move(380, 130);
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
  );
  await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "测评集", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("heading", { name: "数据集组成", exact: true }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "composition-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "smoke.json"),
    JSON.stringify(
      {
        passed: true,
        tasks: 60,
        scenes: 10,
        historicalRecords: 2,
        actualAgentTrialsAdded: 0,
        paidModelCalls: 0,
        browserErrors: errors,
        checks: [
          "catalog",
          "composition counts and accessible charts",
          "chart scene/project filtering with full-dataset statistics",
          "composition mobile layout",
          "60 Chinese instructions with validated source digests",
          "environment acceptance constraints metadata tags and complete original case JSON",
          "summary",
          "batch list to overall evaluation to selected cases to execution evidence",
          "back navigation preserves parent batch",
          "persistent group creation and selection; default full group; no case selection at launch",
          "launch dialog",
          "record detail",
          "mobile layout",
          "invalid launch",
          "retired routes return 404",
          "Radix icons and repeat select",
          "scene filter and keyboard selection",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, passed: true, paidModelCalls: 0 }));
} finally {
  if (browser) await browser.close();
  child.kill();
}
