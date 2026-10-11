import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  realpath,
  stat,
  copyFile,
  rm,
  lstat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  loadDataset,
  listSavedProfiles,
  runCase,
  savedModel,
  summarize,
  compareAgents,
  reevaluateProcess,
  verifyIntegrity,
  admissionReport,
  type RunRecord,
  datasetAgentCatalog,
  readAgentInstallation,
  savedAgentEndpoint,
  configuredClaudeEndpoints,
  isDatasetAgent,
} from "@dreamcode/evals/dataset";
import type { DatasetGroup, DatasetJob, DatasetRun } from "./dataset-types";
import { groupStore } from "./dataset-groups";
import { catalogTask } from "./dataset-catalog";
import { localizeProcess, type ProcessTranslation } from "./process-localization";

export function publicRun(record: RunRecord, key: string): DatasetRun {
  const {
    evidence: _evidence,
    version: _version,
    processJudgePolicy: _policy,
    execution: _execution,
    ...result
  } = record;
  return { ...result, key };
}
export function validateLaunch(
  body: Record<string, unknown>,
  groups: DatasetGroup[],
  models: string[],
  availableCaseIds = groups.flatMap((group) => group.caseIds),
  agentModels = models,
) {
  const group = groups.find((group) => group.id === body.groupId);
  if (body.caseIds !== undefined && body.groupId !== undefined)
    throw Error("请选择评测组或直接选题，不能同时指定");
  if (body.caseIds === undefined && !group) throw Error("请选择已有测评组或从数据集选题");
  const selected = body.caseIds ?? group?.caseIds;
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.some((id) => typeof id !== "string" || !availableCaseIds.includes(id)) ||
    new Set(selected).size !== selected.length
  )
    throw Error("请选择有效且不重复的题目");
  const caseIds = [...selected] as string[],
    repeats = body.repeats ?? 1;
  const model = body.model,
    judgeModel = body.judgeModel ?? model;
  const agent = body.agent ?? "dreamcode";
  if (!isDatasetAgent(agent)) throw Error("请选择支持的 Agent 框架");
  if (!Number.isSafeInteger(repeats) || Number(repeats) < 1 || Number(repeats) > 10)
    throw Error("重复次数须为 1–10");
  if (
    typeof model !== "string" ||
    typeof judgeModel !== "string" ||
    !agentModels.includes(model) ||
    !models.includes(judgeModel)
  )
    throw Error("请选择已配置且认证唯一的 Agent 与 Judge 模型");
  return {
    caseIds,
    ...(group ? { group: { id: group.id, name: group.name } } : {}),
    repeats: Number(repeats),
    model,
    judgeModel,
    agent,
  };
}
export function createDatasetPlatform(options: {
  repoRoot: string;
  runsRoot: string;
  port?: number;
  load?: typeof loadDataset;
  execute?: typeof runCase;
  provider?: typeof savedModel;
  integrity?: typeof verifyIntegrity;
  admission?: typeof admissionReport;
  profiles?: typeof listSavedProfiles;
  agents?: typeof datasetAgentCatalog;
  installation?: typeof readAgentInstallation;
  endpoint?: typeof savedAgentEndpoint;
  claudeEndpoints?: typeof configuredClaudeEndpoints;
  localize?: typeof localizeProcess;
}) {
  const root = path.join(options.repoRoot, "evals/dataset"),
    runs = path.join(options.runsRoot, "dataset"),
    jobsDir = path.join(runs, "web-jobs");
  const jobs = new Map<string, DatasetJob>();
  const groups = groupStore(options.repoRoot, runs);
  let queue = Promise.resolve();
  const translations = new Map<string, Promise<ProcessTranslation>>();
  const load = options.load ?? loadDataset,
    execute = options.execute ?? runCase,
    provider = options.provider ?? savedModel;
  const dataset = () => load(root);
  const models = async () => {
    const profiles = await (options.profiles ?? listSavedProfiles)();
    return [...new Set(profiles.map((item) => item.model))].filter(
      (model) => profiles.filter((item) => item.model === model).length === 1,
    );
  };
  const agents = async () => {
    const choices = await models();
    const catalog = await (options.agents ?? datasetAgentCatalog)(options.repoRoot);
    const claude = catalog.some((agent) => agent.id === "claude-code")
      ? await (options.claudeEndpoints ?? configuredClaudeEndpoints)()
      : [];
    return Promise.all(
      catalog.map(async (agent) => ({
        ...agent,
        models:
          agent.id === "dreamcode"
            ? choices
            : (
                await Promise.all(
                  [
                    ...new Set([
                      ...(agent.id === "claude-code" ? claude.map((entry) => entry.model) : []),
                      ...choices,
                    ]),
                  ].map(async (model) => {
                    try {
                      if (
                        agent.id === "claude-code" &&
                        claude.some((entry) => entry.model === model)
                      )
                        return model;
                      await (options.endpoint ?? savedAgentEndpoint)(model, agent.id);
                      return model;
                    } catch {
                      return null;
                    }
                  }),
                )
              ).filter((model): model is string => model !== null),
      })),
    );
  };
  let saving = Promise.resolve();
  const save = async (job: DatasetJob) => {
    const value = JSON.stringify(job, null, 2);
    const pending = saving.then(async () => {
      await mkdir(jobsDir, { recursive: true });
      const file = path.join(jobsDir, `${job.id}.json`),
        temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, value);
      await rename(temporary, file);
    });
    saving = pending.catch(() => undefined);
    await pending;
  };
  const restore = async () => {
    await mkdir(runs, { recursive: true });
    for (const file of await readdir(jobsDir).catch(() => [] as string[])) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const job = await readFile(path.join(jobsDir, file), "utf8")
        .then((text) => JSON.parse(text) as DatasetJob)
        .catch(() => null);
      if (!job || !Array.isArray(job.records) || !Array.isArray(job.errors)) continue;
      if (`${job.id}.json` !== file || !Array.isArray(job.caseIds)) continue;
      if (["running", "queued"].includes(job.status)) {
        job.status = "interrupted";
        job.currentCase = undefined;
        job.currentRepetition = undefined;
        job.currentCaseStartedAt = undefined;
        job.progress = undefined;
        job.finishedAt = new Date().toISOString();
        job.errors.push({
          caseId: "batch",
          repetition: 0,
          reason: "平台重启，未自动继续调用模型；已有执行记录保留",
        });
        await save(job);
      }
      jobs.set(job.id, job);
    }
  };
  const initialized = restore();
  // Resolve and check each owned directory before recursively removing artifacts.
  const deletionPath = async (directory: string) => {
    const base = await realpath(runs);
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${path.resolve(runs)}${path.sep}`)) throw Error("删除路径越界");
    const info = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return undefined;
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("无效记录目录");
    const actual = await realpath(resolved);
    if (!actual.startsWith(`${base}${path.sep}`)) throw Error("删除路径越界");
    return actual;
  };
  const keyFor = (file: string) => Buffer.from(path.relative(runs, file)).toString("base64url");
  const recordFile = async (key: string) => {
    const file = path.resolve(runs, Buffer.from(key, "base64url").toString("utf8"));
    if (!file.startsWith(`${runs}${path.sep}`) || path.basename(file) !== "record.json")
      throw Error("无效执行记录");
    const actual = await realpath(file),
      base = await realpath(runs);
    if (!actual.startsWith(`${base}${path.sep}`)) throw Error("执行记录越界");
    return actual;
  };
  const record = async (key: string) => {
    const value = JSON.parse(await readFile(await recordFile(key), "utf8")) as RunRecord;
    if (
      value.version !== 1 ||
      !value.id ||
      !Array.isArray(value.evidence) ||
      !value.acceptance ||
      !value.engineering
    )
      throw Error("不是新版执行记录");
    return value;
  };
  const list = async () => {
    const files: string[] = [];
    async function walk(directory: string, depth: number) {
      if (depth > 4) return;
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile() && entry.name === "record.json")
          files.push(path.join(directory, entry.name));
        else if (
          entry.isDirectory() &&
          !["workspace", "artifacts", "runtime", "agent-home", "web-jobs", ".git"].includes(
            entry.name,
          )
        )
          await walk(path.join(directory, entry.name), depth + 1);
      }
    }
    await walk(runs, 0);
    const values = await Promise.all(
      files.map(async (file) => {
        try {
          const key = keyFor(file);
          return publicRun(await record(key), key);
        } catch {
          return null;
        }
      }),
    );
    return values
      .filter((value): value is DatasetRun => !!value)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  };
  const runJob = async (job: DatasetJob) => {
    const records: RunRecord[] = [];
    job.startedAt = new Date().toISOString();
    job.status = "running";
    job.attempts = [];
    await save(job);
    try {
      const data = await dataset(),
        integrity = await (options.integrity ?? verifyIntegrity)(root);
      if (integrity.digest !== job.datasetDigest || data.version !== job.datasetVersion)
        throw Error("排队期间数据集已变化，请重新发起评测");
      const judgeProvider = await provider(job.judgeModel);
      const external =
        job.agent && job.agent !== "dreamcode"
          ? {
              agent: job.agent,
              installation: await (options.installation ?? readAgentInstallation)(options.repoRoot),
              endpoint: await (options.endpoint ?? savedAgentEndpoint)(job.model, job.agent),
            }
          : undefined;
      const agentProvider = external
        ? {
            name: external.endpoint.provider,
            async *stream(): AsyncGenerator<never> {
              throw Error("外部框架模型须通过隔离桥接调用");
            },
          }
        : await provider(job.model);
      // Freeze the worker once per batch; rebuilding the project must not change later case executions.
      let worker = path.join(options.repoRoot, "packages/evals/dist-dataset-container/worker.mjs");
      if (!options.execute) {
        const runtime = path.join(runs, `web-${job.id}`, "batch-runtime");
        await mkdir(runtime, { recursive: true });
        await copyFile(worker, path.join(runtime, "worker.mjs"));
        await copyFile(
          path.join(path.dirname(worker), "dsh-driver.mjs"),
          path.join(runtime, "dsh-driver.mjs"),
        );
        worker = path.join(runtime, "worker.mjs");
        job.workerSha256 = createHash("sha256")
          .update(await readFile(worker))
          .digest("hex");
        if (external) {
          job.agentVersion = external.installation.agents[external.agent].version;
          job.agentInstallationDigest = external.installation.lockDigest;
        }
        await save(job);
      }
      const budget = JSON.parse(await readFile(path.join(root, "execution.json"), "utf8"));
      const metadata = Object.fromEntries(
        data.cases.map((entry) => [entry.value.id, entry.value.metadata ?? {}]),
      );
      job.status = "running";
      await save(job);
      for (const caseId of job.caseIds)
        for (let repetition = 1; repetition <= job.repeats; repetition++) {
          job.currentCase = caseId;
          job.currentRepetition = repetition;
          job.currentCaseStartedAt = new Date().toISOString();
          job.progress = {
            phase: "preparing",
            modelRequests: 0,
            toolsStarted: 0,
            toolsCompleted: 0,
            inputTokens: 0,
            outputTokens: 0,
          };
          await save(job);
          let lastProgressSave = 0;
          try {
            const result = await execute(data.cases.find((entry) => entry.value.id === caseId)!, {
              directory: path.join(runs, `web-${job.id}`),
              worker,
              provider: agentProvider,
              model: job.model,
              judge: { provider: judgeProvider, model: job.judgeModel },
              dataset: { version: data.version, digest: integrity.digest },
              ...budget,
              external,
              onPhase: async (phase) => {
                if (job.progress) job.progress.phase = phase;
                await save(job);
              },
              onProgress: (event) => {
                if (!job.progress) return;
                job.progress.lastEventAt = event.timestamp;
                if (event.type === "model.started") job.progress.modelRequests++;
                if (event.type === "tool.started") job.progress.toolsStarted++;
                if (event.type === "tool.completed") job.progress.toolsCompleted++;
                if (event.type === "model.usage") {
                  const usage = (
                    event.payload as { usage?: { inputTokens?: number; outputTokens?: number } }
                  ).usage;
                  job.progress.inputTokens += usage?.inputTokens ?? 0;
                  job.progress.outputTokens += usage?.outputTokens ?? 0;
                }
                if (Date.now() - lastProgressSave > 1000) {
                  lastProgressSave = Date.now();
                  void save(job).catch(() => undefined);
                }
              },
            });
            records.push(result.record);
            const key = keyFor(path.join(result.directory, "record.json"));
            job.records.push(key);
            job.attempts.push({ caseId, repetition, key });
          } catch (error) {
            job.errors.push({ caseId, repetition, reason: String(error) });
            job.attempts.push({ caseId, repetition, error: String(error) });
          }
          job.completed++;
          job.currentCase = undefined;
          job.currentRepetition = undefined;
          job.currentCaseStartedAt = undefined;
          job.summary = summarize(records, job.caseIds, metadata, job.repeats);
          await save(job);
        }
      job.status = job.errors.length ? "error" : "completed";
    } catch (error) {
      job.status = "error";
      job.errors.push({ caseId: "batch", repetition: 0, reason: String(error) });
    } finally {
      job.currentCase = undefined;
      job.currentRepetition = undefined;
      job.currentCaseStartedAt = undefined;
      job.progress = undefined;
      job.finishedAt = new Date().toISOString();
      await save(job);
    }
  };
  const json = (res: ServerResponse, code: number, data: unknown) => {
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith("/api/dataset/")) return false;
    try {
      await initialized;
      let body: Record<string, unknown> = {};
      if (req.method === "POST" || req.method === "DELETE") {
        const allowedHosts = [
          `127.0.0.1:${options.port ?? 4178}`,
          `localhost:${options.port ?? 4178}`,
        ];
        if (
          !allowedHosts.includes(req.headers.host ?? "") ||
          (req.headers.origin &&
            !allowedHosts.map((host) => `http://${host}`).includes(req.headers.origin))
        ) {
          json(res, 403, { error: "不允许跨来源请求" });
          return true;
        }
        let text = "";
        for await (const chunk of req) {
          text += chunk.toString();
          if (Buffer.byteLength(text) > 1000000) throw Error("请求过大");
        }
        body = JSON.parse(text || "{}");
      }
      if (req.method === "GET" && url.pathname === "/api/dataset/config") {
        const data = await dataset(),
          admission = await (options.admission ?? admissionReport)(root, data.cases);
        json(res, 200, {
          version: data.version,
          cases: data.cases.length,
          models: await models(),
          agents: await agents(),
          ready: admission.ready,
          budget: JSON.parse(await readFile(path.join(root, "execution.json"), "utf8")),
        });
      } else if (req.method === "GET" && url.pathname === "/api/dataset/groups") {
        json(res, 200, await groups.list((await dataset()).cases.map((entry) => entry.value.id)));
      } else if (
        req.method === "POST" &&
        /^\/api\/dataset\/groups(?:\/[\w-]+)?$/.test(url.pathname)
      ) {
        const id = url.pathname.slice("/api/dataset/groups/".length) || undefined;
        json(
          res,
          id ? 200 : 201,
          await groups.save(
            body,
            (await dataset()).cases.map((entry) => entry.value.id),
            id,
          ),
        );
      } else if (req.method === "DELETE" && url.pathname.startsWith("/api/dataset/groups/")) {
        await groups.remove(url.pathname.slice("/api/dataset/groups/".length));
        json(res, 200, { deleted: true });
      } else if (req.method === "GET" && url.pathname === "/api/dataset/tasks") {
        json(res, 200, (await dataset()).cases.map(catalogTask));
      } else if (req.method === "GET" && url.pathname === "/api/dataset/jobs") {
        const data = await dataset();
        const metadata = Object.fromEntries(
          data.cases.map((entry) => [entry.value.id, entry.value.metadata ?? {}]),
        );
        const refreshed = await Promise.all(
          [...jobs.values()].map(async (job) => {
            try {
              const records = await Promise.all(job.records.map((key) => record(key)));
              return { ...job, summary: summarize(records, job.caseIds, metadata, job.repeats) };
            } catch {
              // Missing or corrupt evidence must not leave a stale, apparently complete score.
              return { ...job, summary: undefined };
            }
          }),
        );
        json(
          res,
          200,
          refreshed.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        );
      } else if (
        req.method === "DELETE" &&
        /^\/api\/dataset\/jobs\/[0-9a-f-]{36}$/.test(url.pathname)
      ) {
        const id = url.pathname.slice("/api/dataset/jobs/".length);
        const job = jobs.get(id);
        if (!job) throw Error("评测记录不存在");
        if (["running", "queued"].includes(job.status)) throw Error("运行中或排队中的评测不能删除");
        const owned = path.join(runs, `web-${id}`);
        // Do not remove evidence referenced by another batch or outside this batch.
        for (const key of job.records) {
          if ([...jobs.values()].some((other) => other.id !== id && other.records.includes(key)))
            throw Error("执行记录仍被其他批次使用");
          const file = path.resolve(runs, Buffer.from(key, "base64url").toString("utf8"));
          if (!file.startsWith(`${owned}${path.sep}`)) throw Error("批次包含非所属目录的记录");
        }
        await saving;
        const directory = await deletionPath(owned);
        if (directory) await rm(directory, { recursive: true, force: true });
        await rm(path.join(jobsDir, `${id}.json`), { force: true });
        jobs.delete(id);
        json(res, 200, { deleted: id });
      } else if (req.method === "DELETE" && url.pathname.startsWith("/api/dataset/runs/")) {
        const key = url.pathname.slice("/api/dataset/runs/".length);
        if ([...jobs.values()].some((job) => job.records.includes(key)))
          throw Error("请删除所属评测批次以清理该记录");
        const directory = path.dirname(await recordFile(key));
        if (!/^CASE-\d+-[0-9a-f-]{36}$/.test(path.basename(directory)))
          throw Error("仅支持删除独立执行工作区");
        const relative = path.relative(runs, directory).split(path.sep);
        if (relative.some((part) => [...jobs.values()].some((job) => part === `web-${job.id}`)))
          throw Error("该工作区属于现有评测批次");
        const target = await deletionPath(directory);
        if (target) await rm(target, { recursive: true, force: true });
        json(res, 200, { deleted: key });
      } else if (req.method === "GET" && url.pathname === "/api/dataset/runs")
        json(res, 200, await list());
      else if (req.method === "GET" && url.pathname.startsWith("/api/dataset/runs/"))
        json(res, 200, await record(url.pathname.slice("/api/dataset/runs/".length)));
      else if (req.method === "GET" && url.pathname === "/api/dataset/reviews") {
        const original = await record(url.searchParams.get("key") ?? "");
        const digest = createHash("sha256").update(JSON.stringify(original.evidence)).digest("hex");
        const values = [];
        for (const name of await readdir(runs).catch(() => [])) {
          if (!/^process-[\w-]+\.json$/.test(name)) continue;
          const value = await readFile(path.join(runs, name), "utf8")
            .then(JSON.parse)
            .catch(() => null);
          if (
            value?.kind !== "process-reevaluation" ||
            value.sourceRunId !== original.id ||
            value.evidenceDigest !== digest
          )
            continue;
          const { transcript: _transcript, ...summary } = value;
          values.push(summary);
        }
        values.sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
        json(res, 200, values);
      } else if (req.method === "POST" && url.pathname === "/api/dataset/jobs") {
        const data = await dataset(),
          catalog = await agents(),
          launch = validateLaunch(
            body,
            await groups.list(data.cases.map((entry) => entry.value.id)),
            await models(),
            data.cases.map((entry) => entry.value.id),
            catalog.find((agent) => agent.id === (body.agent ?? "dreamcode"))?.models ?? [],
          );
        if (!(await (options.admission ?? admissionReport)(root, data.cases)).ready)
          throw Error("数据集入库检查未通过");
        const selectedAgent = catalog.find((agent) => agent.id === launch.agent);
        if (!selectedAgent?.available || !selectedAgent.models.includes(launch.model))
          throw Error("所选框架未安装，或不支持当前配置的模型端点");
        if (
          !options.execute &&
          !(
            await stat(
              path.join(options.repoRoot, "packages/evals/dist-dataset-container/worker.mjs"),
            ).catch(() => null)
          )?.isFile()
        )
          throw Error("请先构建评测运行环境");
        const integrity = await (options.integrity ?? verifyIntegrity)(root);
        if (launch.agent === "dreamcode") await provider(launch.model);
        else await (options.endpoint ?? savedAgentEndpoint)(launch.model, launch.agent);
        await provider(launch.judgeModel);
        const job: DatasetJob = {
          id: randomUUID(),
          status: "queued",
          ...launch,
          agentVersion: selectedAgent.version ?? undefined,
          createdAt: new Date().toISOString(),
          completed: 0,
          total: launch.caseIds.length * launch.repeats,
          datasetVersion: data.version,
          datasetDigest: integrity.digest,
          records: [],
          errors: [],
        };
        jobs.set(job.id, job);
        await save(job);
        queue = queue.then(() => runJob(job)).catch(() => undefined);
        json(res, 202, job);
      } else if (req.method === "POST" && url.pathname === "/api/dataset/process-translation") {
        if (
          typeof body.key !== "string" ||
          typeof body.model !== "string" ||
          !(await models()).includes(body.model)
        )
          throw Error("请选择已配置的翻译模型与执行记录");
        const source = await record(body.key);
        if (!source.process) throw Error("该记录没有过程评价");
        const digest = createHash("sha256").update(JSON.stringify(source.process)).digest("hex");
        const file = path.join(path.dirname(await recordFile(body.key)), "process.zh-CN.json");
        const cached = await readFile(file, "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null);
        if (cached?.digest === digest) json(res, 200, cached.translation);
        else {
          const id = `${body.key}:${digest}`;
          let pending = translations.get(id);
          if (!pending) {
            const model = body.model;
            pending = (async () => {
              const translation = await (options.localize ?? localizeProcess)(
                source,
                await provider(model),
                model,
              );
              // A concurrent deletion must not recreate a deleted execution directory.
              await writeFile(file, JSON.stringify({ digest, translation }));
              return translation;
            })();
            translations.set(id, pending);
            void pending.finally(() => translations.delete(id)).catch(() => undefined);
          }
          json(res, 200, await pending);
        }
      } else if (req.method === "POST" && url.pathname === "/api/dataset/compare") {
        if (!body.agents || typeof body.agents !== "object" || Array.isArray(body.agents))
          throw Error("请选择两个或以上批次");
        const groups: Record<string, RunRecord[]> = {};
        for (const [name, keys] of Object.entries(body.agents)) {
          if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string"))
            throw Error("无效记录选择");
          groups[name] = await Promise.all(keys.map((key) => record(key)));
        }
        const data = await dataset(),
          ids = body.caseIds ?? data.cases.map((entry) => entry.value.id);
        if (
          !Array.isArray(ids) ||
          ids.some((id) => !data.cases.some((entry) => entry.value.id === id))
        )
          throw Error("无效比较范围");
        const comparison = compareAgents(
          groups,
          ids,
          Object.fromEntries(
            data.cases.map((entry) => [entry.value.id, entry.value.metadata ?? {}]),
          ),
        );
        for (const [name, keys] of Object.entries(body.agents)) {
          const selectedJob = [...jobs.values()].find(
            (job) =>
              job.records.length > 0 &&
              job.records.length === (keys as string[]).length &&
              job.records.every((key) => (keys as string[]).includes(key)),
          );
          if (
            selectedJob &&
            (selectedJob.status !== "completed" ||
              selectedJob.errors.length ||
              selectedJob.caseIds.some(
                (id) =>
                  groups[name]!.filter((run) => run.caseId === id).length !== selectedJob.repeats,
              ))
          ) {
            const reason = `${name}: submitted batch or expected repetitions incomplete`;
            comparison.reasons.push(reason);
            comparison.compositeReasons.push(reason);
            comparison.comparable = false;
            comparison.compositeComparable = false;
            comparison.ranking = null;
          }
        }
        json(res, 200, comparison);
      } else if (req.method === "POST" && url.pathname === "/api/dataset/reevaluate") {
        if (
          typeof body.key !== "string" ||
          typeof body.model !== "string" ||
          !(await models()).includes(body.model)
        )
          throw Error("请选择记录和已配置 Judge");
        const original = await record(body.key),
          result = await reevaluateProcess(
            original,
            await provider(body.model),
            body.model,
            600000,
          );
        const file = path.join(runs, `process-${randomUUID()}.json`);
        await writeFile(file, JSON.stringify(result, null, 2), { flag: "wx" });
        json(res, 200, result);
      } else json(res, 404, { error: "接口不存在" });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  };
}
