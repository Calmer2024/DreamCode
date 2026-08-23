import {
  Children,
  type ComponentPropsWithoutRef,
  cloneElement,
  isValidElement,
  type ReactElement,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

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
          pre: MarkdownPre,
          code: ({ className, children, ...props }) => {
            const language = /language-(\S+)/.exec(className ?? "")?.[1];
            const value = String(children).replace(/\n$/, "");
            const inline = !className && !value.includes("\n");
            return inline ? (
              <code className={className} {...props}>
                {children}
              </code>
            ) : (
              <CodeBlock code={value} lang={language} />
            );
          },
          li: TaskListItem,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownPre({ children }: ComponentPropsWithoutRef<"pre">) {
  return <>{children}</>;
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
