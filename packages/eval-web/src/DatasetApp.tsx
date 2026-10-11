import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  DashboardIcon,
  RowsIcon,
  ReloadIcon,
  PlusIcon,
  PlayIcon,
  MagnifyingGlassIcon,
  MixerHorizontalIcon,
  ExternalLinkIcon,
  CheckCircledIcon,
  CrossCircledIcon,
  UpdateIcon,
  ClockIcon,
  CheckIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { RunRecord, DatasetAgent } from "@dreamcode/evals/dataset";
import { scoreExecution } from "@dreamcode/evals/dataset/composite";
import { Dialog, DialogSurface, SelectField, TaskCheckbox, Skeleton } from "./controls";
import {
  batchCases,
  batchElapsed,
  caseElapsed,
  duration,
  agentLabel,
  phaseLabel,
} from "./dataset-batches";
import { DatasetComposition } from "./DatasetComposition";
import { DatasetGroups } from "./DatasetGroups";
import { DatasetHistory } from "./DatasetHistory";
import type { ProcessTranslation } from "./process-localization";
import type {
  DatasetConfig,
  DatasetJob,
  DatasetRun,
  DatasetTask,
  DatasetSummary,
  ProcessReviewSummary,
  DatasetGroup,
} from "./dataset-types";

const scenes: Record<string, string> = {
  bugfix: "缺陷修复",
  feature: "功能开发",
  refactor: "重构",
  migration: "迁移",
  integration: "集成",
  "dependency/build": "依赖与构建",
  terminal: "终端工程",
  understanding: "理解",
  review: "审查",
  research: "研究",
};
const labels: Record<string, string> = {
  passed: "通过",
  failed: "失败",
  error: "评测错误",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  interrupted: "已中断",
  graded: "已评价",
  not_applicable: "暂不适用",
  insufficient_evidence: "证据不足",
  judge_error: "Judge 错误",
};
const number = (value: number | null | undefined) =>
  value == null ? "_" : new Intl.NumberFormat("zh-CN").format(value);
const score = (value: number | null | undefined) => (value == null ? "_" : value.toFixed(1));
const percent = (value: number | null | undefined) =>
  value == null ? "_" : `${(value * 100).toFixed(1)}%`;
const minutes = duration;
const quantity = (value: number | null | undefined, unit: string) =>
  value == null ? "_" : `${number(value)} ${unit}`;
function ChineseProcess({
  record,
  recordKey,
  model,
}: {
  record: RunRecord;
  recordKey: string;
  model: string;
}) {
  const [translation, setTranslation] = useState<ProcessTranslation>();
  const [failure, setFailure] = useState("");
  const process = record.process;
  useEffect(() => {
    let active = true;
    setTranslation(undefined);
    setFailure("");
    if (!process) return;
    if (
      [process.toolAccuracy.reason, process.pathEfficiency.reason].every((text) =>
        /[\u3400-\u9fff]/.test(text),
      )
    ) {
      setTranslation({
        toolAccuracy: process.toolAccuracy.reason,
        pathEfficiency: process.pathEfficiency.reason,
      });
      return;
    }
    if (!model) {
      setFailure("尚未配置中文转换模型");
      return;
    }
    void api<ProcessTranslation>("/api/dataset/process-translation", { key: recordKey, model })
      .then((value) => active && setTranslation(value))
      .catch(() => active && setFailure("中文转换暂时失败，可展开查看原文。"));
    return () => {
      active = false;
    };
  }, [process, recordKey, model]);
  if (!process) return <p>{record.processEvaluation?.reason ?? record.processError ?? "_"}</p>;
  return (
    <>
      <div className="process-dimensions">
        {(["toolAccuracy", "pathEfficiency"] as const).map((field) => (
          <div className="detail-check" key={field}>
            <div className="detail-check-heading">
              <strong>{field === "toolAccuracy" ? "工具准确性" : "路径效率"}</strong>
              <strong>
                {number(process[field].score)}
                <small className="metric-unit">/4</small>
              </strong>
            </div>
            <p>{translation?.[field] ?? (failure || "正在转换为中文…")}</p>
            <small className="dataset-platform-muted">
              证据：{process[field].evidence.join("、") || "_"}
            </small>
          </div>
        ))}
      </div>
      <details>
        <summary>查看过程评价原文</summary>
        <p>{process.toolAccuracy.reason}</p>
        <p>{process.pathEfficiency.reason}</p>
      </details>
    </>
  );
}
async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? "请求失败");
  return value;
}
function Status({ value }: { value: string }) {
  const Icon =
    value === "passed" || value === "completed"
      ? CheckCircledIcon
      : value === "failed" || value === "error" || value === "interrupted"
        ? CrossCircledIcon
        : value === "running"
          ? UpdateIcon
          : ClockIcon;
  return (
    <span className={`status-badge status-${value}`}>
      <Icon aria-hidden="true" />
      {labels[value] ?? value}
    </span>
  );
}

function MetricValue({ text }: { text: string }) {
  return (
    <>
      {text.split(/(min|s|%|USD|Token|分|题|次)/g).map((part, index) =>
        /^(min|s|%|USD|Token|分|题|次)$/.test(part) ? (
          <small className="metric-unit" key={index}>
            {part}
          </small>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}
function rowKey(event: KeyboardEvent<HTMLTableRowElement>, open: () => void) {
  if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    open();
  }
}
function ScoringPolicy() {
  return (
    <section className="scoring-policy" aria-label="当前评分体系">
      <div className="scoring-policy-heading">
        <strong>综合评分构成</strong>
        <span>composite-v1-token</span>
      </div>
      <div className="scoring-weights">
        {[
          ["任务正确性", 70],
          ["过程质量", 20],
          ["资源效率", 10],
        ].map(([label, weight]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>
              {weight}
              <small>%</small>
            </strong>
          </div>
        ))}
      </div>
      <p>
        资源效率由 Token 60% 与延迟 40% 构成，基准为 100,000 Token / 10 min。验收失败综合分为
        0；数据缺失不补分，费用单独展示。
      </p>
    </section>
  );
}
function Summary({
  value,
  expectedRepeats,
  compact = false,
}: {
  value: DatasetSummary;
  expectedRepeats?: number;
  compact?: boolean;
}) {
  const complete =
    value.coverageComplete &&
    (expectedRepeats === undefined ||
      Object.values(value.repetitions.byCase).every((count) => count === expectedRepeats));
  return (
    <div className="dataset-platform-stack">
      <div className="metric-grid composite-metrics">
        {[
          ["综合分", value.compositeScore == null ? "_" : `${value.compositeScore.toFixed(1)} 分`],
          ["任务成功率", percent(value.successRate)],
          ["过程分", value.processScore == null ? "_" : `${value.processScore.toFixed(1)} 分`],
          [
            "资源效率分",
            value.resourceScore == null ? "_" : `${value.resourceScore.toFixed(1)} 分`,
          ],
          ["Agent 平均延迟", minutes(value.engineering.agentLatencyMs.caseMean)],
          ["执行覆盖", `${value.coverage.executed}/${value.coverage.expected} 题`],
        ].map(([label, content]) => (
          <article className="metric" key={label}>
            <span>{label}</span>
            <div className="metric-content">
              <strong>
                <MetricValue text={content ?? "_"} />
              </strong>
            </div>
          </article>
        ))}
      </div>
      <ScoringPolicy />
      <p className="dataset-platform-note">
        {complete
          ? "本批次题目评价覆盖完整；比较时仍需核对配置"
          : "评价覆盖不完整，不能作为完整排名"}{" "}
        · 通过 {value.outcomes.passed} · 失败 {value.outcomes.failed} · 验收错误{" "}
        {value.outcomes.evaluatorErrors} · 超时 {value.outcomes.timeout} · 预算耗尽{" "}
        {value.outcomes.budgetExhausted}
      </p>
      {!compact && (
        <>
          <section className="panel">
            <header className="panel-header">
              <h2>场景表现</h2>
            </header>
            <div className="dataset-platform-scroll">
              <table className="dataset-platform-table">
                <thead>
                  <tr>
                    <th>场景</th>
                    <th>成功率</th>
                    <th>综合分</th>
                    <th>过程分</th>
                    <th>执行覆盖</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(value.scenarios ?? {}).map(([scene, report]) => (
                    <tr key={scene}>
                      <td>{scenes[scene] ?? scene}</td>
                      <td>{percent(report.successRate)}</td>
                      <td>{score(report.compositeScore)}</td>
                      <td>{number(report.processScore)}</td>
                      <td>
                        {report.coverage.executed}/{report.coverage.expected}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <header className="panel-header">
              <h2>过程与工程指标</h2>
            </header>
            <div className="dataset-platform-facts">
              <span>
                成功任务过程分
                <strong>
                  <MetricValue text={quantity(value.processByOutcome.successful.caseMean, "分")} />
                </strong>
              </span>
              <span>
                失败任务过程分
                <strong>
                  <MetricValue text={quantity(value.processByOutcome.failed.caseMean, "分")} />
                </strong>
              </span>
              <span>
                输入
                <strong>
                  <MetricValue
                    text={quantity(value.engineering.allRuns.inputTokens.total, "Token")}
                  />
                </strong>
              </span>
              <span>
                输出
                <strong>
                  <MetricValue
                    text={quantity(value.engineering.allRuns.outputTokens.total, "Token")}
                  />
                </strong>
              </span>
              <span>
                实际费用
                <strong>
                  <MetricValue text={quantity(value.engineering.allRuns.costUsd.total, "USD")} />
                </strong>
              </span>
              <span>
                成功任务输入
                <strong>
                  <MetricValue
                    text={quantity(value.engineering.successfulRuns.inputTokens.total, "Token")}
                  />
                </strong>
              </span>
            </div>
            <details className="dataset-platform-details">
              <summary>覆盖、缺失原因和完整指标</summary>
              <pre>
                {JSON.stringify(
                  {
                    engineering: value.engineering,
                    missing: value.missing,
                    repetitions: value.repetitions,
                    configuration: value.configuration,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </section>
        </>
      )}
    </div>
  );
}

function CaseDetails({ task }: { task: DatasetTask }) {
  const evaluator =
    task.evaluator === "program"
      ? "确定性程序"
      : task.evaluator === "judge"
        ? "LLM Judge"
        : "程序与 Judge 联合验收";
  return (
    <div className="case-details">
      <section className="case-instruction">
        <h3>
          任务要求 <code>instruction</code>
        </h3>
        <p>{task.instruction}</p>
        {!task.instructionTranslated && (
          <p role="alert" className="dataset-platform-error">
            中文任务要求尚未与原文核对。
          </p>
        )}
      </section>
      <div className="case-detail-grid">
        <section>
          <h3>
            初始环境 <code>environment</code>
          </h3>
          <dl>
            <dt>工作区</dt>
            <dd>
              <code>{task.environment.workspace}</code>
            </dd>
            <dt>运行环境</dt>
            <dd>
              <code>{task.environment.runtime}</code>
            </dd>
            <dt>环境时限</dt>
            <dd>{minutes(task.runtimeConfig?.timeoutMs)}</dd>
            <dt>固定镜像</dt>
            <dd>
              <code className="image-digest">{task.runtimeConfig?.image ?? "未提供"}</code>
            </dd>
          </dl>
        </section>
        <section>
          <h3>
            验收标准 <code>acceptance</code>
          </h3>
          <dl>
            <dt>验收器</dt>
            <dd>{evaluator}</dd>
            <dt>配置文件</dt>
            <dd>
              <code>{task.acceptance.config}</code>
            </dd>
          </dl>
          <ul className="acceptance-criteria">
            {task.acceptanceConfig.criteria.map((criterion) => (
              <li key={criterion.id}>
                <code>{criterion.id}</code>
                <span>{criterion.description}</span>
                {criterion.method && (
                  <small>{criterion.method === "program" ? "程序检查" : "Judge 检查"}</small>
                )}
              </li>
            ))}
          </ul>
          <details>
            <summary>展开验收配置</summary>
            <pre>{JSON.stringify(task.acceptanceConfig, null, 2)}</pre>
          </details>
        </section>
      </div>
      <section className="case-constraints">
        <h3>
          修改约束 <code>constraints</code>
        </h3>
        {task.constraints ? (
          <dl>
            <dt>允许修改</dt>
            <dd>
              {task.constraints.editable.length
                ? task.constraints.editable.map((path) => (
                    <code className="scope-tag" key={path}>
                      {path}
                    </code>
                  ))
                : "只读任务，不允许修改文件"}
            </dd>
            <dt>禁止修改</dt>
            <dd>
              {task.constraints.protected?.length
                ? task.constraints.protected.map((path) => (
                    <code className="scope-tag" key={path}>
                      {path}
                    </code>
                  ))
                : "未单独指定"}
            </dd>
          </dl>
        ) : (
          <p className="dataset-platform-note">未额外限制修改范围。</p>
        )}
      </section>
      <details className="case-json">
        <summary>完整 case JSON</summary>
        <pre>{JSON.stringify(task.case, null, 2)}</pre>
      </details>
      <details className="case-json">
        <summary>原始引用文件 JSON</summary>
        <pre>
          {JSON.stringify(
            {
              instruction: task.instructionOriginal,
              runtime: task.runtimeConfig,
              acceptance: task.acceptanceConfig,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}

function BatchList({
  jobs,
  onOpen,
  onDelete,
  onDeleteMany,
  busy,
  now,
}: {
  jobs: DatasetJob[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
  busy: boolean;
  now: number;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const deletable = jobs.filter((job) => !["running", "queued"].includes(job.status));
  const selectedIds = selected.filter((id) => deletable.some((job) => job.id === id));
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h2>评测批次 · {jobs.length}</h2>
          <p>一次提交对应一个批次，点击查看整体评价与题目明细。</p>
        </div>
        <div className="table-selection-actions">
          <span>已选 {selectedIds.length} 项</span>
          <button
            type="button"
            className="icon-button danger-button"
            title="删除所选批次"
            aria-label="删除所选批次"
            disabled={busy || !selectedIds.length}
            onClick={() => onDeleteMany(selectedIds)}
          >
            <TrashIcon />
          </button>
        </div>
      </header>
      <div className="dataset-platform-scroll">
        <table className="dataset-platform-table">
          <thead>
            <tr>
              <th>
                <TaskCheckbox
                  label="选择所有可删除批次"
                  checked={!!deletable.length && selectedIds.length === deletable.length}
                  onChange={(checked) => setSelected(checked ? deletable.map((job) => job.id) : [])}
                />
              </th>
              <th>批次 / 框架 / 模型</th>
              <th>状态</th>
              <th>运行时间</th>
              <th>执行进度</th>
              <th>任务成功率</th>
              <th>综合分</th>
              <th>过程分</th>
              <th>Agent 平均延迟</th>
              <th>输入 Token</th>
              <th>实际费用 USD</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {!jobs.length && (
              <tr>
                <td colSpan={12} className="empty-cell">
                  <ArchiveIcon aria-hidden="true" />
                  暂无评测批次
                </td>
              </tr>
            )}
            {jobs.map((job) => (
              <tr
                key={job.id}
                className="clickable-row"
                tabIndex={0}
                aria-label={`查看批次 ${job.id}`}
                onClick={() => onOpen(job.id)}
                onKeyDown={(event) => rowKey(event, () => onOpen(job.id))}
              >
                <td onClick={(event) => event.stopPropagation()}>
                  <TaskCheckbox
                    label={`选择批次 ${job.id}`}
                    disabled={busy || !deletable.includes(job)}
                    checked={selectedIds.includes(job.id)}
                    onChange={(checked) =>
                      setSelected((ids) =>
                        checked ? [...ids, job.id] : ids.filter((id) => id !== job.id),
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    className="record-link"
                    aria-label={`查看批次 ${job.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(job.id);
                    }}
                  >
                    <span className="batch-link-title">
                      {agentLabel(job.agent)} · {job.model}
                      <ChevronRightIcon aria-hidden="true" />
                    </span>
                    <small className="dataset-platform-muted">
                      {new Date(job.createdAt).toLocaleString("zh-CN")} · {job.id.slice(0, 8)}
                    </small>
                    <small className="dataset-platform-muted">
                      {job.group?.name ?? "自选题目"} · {job.caseIds.length} 题 × {job.repeats} 次 ·
                      Judge {job.judgeModel}
                    </small>
                  </button>
                </td>
                <td>
                  <Status value={job.status} />
                  {job.currentCase && (
                    <small className="dataset-platform-muted">{job.currentCase}</small>
                  )}
                </td>
                <td className="time-cell">
                  {duration(batchElapsed(job, now))}
                  {job.currentCase && (
                    <small className="dataset-platform-muted">
                      本题 {duration(caseElapsed(job, now))}
                    </small>
                  )}
                </td>
                <td>
                  {job.completed}/{job.total}
                </td>
                <td>{percent(job.summary?.successRate)}</td>
                <td>{score(job.summary?.compositeScore)}</td>
                <td>{number(job.summary?.processScore)}</td>
                <td>{minutes(job.summary?.engineering.agentLatencyMs.caseMean)}</td>
                <td>{number(job.summary?.engineering.allRuns.inputTokens.total)}</td>
                <td>{number(job.summary?.engineering.allRuns.costUsd.total)}</td>
                <td>
                  <button
                    className="icon-button danger-button"
                    type="button"
                    disabled={busy || ["running", "queued"].includes(job.status)}
                    aria-label={`删除批次 ${job.id}`}
                    title="删除评测及工作区、产物"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(job.id);
                    }}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BatchDetail({
  job,
  runs,
  tasks,
  onBack,
  onOpen,
  now,
}: {
  job: DatasetJob;
  runs: DatasetRun[];
  tasks: DatasetTask[];
  onBack: () => void;
  onOpen: (key: string) => void;
  now: number;
}) {
  return (
    <div className="dataset-platform-stack">
      <div className="batch-heading">
        <button className="secondary-button" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" />
          返回批次列表
        </button>
        <Status value={job.status} />
      </div>
      <section className="panel">
        <header className="panel-header">
          <div>
            <h2>批次详情 · {job.id.slice(0, 8)}</h2>
            <p>
              评测范围：{job.group?.name ?? "自选题目"} · 已固定 {job.caseIds.length} 道题
            </p>
            <p>
              {new Date(job.createdAt).toLocaleString("zh-CN")} · {agentLabel(job.agent)} ·{" "}
              {job.model} · Judge {job.judgeModel}
            </p>
          </div>
        </header>
        <div className="dataset-platform-facts">
          <span>
            评测范围
            <strong>
              {job.caseIds.length} / {tasks.length} 题
            </strong>
          </span>
          <span>
            每题重复<strong>{job.repeats} 次</strong>
          </span>
          <span>
            执行进度
            <strong>
              {job.completed} / {job.total}
            </strong>
          </span>
          <span>
            数据集版本<strong>{job.datasetVersion}</strong>
          </span>
          <span>
            批次执行耗时<strong>{duration(batchElapsed(job, now))}</strong>
          </span>
          <span>
            当前题目<strong>{job.currentCase ?? "_"}</strong>
            {job.currentCase && <span>运行时间 {duration(caseElapsed(job, now))}</span>}
            {job.progress && (
              <span>
                {phaseLabel(job.progress.phase)} · 模型请求 {job.progress.modelRequests} · 工具{" "}
                {job.progress.toolsCompleted}/{job.progress.toolsStarted} · 已报告 Token{" "}
                {number(job.progress.inputTokens + job.progress.outputTokens)}
              </span>
            )}
          </span>
        </div>
        <p className="dataset-platform-details dataset-platform-note">
          整体评价仅覆盖本批次所选题目。批次执行耗时包含 Agent、验收与
          Judge，排队等待不计入；未记录起止时间时保持未知。
        </p>
      </section>
      {job.summary ? (
        <Summary value={job.summary} expectedRepeats={job.repeats} />
      ) : (
        <p className="dataset-platform-note">_</p>
      )}
      {!!job.errors.length && (
        <section className="panel">
          <header className="panel-header">
            <h2>批次执行错误</h2>
          </header>
          <div className="dataset-platform-details">
            {job.errors.map((error, i) => (
              <p key={i}>
                {error.caseId === "batch" ? "批次" : `${error.caseId} · 第 ${error.repetition} 次`}
                ：{error.reason}
              </p>
            ))}
          </div>
        </section>
      )}
      <section className="panel">
        <header className="panel-header">
          <div>
            <h2>题目明细 · {job.caseIds.length} 题</h2>
            <p>先查看每题多次执行的汇总，再展开单次执行证据。</p>
          </div>
        </header>
        {batchCases(job, runs).map(({ caseId, attempts, summary }) => {
          const task = tasks.find((item) => item.id === caseId);
          return (
            <details className="batch-case" key={caseId}>
              <summary>
                <div>
                  <strong>
                    {caseId} · {scenes[task?.metadata?.scenario ?? ""] ?? "未分类"} ·{" "}
                    {task?.metadata?.project ?? ""}
                  </strong>
                  <small>
                    已记录 {summary?.runs ?? attempts.filter((item) => item.run).length}/
                    {job.repeats} 次 · 成功率 {percent(summary?.successRate)} · 过程分{" "}
                    {number(summary?.processScore)} · 综合分 {score(summary?.compositeScore)}
                  </small>
                </div>
              </summary>
              <div className="batch-case-body">
                <p className="batch-instruction">
                  {task?.instruction ?? "当前目录不包含这道题的任务说明。"}
                </p>
                <div className="dataset-platform-scroll">
                  <table className="dataset-platform-table">
                    <thead>
                      <tr>
                        <th>执行</th>
                        <th>任务验收 / 状态</th>
                        <th>过程分</th>
                        <th>Agent 延迟</th>
                        <th>输入 Token</th>
                        <th>证据</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempts.map((attempt) => (
                        <tr key={attempt.repetition}>
                          <td>第 {attempt.repetition} 次</td>
                          <td>
                            {attempt.run ? (
                              <Status value={attempt.run.acceptance.status} />
                            ) : attempt.error ? (
                              <span className="attempt-error">执行错误：{attempt.error}</span>
                            ) : attempt.missingRecord ? (
                              "执行记录缺失"
                            ) : ["completed", "error", "interrupted"].includes(job.status) ? (
                              "未完成"
                            ) : job.currentCase === caseId &&
                              job.currentRepetition === attempt.repetition ? (
                              <span>运行中 · {duration(caseElapsed(job, now))}</span>
                            ) : (
                              "待完成"
                            )}
                          </td>
                          <td>{number(attempt.run?.process?.score)}</td>
                          <td>{minutes(attempt.run?.engineering.agentLatencyMs)}</td>
                          <td>{number(attempt.run?.engineering.inputTokens)}</td>
                          <td>
                            <button
                              className="secondary-button"
                              disabled={!attempt.run}
                              onClick={() => attempt.run && onOpen(attempt.run.key)}
                              aria-label={`查看 ${caseId} 第 ${attempt.repetition} 次执行`}
                            >
                              <RowsIcon aria-hidden="true" />
                              执行详情
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          );
        })}
      </section>
    </div>
  );
}

export function DatasetApp() {
  const [view, setView] = useState<"overview" | "datasets" | "runs">("overview");
  const [config, setConfig] = useState<DatasetConfig>();
  const [tasks, setTasks] = useState<DatasetTask[]>([]);
  const [jobs, setJobs] = useState<DatasetJob[]>([]);
  const [runs, setRuns] = useState<DatasetRun[]>([]);
  const [error, setError] = useState("");
  const [launch, setLaunch] = useState(false);
  const [manageGroups, setManageGroups] = useState(false);
  const [selectionMode, setSelectionMode] = useState("group");
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerScene, setPickerScene] = useState("all");
  const [now, setNow] = useState(Date.now());
  const [deletion, setDeletion] = useState<{
    kind: "jobs" | "runs";
    ids: string[];
    label: string;
  }>();
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<DatasetGroup[]>([]);
  const [groupId, setGroupId] = useState("default-60");
  const [agent, setAgent] = useState<DatasetAgent>("dreamcode");
  const [model, setModel] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [repeats, setRepeats] = useState(1);
  const [search, setSearch] = useState("");
  const [scene, setScene] = useState("all");
  const [project, setProject] = useState("all");
  const [batch, setBatch] = useState("");
  const [recordBatch, setRecordBatch] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<{
    comparable: boolean;
    reasons: string[];
    compositeComparable: boolean;
    compositeReasons: string[];
    ranking: { agent: string; score: number; rank: number }[] | null;
    agents: Record<string, DatasetSummary>;
  }>();
  const [detail, setDetail] = useState<{ key: string; record: RunRecord }>();
  const [review, setReview] = useState<ProcessReviewSummary>();
  const [reviews, setReviews] = useState<ProcessReviewSummary[]>([]);
  const [detecting, setDetecting] = useState(false);
  const refreshDetection = useCallback(async () => {
    setDetecting(true);
    try {
      setConfig(await api<DatasetConfig>("/api/dataset/config"));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setDetecting(false);
    }
  }, []);
  useEffect(() => {
    if (launch) void refreshDetection();
  }, [launch, refreshDetection]);
  const refresh = useCallback(async () => {
    try {
      const [nextJobs, nextRuns] = await Promise.all([
        api<DatasetJob[]>("/api/dataset/jobs"),
        api<DatasetRun[]>("/api/dataset/runs"),
      ]);
      setJobs(nextJobs);
      setRuns(nextRuns);
    } catch (failure) {
      setError(String(failure));
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<DatasetConfig>("/api/dataset/config"),
      api<DatasetTask[]>("/api/dataset/tasks"),
      api<DatasetGroup[]>("/api/dataset/groups"),
    ])
      .then(([value, catalog, groups]) => {
        if (!active) return;
        setConfig(value);
        setTasks(catalog);
        setGroups(groups);
        const choice = value.models.includes("mimo-v2.5-pro")
          ? "mimo-v2.5-pro"
          : (value.models[0] ?? "");
        setModel(choice);
        setJudgeModel(choice);
      })
      .catch((failure) => active && setError(String(failure)));
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  const agentChoice = config?.agents.find((choice) => choice.id === agent);
  const selectedGroup = groups.find((group) => group.id === groupId);
  const selectedIds = selectionMode === "group" ? (selectedGroup?.caseIds ?? []) : selectedCases;
  const pickerTasks = tasks.filter(
    (task) =>
      (pickerScene === "all" || task.metadata?.scenario === pickerScene) &&
      `${task.id} ${task.metadata?.project} ${scenes[task.metadata?.scenario ?? ""]} ${task.instruction}`
        .toLowerCase()
        .includes(pickerSearch.toLowerCase()),
  );
  useEffect(() => {
    if (!jobs.some((job) => job.status === "running")) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [jobs]);
  useEffect(() => {
    if (agentChoice && !agentChoice.models.includes(model)) setModel(agentChoice.models[0] ?? "");
  }, [agentChoice, model]);
  useEffect(() => {
    if (config && !config.models.includes(judgeModel)) setJudgeModel(config.models[0] ?? "");
  }, [config, judgeModel]);
  const chosen = jobs.find((item) => item.id === batch) ?? jobs.find((item) => item.summary);
  const filtered = tasks.filter(
    (item) =>
      (scene === "all" || item.metadata?.scenario === scene) &&
      (project === "all" || item.metadata?.project === project) &&
      `${item.id} ${item.instruction} ${scenes[item.metadata?.scenario ?? ""] ?? ""} ${item.metadata?.project}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const open = (key: string) =>
    void action(async () => {
      setReview(undefined);
      setReviews([]);
      const [record, history] = await Promise.all([
        api<RunRecord>(`/api/dataset/runs/${key}`),
        api<ProcessReviewSummary[]>(`/api/dataset/reviews?key=${encodeURIComponent(key)}`),
      ]);
      setDetail({ key, record });
      setReviews(history);
      setReview(history[0]);
    });
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        跳转到内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <div>
            <strong>DreamEval</strong>
            <span>Agent evaluation</span>
          </div>
        </div>
        <nav aria-label="主导航">
          {(
            [
              ["overview", "评测总览"],
              ["datasets", "测评集"],
              ["runs", "评测记录"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={() => {
                setView(id);
                if (id === "runs") setRecordBatch("");
              }}
            >
              {id === "overview" ? (
                <DashboardIcon aria-hidden="true" />
              ) : id === "datasets" ? (
                <ArchiveIcon aria-hidden="true" />
              ) : (
                <RowsIcon aria-hidden="true" />
              )}
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div>
            <strong>数据集 {config?.version ?? "加载中"}</strong>
            <span>DreamCode Agent</span>
          </div>
        </div>
      </aside>
      <main className="workspace" id="workspace">
        <header className="topbar">
          <h1>{view === "overview" ? "评测总览" : view === "datasets" ? "测评集" : "评测记录"}</h1>
          <div className="topbar-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="刷新"
              title="刷新"
              disabled={detecting}
              onClick={() => {
                void refresh();
                void refreshDetection();
              }}
            >
              <ReloadIcon aria-hidden="true" />
            </button>
            <button
              className="primary-button"
              type="button"
              data-new-eval-trigger
              disabled={!config?.ready || !config.models.length || busy}
              onClick={() => setLaunch(true)}
            >
              <PlusIcon aria-hidden="true" />
              新建评测
            </button>
          </div>
        </header>
        <div className="workspace-content" key={view}>
          {error && !launch && !detail && (
            <p role="alert" className="dataset-platform-error">
              {error}
            </p>
          )}
          {config && !config.models.length && (
            <p className="dataset-platform-note">
              尚未配置可用模型，请先在 DreamCode 中配置模型认证。
            </p>
          )}
          {config && !config.ready && (
            <p className="dataset-platform-error">数据集入库检查未通过，暂不能发起评测。</p>
          )}
          {!config && !error && <Skeleton rows={4} />}
          {config && view === "overview" && (
            <div className="dataset-platform-stack">
              <p className="dataset-platform-note">
                {config ? `${tasks.length} 道题` : "正在加载数据集"} · 多框架 Agent 评测 ·
                任务验收、过程评价、工程指标独立展示
              </p>
              {jobs.length > 0 && (
                <SelectField
                  label="选择评测批次"
                  value={chosen?.id ?? ""}
                  options={jobs.map((job) => ({
                    value: job.id,
                    label: `${agentLabel(job.agent)} · ${job.model} · ${new Date(job.createdAt).toLocaleString("zh-CN")} · ${job.completed}/${job.total}`,
                  }))}
                  onChange={setBatch}
                />
              )}
              {chosen?.summary ? (
                <Summary value={chosen.summary} expectedRepeats={chosen.repeats} />
              ) : (
                <section className="panel empty-state">
                  <MixerHorizontalIcon aria-hidden="true" />
                  <h2>开始一次评测</h2>
                  <p>选择题目和模型后，这里将展示本批次的评价结果。</p>
                  <button
                    className="primary-button"
                    disabled={!config?.ready || !config.models.length || busy}
                    onClick={() => setLaunch(true)}
                  >
                    <PlusIcon aria-hidden="true" />
                    新建评测
                  </button>
                </section>
              )}
              <section className="panel">
                <header className="panel-header">
                  <h2>评测批次</h2>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={compareIds.length < 2 || busy}
                    onClick={() =>
                      void action(async () => {
                        const selectedJobs = jobs.filter((job) => compareIds.includes(job.id));
                        setComparison(
                          await api("/api/dataset/compare", {
                            caseIds: [...new Set(selectedJobs.flatMap((job) => job.caseIds))],
                            agents: Object.fromEntries(
                              selectedJobs.map((job) => [job.id, job.records]),
                            ),
                          }),
                        );
                      })
                    }
                  >
                    <MixerHorizontalIcon aria-hidden="true" />
                    比较所选批次
                  </button>
                </header>
                <div className="dataset-platform-scroll">
                  <table className="dataset-platform-table">
                    <thead>
                      <tr>
                        <th>选择</th>
                        <th>框架 / 模型</th>
                        <th>状态</th>
                        <th>时间</th>
                        <th>进度</th>
                        <th>任务成功率</th>
                        <th>综合分</th>
                        <th>过程分</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!jobs.length && (
                        <tr>
                          <td colSpan={8} className="empty-cell">
                            <RowsIcon aria-hidden="true" />
                            <span>暂无评测批次，选择题目和模型开始评测。</span>
                          </td>
                        </tr>
                      )}
                      {jobs.map((job) => (
                        <tr
                          key={job.id}
                          className="clickable-row"
                          tabIndex={0}
                          aria-label={`查看批次 ${job.id}`}
                          onClick={() => {
                            setBatch(job.id);
                            setRecordBatch(job.id);
                            setView("runs");
                          }}
                          onKeyDown={(event) =>
                            rowKey(event, () => {
                              setBatch(job.id);
                              setRecordBatch(job.id);
                              setView("runs");
                            })
                          }
                        >
                          <td onClick={(event) => event.stopPropagation()}>
                            <TaskCheckbox
                              id={`compare-${job.id}`}
                              label={`比较批次 ${job.id}`}
                              checked={compareIds.includes(job.id)}
                              onChange={(checked) =>
                                setCompareIds((values) =>
                                  checked
                                    ? [...values, job.id]
                                    : values.filter((id) => id !== job.id),
                                )
                              }
                            />
                          </td>
                          <td>
                            <button
                              className="record-link"
                              type="button"
                              onClick={() => {
                                setBatch(job.id);
                                setRecordBatch(job.id);
                                setView("runs");
                              }}
                            >
                              {agentLabel(job.agent)} · {job.model}
                              <small className="dataset-platform-muted">
                                {job.caseIds.length} 题 × {job.repeats} 次 · Judge {job.judgeModel}
                              </small>
                            </button>
                          </td>
                          <td>
                            <Status value={job.status} />
                            {job.currentCase && (
                              <small className="dataset-platform-muted">{job.currentCase}</small>
                            )}
                          </td>
                          <td className="time-cell">
                            <span>{duration(batchElapsed(job, now))}</span>
                            {job.currentCase && (
                              <small className="dataset-platform-muted">
                                本题 {duration(caseElapsed(job, now))}
                              </small>
                            )}
                          </td>
                          <td>
                            {job.completed}/{job.total}
                          </td>
                          <td>{percent(job.summary?.successRate)}</td>
                          <td>{score(job.summary?.compositeScore)}</td>
                          <td>{number(job.summary?.processScore)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {chosen?.errors.length ? (
                  <details className="dataset-platform-details">
                    <summary>批次执行错误</summary>
                    <pre>{JSON.stringify(chosen.errors, null, 2)}</pre>
                  </details>
                ) : null}
              </section>
              {comparison && (
                <section className="panel">
                  <header className="panel-header">
                    <h2>{comparison.comparable ? "批次满足比较条件" : "批次不满足比较条件"}</h2>
                  </header>
                  {comparison.reasons.map((reason) => (
                    <p className="dataset-platform-note" key={reason}>
                      {reason}
                    </p>
                  ))}
                  <p className="dataset-platform-note">
                    {comparison.compositeComparable ? "综合分满足比较条件" : "综合分暂不能用于排名"}
                  </p>
                  {comparison.compositeReasons
                    .filter((reason) => !comparison.reasons.includes(reason))
                    .map((reason) => (
                      <p className="dataset-platform-note" key={reason}>
                        {reason}
                      </p>
                    ))}
                  {comparison.ranking && (
                    <div className="dataset-platform-scroll">
                      <table className="dataset-platform-table">
                        <thead>
                          <tr>
                            <th>排名</th>
                            <th>批次 / 模型</th>
                            <th>综合分</th>
                          </tr>
                        </thead>
                        <tbody>
                          {comparison.ranking.map((item) => (
                            <tr key={item.agent}>
                              <td>{item.rank}</td>
                              <td>
                                {jobs.find((job) => job.id === item.agent)?.model ?? item.agent} ·{" "}
                                {item.agent.slice(0, 8)}
                              </td>
                              <td>{item.score.toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="dataset-platform-details">
                    <pre>
                      {JSON.stringify(
                        Object.fromEntries(
                          Object.entries(comparison.agents).map(([id, report]) => [
                            id,
                            {
                              successRate: report.successRate,
                              processScore: report.processScore,
                              compositeScore: report.compositeScore,
                              resourceScore: report.resourceScore,
                              scoringPolicy: report.scoringPolicy,
                              coverage: report.coverage,
                            },
                          ]),
                        ),
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                </section>
              )}
            </div>
          )}
          {config && view === "datasets" && (
            <div className="dataset-platform-stack">
              <DatasetComposition
                tasks={tasks}
                version={config.version}
                sceneLabels={scenes}
                scene={scene}
                project={project}
                onScene={(value) => {
                  setScene(value);
                  setSearch("");
                }}
                onProject={(value) => {
                  setProject(value);
                  setSearch("");
                }}
              />
              <div className="catalog-toolbar">
                <div className="search-field">
                  <MagnifyingGlassIcon aria-hidden="true" />
                  <input
                    className="dataset-platform-search"
                    aria-label="搜索题目"
                    placeholder="搜索题目、场景或项目"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <SelectField
                  label="筛选场景"
                  value={scene}
                  onChange={setScene}
                  options={[
                    { value: "all", label: "全部场景" },
                    ...Object.entries(scenes).map(([value, label]) => ({ value, label })),
                  ]}
                />
                <SelectField
                  label="筛选项目"
                  value={project}
                  onChange={setProject}
                  options={[
                    { value: "all", label: "全部项目" },
                    ...[
                      ...new Set(
                        tasks
                          .map((task) => task.metadata?.project)
                          .filter((value): value is string => !!value),
                      ),
                    ].map((value) => ({ value, label: value })),
                  ]}
                />
              </div>
              <p className="dataset-platform-note">
                {filtered.length} / {tasks.length} 道题
              </p>
              {!filtered.length && (
                <div className="empty-state">
                  <MagnifyingGlassIcon aria-hidden="true" />
                  <h2>没有匹配的题目</h2>
                  <p>尝试其他关键词，或清除筛选条件。</p>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setSearch("");
                      setScene("all");
                      setProject("all");
                    }}
                  >
                    <ReloadIcon aria-hidden="true" />
                    清除筛选
                  </button>
                </div>
              )}
              {filtered.map((task) => (
                <article className="panel" key={task.id}>
                  <header className="panel-header">
                    <div>
                      <h2>{task.id}</h2>
                      <div className="metadata-tags" aria-label="题目分类">
                        {Object.entries(task.metadata ?? {}).map(([key, value]) => (
                          <span className={`metadata-tag metadata-${key}`} key={key}>
                            {key === "scenario"
                              ? (scenes[value] ?? value)
                              : key === "project"
                                ? value
                                : `${key}：${value}`}
                          </span>
                        ))}
                      </div>
                    </div>
                  </header>
                  <CaseDetails task={task} />
                </article>
              ))}
            </div>
          )}
          {config && view === "runs" && (
            <div className="dataset-platform-stack">
              {jobs.find((job) => job.id === recordBatch) ? (
                <BatchDetail
                  job={jobs.find((job) => job.id === recordBatch)!}
                  runs={runs}
                  tasks={tasks}
                  onBack={() => setRecordBatch("")}
                  onOpen={open}
                  now={now}
                />
              ) : (
                <>
                  <div className="metric-grid records-status">
                    {[
                      ["评测批次", jobs.length],
                      ["运行中", jobs.filter((job) => job.status === "running").length],
                      ["排队中", jobs.filter((job) => job.status === "queued").length],
                      ["已完成", jobs.filter((job) => job.status === "completed").length],
                    ].map(([label, count]) => (
                      <article className="metric" key={label}>
                        <span>{label}</span>
                        <div className="metric-content">
                          <strong>
                            <MetricValue text={`${count} 次`} />
                          </strong>
                        </div>
                      </article>
                    ))}
                  </div>
                  <DatasetHistory jobs={jobs} />
                  <BatchList
                    jobs={jobs}
                    onOpen={setRecordBatch}
                    busy={busy}
                    now={now}
                    onDelete={(id) =>
                      setDeletion({ kind: "jobs", ids: [id], label: `评测批次 ${id.slice(0, 8)}` })
                    }
                    onDeleteMany={(ids) =>
                      setDeletion({ kind: "jobs", ids, label: `${ids.length} 个评测批次` })
                    }
                  />
                  {runs.some((run) => !jobs.some((job) => job.records.includes(run.key))) && (
                    <details className="independent-records" open>
                      <summary>
                        未归属批次的独立执行记录 ·{" "}
                        {
                          runs.filter((run) => !jobs.some((job) => job.records.includes(run.key)))
                            .length
                        }
                      </summary>
                      <p className="dataset-platform-note">
                        这些记录来自独立试跑，没有批次范围与提交配置，不自动拼成批次或生成整体评价。
                      </p>
                      <section className="panel">
                        <header className="panel-header">
                          <h2>独立执行记录</h2>
                          <div className="table-selection-actions">
                            <span>已选 {selectedRuns.length} 项</span>
                            <button
                              type="button"
                              className="icon-button danger-button"
                              aria-label="删除所选执行记录"
                              title="删除所选执行记录"
                              disabled={busy || !selectedRuns.length}
                              onClick={() =>
                                setDeletion({
                                  kind: "runs",
                                  ids: selectedRuns,
                                  label: `${selectedRuns.length} 个独立执行记录`,
                                })
                              }
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        </header>
                        <div className="dataset-platform-scroll">
                          <table className="dataset-platform-table">
                            <thead>
                              <tr>
                                <th>
                                  <TaskCheckbox
                                    label="选择所有独立执行记录"
                                    checked={
                                      !!selectedRuns.length &&
                                      selectedRuns.length ===
                                        runs.filter(
                                          (run) =>
                                            !jobs.some((job) => job.records.includes(run.key)),
                                        ).length
                                    }
                                    onChange={(checked) =>
                                      setSelectedRuns(
                                        checked
                                          ? runs
                                              .filter(
                                                (run) =>
                                                  !jobs.some((job) =>
                                                    job.records.includes(run.key),
                                                  ),
                                              )
                                              .map((run) => run.key)
                                          : [],
                                      )
                                    }
                                  />
                                </th>
                                <th>题目 / 模型</th>
                                <th>任务验收</th>
                                <th>过程分</th>
                                <th>Agent 延迟</th>
                                <th>输入 Token</th>
                                <th>协议</th>
                                <th>操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {!runs.length && (
                                <tr>
                                  <td colSpan={6} className="empty-cell">
                                    <ArchiveIcon aria-hidden="true" />
                                    <span>暂无执行记录</span>
                                  </td>
                                </tr>
                              )}
                              {runs
                                .filter((run) => !jobs.some((job) => job.records.includes(run.key)))
                                .map((run) => (
                                  <tr
                                    key={run.key}
                                    className="clickable-row"
                                    tabIndex={0}
                                    onClick={() => open(run.key)}
                                    onKeyDown={(event) => rowKey(event, () => open(run.key))}
                                  >
                                    <td onClick={(event) => event.stopPropagation()}>
                                      <TaskCheckbox
                                        label={`选择 ${run.caseId} 执行记录 ${run.key}`}
                                        checked={selectedRuns.includes(run.key)}
                                        disabled={busy}
                                        onChange={(checked) =>
                                          setSelectedRuns((ids) =>
                                            checked
                                              ? [...ids, run.key]
                                              : ids.filter((id) => id !== run.key),
                                          )
                                        }
                                      />
                                    </td>
                                    <td>
                                      <button
                                        className="record-link"
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          open(run.key);
                                        }}
                                      >
                                        {run.caseId}
                                        <small className="dataset-platform-muted">
                                          {agentLabel(run.configuration?.agent)} ·{" "}
                                          {run.configuration?.model ?? "_"} ·{" "}
                                          {new Date(run.startedAt).toLocaleString("zh-CN")}
                                        </small>
                                      </button>
                                    </td>
                                    <td>
                                      <Status value={run.acceptance.status} />
                                    </td>
                                    <td>{number(run.process?.score)}</td>
                                    <td>{minutes(run.engineering.agentLatencyMs)}</td>
                                    <td>{number(run.engineering.inputTokens)}</td>
                                    <td>
                                      {run.configuration?.executionProtocolVersion ?? "历史协议"}
                                    </td>
                                    <td>
                                      <button
                                        type="button"
                                        className="icon-button danger-button"
                                        disabled={busy}
                                        aria-label={`删除 ${run.caseId} 执行记录`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setDeletion({
                                            kind: "runs",
                                            ids: [run.key],
                                            label: `${run.caseId} 执行记录`,
                                          });
                                        }}
                                      >
                                        <TrashIcon />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    </details>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </main>
      <Dialog.Root
        open={launch}
        onOpenChange={(open) => {
          setLaunch(open);
          if (!open) setManageGroups(false);
        }}
      >
        <DialogSurface
          title={manageGroups ? "管理评测组" : "新建评测"}
          description={
            manageGroups
              ? "创建、编辑或删除评测组，保存后返回新建评测。"
              : "选择评测组或直接从 DataSet 选题，使用固定环境与预算执行。"
          }
        >
          {manageGroups ? (
            <div className="modal-body dataset-platform-stack group-management">
              <button
                type="button"
                className="icon-button"
                aria-label="返回新建评测"
                title="返回新建评测"
                onClick={() => setManageGroups(false)}
              >
                <ArrowLeftIcon aria-hidden="true" />
              </button>
              <DatasetGroups
                groups={groups}
                tasks={tasks}
                sceneLabels={scenes}
                busy={busy}
                error={error}
                launch={(id) => {
                  setGroupId(id);
                  setSelectionMode("group");
                  setManageGroups(false);
                }}
                save={async (value, id) => {
                  let saved = false;
                  await action(async () => {
                    const group = await api<DatasetGroup>(
                      `/api/dataset/groups${id ? `/${id}` : ""}`,
                      value,
                    );
                    setGroups(await api<DatasetGroup[]>("/api/dataset/groups"));
                    setGroupId(group.id);
                    saved = true;
                  });
                  return saved;
                }}
                remove={(id) =>
                  void action(async () => {
                    const response = await fetch(`/api/dataset/groups/${id}`, { method: "DELETE" });
                    if (!response.ok) throw Error((await response.json()).error);
                    setGroups(await api<DatasetGroup[]>("/api/dataset/groups"));
                    if (groupId === id) setGroupId("default-60");
                  })
                }
              />
            </div>
          ) : (
            <>
              <div className="modal-body dataset-platform-stack">
                {error && (
                  <p role="alert" className="dataset-platform-error">
                    {error}
                  </p>
                )}
                <label>
                  <span>选题方式</span>
                  <SelectField
                    label="选题方式"
                    value={selectionMode}
                    onChange={setSelectionMode}
                    options={[
                      { value: "group", label: "选择评测组" },
                      { value: "dataset", label: "从 DataSet 挑选" },
                    ]}
                  />
                </label>
                {selectionMode === "group" ? (
                  <>
                    <div className="launch-field">
                      <div className="field-heading">
                        <label htmlFor="launch-group">测评组</label>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="管理测评组"
                          title="管理测评组"
                          onClick={() => setManageGroups(true)}
                        >
                          <MixerHorizontalIcon aria-hidden="true" />
                        </button>
                      </div>
                      <SelectField
                        id="launch-group"
                        label="评测组"
                        value={groupId}
                        onChange={setGroupId}
                        options={groups.map((group) => ({
                          value: group.id,
                          label: `${group.name} · ${group.caseIds.length} 题`,
                        }))}
                      />
                    </div>
                    <p className="dataset-platform-note">{selectedGroup?.description}</p>
                    <details className="group-members">
                      <summary>查看评测组题目 · {selectedGroup?.caseIds.length ?? 0} 题</summary>
                      <p>{selectedGroup?.caseIds.join("、")}</p>
                    </details>
                  </>
                ) : (
                  <>
                    <div className="catalog-toolbar launch-picker-toolbar">
                      <div className="search-field">
                        <MagnifyingGlassIcon />
                        <input
                          className="dataset-platform-search"
                          aria-label="搜索 DataSet 题目"
                          placeholder="搜索题目、项目、场景"
                          value={pickerSearch}
                          onChange={(event) => setPickerSearch(event.target.value)}
                        />
                      </div>
                      <SelectField
                        label="选题场景"
                        value={pickerScene}
                        onChange={setPickerScene}
                        options={[
                          { value: "all", label: "全部场景" },
                          ...Object.entries(scenes).map(([value, label]) => ({ value, label })),
                        ]}
                      />
                    </div>
                    <div className="picker-heading">
                      <span>
                        题目{" "}
                        <small>
                          已选 {selectedCases.length} / {tasks.length}
                        </small>
                      </span>
                      <div className="picker-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={
                            pickerTasks.every((task) => selectedCases.includes(task.id))
                              ? "取消选择筛选题目"
                              : "选择全部筛选题目"
                          }
                          title={
                            pickerTasks.every((task) => selectedCases.includes(task.id))
                              ? "取消选择筛选题目"
                              : "选择全部筛选题目"
                          }
                          disabled={!pickerTasks.length}
                          onClick={() =>
                            setSelectedCases((values) =>
                              pickerTasks.every((task) => values.includes(task.id))
                                ? values.filter((id) => !pickerTasks.some((task) => task.id === id))
                                : [...new Set([...values, ...pickerTasks.map((task) => task.id)])],
                            )
                          }
                        >
                          <CheckIcon aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="清空题目选择"
                          title="清空题目选择"
                          disabled={!selectedCases.length}
                          onClick={() => setSelectedCases([])}
                        >
                          <TrashIcon aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    <div className="dataset-platform-picker">
                      {pickerTasks.map((task) => (
                        <label key={task.id} htmlFor={`launch-${task.id}`}>
                          <TaskCheckbox
                            id={`launch-${task.id}`}
                            label={`选择 ${task.id}`}
                            checked={selectedCases.includes(task.id)}
                            onChange={(checked) =>
                              setSelectedCases((values) =>
                                checked
                                  ? [...new Set([...values, task.id])]
                                  : values.filter((id) => id !== task.id),
                              )
                            }
                          />
                          <span>
                            <strong>{task.id}</strong>
                            <span className="picker-task-meta">
                              {task.metadata?.project} · {scenes[task.metadata?.scenario ?? ""]}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    {!pickerTasks.length && (
                      <p className="dataset-platform-note">没有匹配的题目。</p>
                    )}
                  </>
                )}
                <div className="launch-field">
                  <div className="field-heading">
                    <label htmlFor="launch-agent">Agent 框架</label>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="刷新框架与模型"
                      title="刷新框架与模型"
                      disabled={detecting}
                      onClick={() => void refreshDetection()}
                    >
                      <ReloadIcon aria-hidden="true" />
                    </button>
                  </div>
                  <SelectField
                    id="launch-agent"
                    label="Agent 框架"
                    value={agent}
                    onChange={(value) => setAgent(value as DatasetAgent)}
                    options={(config?.agents ?? []).map((choice) => ({
                      value: choice.id,
                      label: `${choice.label}${choice.version && choice.version !== "workspace" ? ` · ${choice.version}` : ""}${!choice.available ? " · 未安装" : ""}`,
                      disabled: !choice.available || !choice.models.length,
                    }))}
                  />
                </div>
                <p className="dataset-platform-note">
                  {agentChoice?.detail}。框架使用同一题目工作区、运行环境、验收器与评分规则。
                </p>
                <label>
                  <span>Agent 模型</span>
                  <SelectField
                    label="Agent 模型"
                    value={model}
                    options={(agentChoice?.models ?? []).map((value) => ({ value, label: value }))}
                    onChange={setModel}
                  />
                </label>
                <label>
                  <span>Judge 模型</span>
                  <SelectField
                    label="Judge 模型"
                    value={judgeModel}
                    options={(config?.models ?? []).map((value) => ({ value, label: value }))}
                    onChange={setJudgeModel}
                  />
                </label>
                <label>
                  <span>每题重复次数</span>
                  <SelectField
                    label="每题重复次数"
                    value={String(repeats)}
                    onChange={(value) => setRepeats(Number(value))}
                    options={Array.from({ length: 10 }, (_, i) => ({
                      value: String(i + 1),
                      label: `${i + 1} 次`,
                    }))}
                  />
                </label>
                <p className="dataset-platform-note">
                  每次最多 {minutes(config?.budget.timeoutMs)}、{config?.budget.maxModelRequests}{" "}
                  次模型请求。将调用真实模型。
                </p>
              </div>
              <footer className="modal-footer">
                <span>
                  {selectedIds.length} 题 × {repeats} 次
                </span>
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    busy ||
                    detecting ||
                    !selectedIds.length ||
                    !model ||
                    !agentChoice?.available ||
                    !judgeModel ||
                    !Number.isInteger(repeats) ||
                    repeats < 1 ||
                    repeats > 10
                  }
                  onClick={() =>
                    void action(async () => {
                      const job = await api<DatasetJob>("/api/dataset/jobs", {
                        ...(selectionMode === "group" ? { groupId } : { caseIds: selectedIds }),
                        agent,
                        model,
                        judgeModel,
                        repeats,
                      });
                      setBatch(job.id);
                      setLaunch(false);
                      setView("overview");
                      await refresh();
                    })
                  }
                >
                  {busy ? (
                    <UpdateIcon className="spin" aria-hidden="true" />
                  ) : (
                    <PlayIcon aria-hidden="true" />
                  )}
                  {busy ? "正在提交…" : "开始评测"}
                </button>
              </footer>
            </>
          )}
        </DialogSurface>
      </Dialog.Root>
      <Dialog.Root
        open={!!deletion}
        onOpenChange={(open) => {
          if (!open && !busy) setDeletion(undefined);
        }}
      >
        <DialogSurface
          title="删除评测记录"
          description={`删除 ${deletion?.label ?? ""}，同时清理对应工作区、日志、产物及评分记录。此操作无法撤销。`}
        >
          <footer className="modal-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setDeletion(undefined)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button danger-button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (!deletion) return;
                  const remaining = [...deletion.ids];
                  try {
                    for (const id of deletion.ids) {
                      const response = await fetch(`/api/dataset/${deletion.kind}/${id}`, {
                        method: "DELETE",
                      });
                      if (!response.ok) throw Error((await response.json()).error);
                      remaining.shift();
                      if (deletion.kind === "jobs") {
                        setCompareIds((values) => values.filter((value) => value !== id));
                        if (batch === id) setBatch("");
                        if (recordBatch === id) setRecordBatch("");
                      } else setSelectedRuns((values) => values.filter((value) => value !== id));
                    }
                  } catch (failure) {
                    setDeletion({
                      ...deletion,
                      ids: remaining,
                      label: `${remaining.length} 个剩余记录`,
                    });
                    throw failure;
                  } finally {
                    await refresh();
                  }
                  setComparison(undefined);
                  setDetail(undefined);
                  setDeletion(undefined);
                  await refresh();
                })
              }
            >
              {busy ? "正在删除…" : "删除并清理空间"}
            </button>
          </footer>
          {error && (
            <p role="alert" className="dataset-platform-error">
              {error}
            </p>
          )}
        </DialogSurface>
      </Dialog.Root>
      <Dialog.Root
        open={!!detail}
        onOpenChange={(value) => {
          if (!value) setDetail(undefined);
        }}
      >
        <DialogSurface
          className="drawer"
          title={`${detail?.record.caseId ?? ""} · 执行详情`}
          description="查看验收依据、过程评价、工程指标和完整执行证据。"
        >
          {detail && (
            <div className="drawer-body dataset-platform-stack run-detail">
              {error && (
                <p role="alert" className="dataset-platform-error">
                  {error}
                </p>
              )}
              <div className="detail-score-grid">
                <div className="detail-score">
                  <span>任务验收</span>
                  <Status value={detail.record.acceptance.status} />
                </div>
                <div className="detail-score">
                  <span>过程分</span>
                  <strong>
                    <MetricValue
                      text={
                        detail.record.process ? `${number(detail.record.process.score)} 分` : "_"
                      }
                    />
                  </strong>
                </div>
                <div className="detail-score">
                  <span>综合分</span>
                  <strong>
                    <MetricValue
                      text={
                        scoreExecution(detail.record).score == null
                          ? "_"
                          : `${score(scoreExecution(detail.record).score)} 分`
                      }
                    />
                  </strong>
                </div>
              </div>
              <p className="dataset-platform-note">
                {scoreExecution(detail.record).reasons.join("；")}
              </p>
              <section className="detail-section">
                <h3>任务要求</h3>
                <p className="batch-instruction">
                  {tasks.find((task) => task.id === detail.record.caseId)?.instruction ??
                    "当前目录不包含这道题的中文任务要求。"}
                </p>
              </section>
              <section className="detail-section">
                <h3>验收检查</h3>
                {detail.record.acceptance.error && <p>{detail.record.acceptance.error}</p>}
                {detail.record.acceptance.checks.map((check) => (
                  <div className="detail-check" key={check.id}>
                    <div className="detail-check-heading">
                      <strong>{check.id}</strong>
                      <Status value={check.status} />
                    </div>
                    <p>{check.reason}</p>
                    <small className="dataset-platform-muted">
                      证据：{check.evidence.join(", ")}
                    </small>
                  </div>
                ))}
              </section>
              <section className="detail-section">
                <h3>过程评价</h3>
                <ChineseProcess record={detail.record} recordKey={detail.key} model={judgeModel} />
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !judgeModel}
                  onClick={() =>
                    void action(async () => {
                      const result = await api<ProcessReviewSummary>("/api/dataset/reevaluate", {
                        key: detail.key,
                        model: judgeModel,
                      });
                      setReview(result);
                      setReviews((values) => [result, ...values]);
                    })
                  }
                >
                  <ReloadIcon className={busy ? "spin" : ""} aria-hidden="true" />
                  {busy ? "正在评价…" : `使用 ${judgeModel || "Judge"} 独立过程复评`}
                </button>
                {review && (
                  <details open>
                    <summary>最近复评 · {review.policy.version} · 原成绩保留</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          status: review.status,
                          evaluatedAt: review.evaluatedAt,
                          judgeModel: review.policy.model,
                          process: review.process,
                          error: review.error,
                          errorKind: review.errorKind,
                          metrics: review.metrics,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                )}
                {reviews.length > 1 && (
                  <details>
                    <summary>查看全部 {reviews.length} 次过程复评</summary>
                    {reviews.map((item) => (
                      <p key={item.evaluatedAt}>
                        {new Date(item.evaluatedAt).toLocaleString("zh-CN")} · {item.policy.version}{" "}
                        · {item.policy.model} · {item.status} · 过程分 {number(item.process?.score)}
                      </p>
                    ))}
                  </details>
                )}
              </section>
              <details>
                <summary>工程指标与评价开销</summary>
                <pre>
                  {JSON.stringify(
                    {
                      engineering: detail.record.engineering,
                      evaluation: detail.record.evaluation,
                      missingEvidence: detail.record.missingEvidence,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <a
                className="secondary-button"
                href={`/api/dataset/runs/${detail.key}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLinkIcon aria-hidden="true" />
                查看完整执行记录 JSON
              </a>
              <details className="detail-evidence" key={detail.key}>
                <summary>
                  执行证据<small>{detail.record.evidence.length} 条 · 展开查看</small>
                </summary>
                <p className="dataset-platform-note">
                  长内容预览前 6,000 字符，完整内容保存在上面的执行记录中。
                </p>
                {detail.record.evidence.map((event) => (
                  <details key={event.id}>
                    <summary>
                      {event.id} · {event.type}
                    </summary>
                    <pre>{JSON.stringify(event.data, null, 2)?.slice(0, 6000)}</pre>
                  </details>
                ))}
              </details>
            </div>
          )}
        </DialogSurface>
      </Dialog.Root>
    </div>
  );
}
