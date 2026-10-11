// Real paid trials via the same platform API used by the UI. No historical score reuse.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
const base = "http://127.0.0.1:4178";
const resume = process.argv[2];
const directory = resume
  ? path.resolve(resume)
  : path.resolve(`evals/runs/dataset/comparison-balanced20-${randomUUID()}`);
await mkdir(directory, { recursive: true });
async function api(route, body) {
  const response = await fetch(base + route, {
    signal: AbortSignal.timeout(120000),
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
async function persist(name, value) {
  const file = path.join(directory, name),
    temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}
let manifest;
if (resume) manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
else {
  const [groups, config, jobs] = await Promise.all([
    api("/api/dataset/groups"),
    api("/api/dataset/config"),
    api("/api/dataset/jobs"),
  ]);
  if (jobs.some((job) => ["running", "queued"].includes(job.status)))
    throw Error("Other platform trials are active; do not overlap conditions");
  const group = groups.find((group) => group.id === "balanced-20");
  if (!group || group.caseIds.length !== 20)
    throw Error("Expected the frozen balanced 20-case group");
  const model = "mimo-v2.5-pro";
  if (
    !config.ready ||
    !["dreamcode", "claude-code"].every((id) =>
      config.agents.some(
        (agent) => agent.id === id && agent.available && agent.models.includes(model),
      ),
    )
  )
    throw Error("Calibration or framework/model admission not ready");
  manifest = {
    createdAt: new Date().toISOString(),
    group,
    groupDigest: createHash("sha256").update(JSON.stringify(group.caseIds)).digest("hex"),
    model,
    judgeModel: model,
    repeats: 1,
    budget: config.budget,
    executionOrder: ["dreamcode", "claude-code"],
    jobs: [],
  };
  await persist("manifest.json", manifest);
  for (const agent of manifest.executionOrder) {
    const job = await api("/api/dataset/jobs", {
      groupId: group.id,
      agent,
      model,
      judgeModel: model,
      repeats: 1,
    });
    if (JSON.stringify(job.caseIds) !== JSON.stringify(group.caseIds))
      throw Error("Submitted group scope differs");
    manifest.jobs.push({ agent, id: job.id });
    await persist("manifest.json", manifest);
    console.log(
      JSON.stringify({ phase: "submitted", agent, job: job.id, total: job.total, directory }),
    );
  }
}
let previous = "";
for (;;) {
  let all;
  try {
    all = await api("/api/dataset/jobs");
  } catch (error) {
    console.log(JSON.stringify({ phase: "monitor-error", error: String(error), directory }));
    await new Promise((resolve) => setTimeout(resolve, 30000));
    continue;
  }
  const jobs = manifest.jobs.map((selection) => all.find((job) => job.id === selection.id));
  if (jobs.some((job) => !job)) throw Error("Submitted batch missing from platform history");
  const complete =
    jobs.length === 2 &&
    jobs.every((job) => ["completed", "error", "interrupted"].includes(job.status));
  const progress = jobs.map((job) => ({
    agent: job.agent,
    id: job.id,
    status: job.status,
    completed: job.completed,
    total: job.total,
    currentCase: job.currentCase,
    phase: job.progress?.phase,
    modelRequests: job.progress?.modelRequests,
    toolsCompleted: job.progress?.toolsCompleted,
  }));
  const report = {
    status: complete ? "completed" : "running",
    updatedAt: new Date().toISOString(),
    manifest,
    jobs,
  };
  if (complete) {
    report.comparison = await api("/api/dataset/compare", {
      caseIds: manifest.group.caseIds,
      agents: Object.fromEntries(jobs.map((job) => [job.agent, job.records])),
    });
  }
  await persist("report.json", report);
  const next = JSON.stringify(progress);
  if (next !== previous) {
    console.log(next);
    previous = next;
  }
  if (complete) {
    const number = (value) => (value == null ? "不可计算" : value.toFixed(2));
    const lines = [
      "# DreamEval 20 题框架对比",
      "",
      `测评组：${manifest.group.name}。Agent 与 Judge 模型均为 ${manifest.model}；各 20 题、每题一次，按 DreamCode → Claude Code 顺序执行。`,
      "",
      "综合分采用 composite-v1-token：正确性 70%、过程 20%、资源效率 10%；失败题计 0，缺失证据不补分。",
      "",
      "| 框架 | 已完成 | 成功率 / 验收覆盖 | 过程分 | 综合分 | Agent 分钟 | Agent Token | 批次分钟 |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
    ];
    for (const job of jobs) {
      const s = job.summary;
      const latency = s?.cases.every(c => c.runs === manifest.repeats && c.engineering.agentLatencyMs.mean != null && c.engineering.agentLatencyMs.reported === c.runs)
        ? s.cases.reduce((sum, c) => sum + c.engineering.agentLatencyMs.mean * c.runs, 0) : null;
      const input = s?.engineering.allRuns.inputTokens.total,
        output = s?.engineering.allRuns.outputTokens.total;
      const tokens = input == null || output == null ? "不可计算" : input + output;
      lines.push(
        `| ${job.agent} | ${job.completed}/${job.total} | ${s?.successRate == null ? "不可计算" : `${number(s.successRate * 100)}%`} / ${s?.coverage.acceptanceEvaluated ?? 0}/${job.caseIds.length} | ${number(s?.processScore)} | ${number(s?.compositeScore)} | ${latency == null ? "不可计算" : number(latency / 60000)} | ${tokens} | ${job.startedAt && job.finishedAt ? number((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 60000) : "不可计算"} |`,
      );
    }
    lines.push(
      "",
      report.comparison.compositeComparable
        ? `综合分排序：${report.comparison.ranking.map((item) => `${item.agent} ${number(item.score)}`).join("；")}。`
        : `综合分不能正式排名：${report.comparison.compositeReasons.join("；")}。`,
      "",
      "单次运行用于初步比较，尚不能证明重复运行的稳定性。两框架使用原生工具和系统提示，测量的是完整框架配置。成本按 Agent 输入与输出 Token 总量计，缓存输入已经包含；Judge 开销单独保留。",
      "",
      "完整记录与逐题统计见同目录 report.json；原始记录由平台保存，本脚本不修改原成绩。",
      "",
    );
    lines.push("| 题目 | DreamCode 成功率 | Claude Code 成功率 | DreamCode 综合分 | Claude Code 综合分 |", "|---|---:|---:|---:|---:|");
    for (const id of manifest.group.caseIds) {
      const a = report.comparison.agents.dreamcode.cases.find(c => c.id === id);
      const b = report.comparison.agents["claude-code"].cases.find(c => c.id === id);
      lines.push(`| ${id} | ${a?.successRate == null ? "不可计算" : `${number(a.successRate * 100)}%`} | ${b?.successRate == null ? "不可计算" : `${number(b.successRate * 100)}%`} | ${number(a?.compositeScore)} | ${number(b?.compositeScore)} |`);
    }
    lines.push("", "失败题总分为 0；成功题为 70 + 0.2×过程分 + 0.1×资源分。表内过程分是独立指标，包含失败轨迹，因此不能把该均值直接加到组成功率上重算综合分。Token 或耗时记录不完整时总量显示不可计算，不用已报告小计或子集均值外推。", "");
    await writeFile(path.join(directory, "comparison.md"), lines.join("\n"));
    console.log(
      JSON.stringify({
        phase: "completed",
        directory,
        comparable: report.comparison.compositeComparable,
        ranking: report.comparison.ranking,
        reasons: report.comparison.compositeReasons,
      }),
    );
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 30000));
}
