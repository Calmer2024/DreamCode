import { ArchiveIcon, LayersIcon, MixerHorizontalIcon } from "@radix-ui/react-icons";
import type { DatasetTask } from "./dataset-types";

const methods: Record<string, string> = {
  program: "程序验收",
  judge: "Judge 验收",
  combined: "联合验收",
};
function distribution(tasks: DatasetTask[], field: (task: DatasetTask) => string) {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const key = field(task);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
const share = (count: number, total: number) =>
  total ? `${((count / total) * 100).toFixed(1)}%` : "0.0%";

export function DatasetComposition({
  tasks,
  version,
  sceneLabels,
  scene,
  project,
  onScene,
  onProject,
}: {
  tasks: DatasetTask[];
  version: string;
  sceneLabels: Record<string, string>;
  scene: string;
  project: string;
  onScene: (value: string) => void;
  onProject: (value: string) => void;
}) {
  const scenarios = distribution(tasks, (task) => task.metadata?.scenario ?? "unclassified");
  const projects = distribution(tasks, (task) => task.metadata?.project ?? "unclassified");
  const evaluators = distribution(tasks, (task) => task.acceptance.evaluator);
  const readonly = tasks.filter((task) => task.constraints?.editable.length === 0).length;
  const total = tasks.length;
  let offset = 0;
  const bars = (
    items: typeof scenarios,
    labels: Record<string, string>,
    selected: string,
    select: (value: string) => void,
  ) => (
    <ul className="composition-bars">
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            aria-pressed={selected === item.key}
            onClick={() => select(selected === item.key ? "all" : item.key)}
            aria-label={`筛选${labels[item.key] ?? item.key}，${item.count} 道题`}
          >
            <span className="composition-bar-heading">
              <span>{labels[item.key] ?? item.key}</span>
              <span>
                <strong>{item.count}</strong>
                <small>{share(item.count, total)}</small>
              </span>
            </span>
            <span className="composition-bar-track" aria-hidden="true">
              <span style={{ width: share(item.count, items[0]?.count ?? 0) }} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="panel dataset-composition" aria-label="数据集组成总览">
      <header className="panel-header">
        <div>
          <h2>数据集组成</h2>
          <p>版本 {version} · 覆盖真实代码仓库中的多类工程任务</p>
        </div>
        <div className="composition-totals">
          <span>
            <strong>{total}</strong>道题
          </span>
          <span>
            <strong>{scenarios.length}</strong>类场景
          </span>
          <span>
            <strong>{projects.length}</strong>个项目
          </span>
        </div>
      </header>
      <div className="composition-grid">
        <section>
          <h3>
            <LayersIcon aria-hidden="true" />
            场景覆盖
          </h3>
          {bars(scenarios, sceneLabels, scene, onScene)}
        </section>
        <section>
          <h3>
            <ArchiveIcon aria-hidden="true" />
            项目分布
          </h3>
          {bars(projects, {}, project, onProject)}
        </section>
        <section>
          <h3>
            <MixerHorizontalIcon aria-hidden="true" />
            验收方式
          </h3>
          <svg
            className="composition-donut"
            viewBox="0 0 120 120"
            role="img"
            aria-label={`验收方式分布，共 ${total} 题：${evaluators.map((item) => `${methods[item.key] ?? item.key} ${item.count} 题，占 ${share(item.count, total)}`).join("；")}`}
          >
            <circle className="donut-track" cx="60" cy="60" r="43" fill="none" strokeWidth="12" />
            {evaluators.map((item) => {
              const size = total ? (item.count / total) * 100 : 0;
              const start = offset;
              offset += size;
              return (
                <circle
                  key={item.key}
                  className={`donut-segment method-${item.key}`}
                  cx="60"
                  cy="60"
                  r="43"
                  fill="none"
                  strokeWidth="12"
                  pathLength="100"
                  strokeDasharray={`${size} ${100 - size}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 60 60)"
                />
              );
            })}
            <text className="donut-total" x="60" y="59" textAnchor="middle">
              {total}
            </text>
            <text className="donut-caption" x="60" y="77" textAnchor="middle">
              道测试题
            </text>
          </svg>
          <ul className="composition-methods">
            {evaluators.map((item) => (
              <li key={item.key}>
                <span>
                  <i className={`method-${item.key}`} aria-hidden="true" />
                  {methods[item.key] ?? item.key}
                </span>
                <span>
                  <strong>{item.count}</strong>
                  <small>{share(item.count, total)}</small>
                </span>
              </li>
            ))}
          </ul>
          <p className="composition-explanation">
            程序验证可确定的预期行为，Judge 评价开放式结果，联合验收同时使用两种方式。
          </p>
        </section>
      </div>
      <footer className="composition-footer">
        <span>
          只读任务 {readonly} 题 · 可修改工作区任务 {total - readonly} 题
        </span>
        <span>全量 Dataset 统计 · 点击场景或项目可筛选题目</span>
      </footer>
    </section>
  );
}
