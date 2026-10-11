import { useState } from "react";
import type { DatasetJob } from "./dataset-types";
import { SelectField } from "./controls";
import { agentLabel } from "./dataset-batches";
import { evaluationHistory } from "./dataset-history";

const statusLabels: Record<string, string> = {
  completed: "已完成",
  running: "运行中",
  queued: "排队中",
  interrupted: "已中断",
  error: "执行错误",
};
export function DatasetHistory({ jobs }: { jobs: DatasetJob[] }) {
  const [days, setDays] = useState("30");
  const report = evaluationHistory(jobs, Number(days));
  const frameworkMax = Math.max(1, ...report.frameworks.map((item) => item.batches));
  const dayMax = Math.max(1, ...report.daily.map((item) => item.count));
  const points = report.daily
    .map(
      (item, index) =>
        `${24 + index * (552 / Math.max(1, report.daily.length - 1))},${158 - (item.count / dayMax) * 122}`,
    )
    .join(" ");
  return (
    <section className="history-section" aria-label="最近评测历史统计">
      <header className="history-heading">
        <div>
          <h2>评测历史</h2>
          <p>
            近 {days} 天提交 {report.batches} 个批次 · 已执行 {report.executions} 次题目
          </p>
        </div>
        <SelectField
          label="历史统计时间范围"
          value={days}
          onChange={setDays}
          options={[
            { value: "7", label: "近 7 天" },
            { value: "30", label: "近 30 天" },
            { value: "90", label: "近 90 天" },
          ]}
        />
      </header>
      <div className="history-chart-grid">
        <figure className="panel history-chart">
          <figcaption>
            <strong>框架评测次数</strong>
            <span>提交批次数</span>
          </figcaption>
          <div className="framework-bars">
            {report.frameworks.map((item) => (
              <div
                className="framework-bar"
                key={item.id}
                aria-label={`${agentLabel(item.id)}：${item.batches} 个批次，已执行 ${item.executions} 次题目`}
              >
                <span>{agentLabel(item.id)}</span>
                <div className="history-bar-track">
                  <div style={{ width: `${(item.batches / frameworkMax) * 100}%` }} />
                </div>
                <strong>
                  {item.batches}
                  <small>次</small>
                </strong>
              </div>
            ))}
          </div>
          <p className="history-chart-note">一次提交计一个批次，多题目和重复执行不增加批次数。</p>
        </figure>
        <figure className="panel history-chart">
          <figcaption>
            <strong>近期评测趋势</strong>
            <span>每日提交批次数 · 北京时间</span>
          </figcaption>
          <svg
            className="history-trend"
            viewBox="0 0 600 190"
            role="img"
            aria-label={`近 ${days} 天每日评测批次数`}
          >
            <title>{report.daily.map((item) => `${item.date}：${item.count} 次`).join("；")}</title>
            {[0, 0.5, 1].map((tick) => (
              <g key={tick}>
                <line
                  x1="24"
                  x2="576"
                  y1={158 - tick * 122}
                  y2={158 - tick * 122}
                  className="history-gridline"
                />
                {tick !== 0.5 && (
                  <text x="12" y={162 - tick * 122} textAnchor="end">
                    {Math.round(tick * dayMax)}
                  </text>
                )}
              </g>
            ))}
            <polyline points={points} className="history-line" />
            {report.daily.map((item, index) => (
              <circle
                key={item.date}
                cx={24 + index * (552 / Math.max(1, report.daily.length - 1))}
                cy={158 - (item.count / dayMax) * 122}
                r={item.count ? 3.5 : 2}
                className="history-point"
              >
                <title>
                  {item.date}：{item.count} 次
                </title>
              </circle>
            ))}
            <text x="24" y="182">
              {report.daily[0]?.date.slice(5).replace("-", "/")}
            </text>
            <text x="576" y="182" textAnchor="end">
              {report.daily.at(-1)?.date.slice(5).replace("-", "/")}
            </text>
          </svg>
          <div className="history-statuses">
            {report.statuses.map((item) => (
              <span key={item.id}>
                <i className={`history-status-dot history-status-${item.id}`} />
                {statusLabels[item.id]}
                <strong>{item.count}</strong>
              </span>
            ))}
          </div>
        </figure>
      </div>
      {!report.batches && <p className="dataset-platform-note">所选时间范围内暂无评测批次。</p>}
      <p className="history-scope-note">
        统计已保留的评测批次；独立试跑记录不计入批次数，删除的记录不再计入统计。
      </p>
    </section>
  );
}
