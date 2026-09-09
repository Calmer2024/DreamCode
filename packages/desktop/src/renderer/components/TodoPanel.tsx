import type { TodoItem } from "@dreamcode/shared";
import { ChevronDown, CircleCheck, CircleDot, CircleX } from "lucide-react";
import { useState } from "react";

export function TodoPanel({ items }: { items: TodoItem[] }) {
  const [open, setOpen] = useState(true);
  const completed = items.filter((item) => item.status === "completed").length;
  const current =
    items.find((item) => item.status === "in_progress") ??
    items.find((item) => item.status === "pending") ??
    items.at(-1);
  const visibleItems = open ? items : current ? [current] : [];

  return (
    <section className="todo-panel" aria-label="任务清单">
      <button
        type="button"
        className="todo-panel-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="todo-panel-title">
          <CircleCheck aria-hidden="true" /> 任务清单
        </span>
        <span className="todo-panel-count">
          {completed}/{items.length}
        </span>
        <ChevronDown aria-hidden="true" className={open ? "todo-chevron-open" : ""} />
      </button>
      <div className={`todo-list${open ? "" : " todo-list-collapsed"}`}>
        {visibleItems.map((item) => {
          const Icon =
            item.status === "completed"
              ? CircleCheck
              : item.status === "blocked"
                ? CircleX
                : CircleDot;
          return (
            <div
              className={`todo-item todo-${item.status}`}
              key={`${item.status}-${item.content}`}
            >
              <Icon aria-hidden="true" />
              <span>{item.content}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
