import {
  Children,
  type ComponentPropsWithoutRef,
  cloneElement,
  isValidElement,
  type ReactElement,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  children: string;
}

export function MarkdownContent({ children }: MarkdownContentProps) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: linkChildren, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {linkChildren}
            </a>
          ),
          li: TaskListItem,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function TaskListItem({ className, children, ...props }: ComponentPropsWithoutRef<"li">) {
  const taskItem = className?.split(" ").includes("task-list-item");
  const childList = Children.toArray(children);
  const label = childList
    .filter((child): child is string => typeof child === "string")
    .join(" ")
    .trim();
  const accessibleChildren = taskItem
    ? childList.map((child) =>
        isValidElement(child) && child.type === "input"
          ? cloneElement(child as ReactElement<ComponentPropsWithoutRef<"input">>, {
              "aria-label": label,
            })
          : child,
      )
    : children;
  return (
    <li className={className} {...props}>
      {accessibleChildren}
    </li>
  );
}
