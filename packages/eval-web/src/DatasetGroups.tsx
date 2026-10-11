import { useState } from "react";
import {
  CopyIcon,
  Pencil1Icon,
  PlusIcon,
  TrashIcon,
  PlayIcon,
  MagnifyingGlassIcon,
  CheckIcon,
} from "@radix-ui/react-icons";
import { Dialog, DialogSurface, TaskCheckbox, SelectField } from "./controls";
import type { DatasetGroup, DatasetTask } from "./dataset-types";

export function DatasetGroups({
  groups,
  tasks,
  sceneLabels,
  busy,
  error,
  save,
  remove,
  launch,
}: {
  groups: DatasetGroup[];
  tasks: DatasetTask[];
  sceneLabels: Record<string, string>;
  busy: boolean;
  error: string;
  save: (
    value: { name: string; description: string; caseIds: string[] },
    id?: string,
  ) => Promise<boolean>;
  remove: (id: string) => void;
  launch: (id: string) => void;
}) {
  const [editing, setEditing] = useState<{ id?: string }>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [scene, setScene] = useState("all");
  const edit = (group?: DatasetGroup, copy = false) => {
    setEditing({ id: copy ? undefined : group?.id });
    setName(group ? `${group.name}${copy ? " · 副本" : ""}` : "");
    setDescription(group?.description ?? "");
    setSelected(group?.caseIds ?? []);
    setSearch("");
    setScene("all");
  };
  const filtered = tasks.filter(
    (task) =>
      (scene === "all" || task.metadata?.scenario === scene) &&
      `${task.id} ${task.instruction} ${task.metadata?.project}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((task) => selected.includes(task.id));
  return (
    <>
      <section className="panel">
        <header className="panel-header">
          <div>
            <h2>评测组 · {groups.length}</h2>
            <p>从数据集选题组成可复用的评测组；新建评测可选择组，也可直接从数据集选题。</p>
          </div>
          <button type="button" className="primary-button" onClick={() => edit()}>
            <PlusIcon aria-hidden="true" />
            新建评测组
          </button>
        </header>
        <div className="group-list">
          {groups.map((group) => {
            const chosen = tasks.filter((task) => group.caseIds.includes(task.id));
            const counts = Object.entries(sceneLabels)
              .map(([scene, label]) => ({
                label,
                count: chosen.filter((task) => task.metadata?.scenario === scene).length,
              }))
              .filter((item) => item.count);
            return (
              <article className="group-card" key={group.id}>
                <div className="group-card-heading">
                  <h3>{group.name}</h3>
                  <span className="metadata-tag">
                    {group.builtin ? "内置" : "自定义"} · {chosen.length} 题
                  </span>
                </div>
                <p>{group.description || "未填写说明"}</p>
                <div className="metadata-tags">
                  {counts.map((item) => (
                    <span className="metadata-tag" key={item.label}>
                      {item.label} {item.count}
                    </span>
                  ))}
                </div>
                <details className="group-members">
                  <summary>查看 {chosen.length} 道题</summary>
                  <ul>
                    {chosen.map((task) => (
                      <li key={task.id}>
                        <strong>{task.id}</strong>
                        <span>
                          {task.metadata?.project} · {sceneLabels[task.metadata?.scenario ?? ""]}
                        </span>
                        <p>{task.instruction}</p>
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="group-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => launch(group.id)}
                  >
                    <PlayIcon aria-hidden="true" />
                    使用此组评测
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title={`复制 ${group.name}`}
                    aria-label={`复制 ${group.name}`}
                    onClick={() => edit(group, true)}
                  >
                    <CopyIcon />
                  </button>
                  {!group.builtin && (
                    <>
                      <button
                        type="button"
                        className="icon-button"
                        title={`编辑 ${group.name}`}
                        aria-label={`编辑 ${group.name}`}
                        onClick={() => edit(group)}
                      >
                        <Pencil1Icon />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy}
                        title={`删除 ${group.name}`}
                        aria-label={`删除 ${group.name}`}
                        onClick={() => remove(group.id)}
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <Dialog.Root
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        <DialogSurface
          title={editing?.id ? "编辑评测组" : "新建评测组"}
          description="选择题目并保存组。组的修改不会影响已提交评测的题目范围。"
        >
          <div className="modal-body dataset-platform-stack">
            {error && (
              <p role="alert" className="dataset-platform-error">
                {error}
              </p>
            )}
            <label>
              <span>评测组名称</span>
              <input
                className="group-input"
                aria-label="评测组名称"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              <span>评测组说明</span>
              <textarea
                className="group-input"
                aria-label="评测组说明"
                value={description}
                maxLength={2000}
                rows={3}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <div className="catalog-toolbar">
              <div className="search-field">
                <MagnifyingGlassIcon />
                <input
                  className="dataset-platform-search"
                  aria-label="搜索组内候选题目"
                  placeholder="搜索题目、项目"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <SelectField
                label="评测组候选场景"
                value={scene}
                onChange={setScene}
                options={[
                  { value: "all", label: "全部场景" },
                  ...Object.entries(sceneLabels).map(([value, label]) => ({ value, label })),
                ]}
              />
            </div>
            <div className="picker-heading">
              <span>
                题目{" "}
                <small>
                  已选 {selected.length} / {tasks.length}
                </small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={allFilteredSelected ? "取消选择筛选题目" : "选择全部筛选题目"}
                title={allFilteredSelected ? "取消选择筛选题目" : "选择全部筛选题目"}
                disabled={!filtered.length}
                onClick={() =>
                  setSelected((values) =>
                    allFilteredSelected
                      ? values.filter((id) => !filtered.some((task) => task.id === id))
                      : [...new Set([...values, ...filtered.map((task) => task.id)])],
                  )
                }
              >
                <CheckIcon aria-hidden="true" />
              </button>
            </div>
            <div className="group-picker">
              {filtered.map((task) => (
                <label key={task.id} htmlFor={`group-${task.id}`}>
                  <TaskCheckbox
                    id={`group-${task.id}`}
                    label={`选择 ${task.id}`}
                    checked={selected.includes(task.id)}
                    onChange={(checked) =>
                      setSelected((values) =>
                        checked ? [...values, task.id] : values.filter((id) => id !== task.id),
                      )
                    }
                  />
                  <span>
                    <strong>{task.id}</strong> · {task.metadata?.project} ·{" "}
                    {sceneLabels[task.metadata?.scenario ?? ""]}
                    <span className="group-task-instruction">{task.instruction}</span>
                  </span>
                </label>
              ))}
            </div>
            {!filtered.length && (
              <p className="dataset-platform-note">没有匹配的题目，请调整筛选条件。</p>
            )}
          </div>
          <footer className="modal-footer">
            <span>
              已选 {selected.length} / {tasks.length} 题
            </span>
            <button
              type="button"
              className="primary-button"
              disabled={busy || !name.trim() || !selected.length}
              onClick={async () => {
                if (await save({ name, description, caseIds: selected }, editing?.id))
                  setEditing(undefined);
              }}
            >
              <CheckIcon />
              保存评测组
            </button>
          </footer>
        </DialogSurface>
      </Dialog.Root>
    </>
  );
}
