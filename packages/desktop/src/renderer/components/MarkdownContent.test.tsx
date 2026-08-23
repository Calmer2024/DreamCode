// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../test/setup";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders GFM content and keeps raw HTML inert", () => {
    render(
      <MarkdownContent>{`## Result

> Review note

- [x] Tests passed

| Item | State |
| --- | --- |
| UI | Ready |

[documentation](https://example.com/docs) and \`pnpm test\`

~~obsolete~~

<script>alert(1)</script>`}</MarkdownContent>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Result" })).toBeVisible();
    expect(screen.getByText("Review note").closest("blockquote")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Tests passed" })).toBeChecked();
    expect(screen.getByRole("table")).toHaveTextContent("ItemStateUIReady");
    expect(screen.getByRole("link", { name: "documentation" })).toHaveAttribute(
      "rel",
      "noreferrer",
    );
    expect(screen.getByText("pnpm test", { selector: "code" })).toBeVisible();
    expect(screen.getByText("obsolete").tagName).toBe("DEL");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>")).toBeVisible();
  });

  it("renders fenced code with the DeepSeek Shiki code-block surface", () => {
    const { container } = render(
      <MarkdownContent>{"```ts\nconst answer: number = 42;\n```"}</MarkdownContent>,
    );

    expect(container.querySelector(".md-code-block")).not.toBeNull();
    expect(container.querySelector("pre.shiki")).not.toBeNull();
    expect(container.querySelector(".md-code-block")?.parentElement?.tagName).not.toBe("PRE");
    expect(container.querySelectorAll(".md-code-block pre")).toHaveLength(1);
    expect(container.querySelector(".markdown-content > pre")).toBeNull();
    expect(container.querySelector("pre.shiki [data-shiki]")).not.toBeNull();
    expect(container.querySelector("pre.shiki [style]")).toBeNull();
    expect(screen.getByText("ts")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制代码" })).toBeVisible();
  });

  it("syntax-highlights shell commands with distinct token colors", () => {
    const { container } = render(
      <MarkdownContent>
        {"```bash\n# note\ndocker run -v ./src:/workspace image\n```"}
      </MarkdownContent>,
    );

    const tokenStyles = Array.from(container.querySelectorAll("pre.shiki [data-shiki]"))
      .map((token) => token.getAttribute("data-shiki"))
      .filter(Boolean);
    expect(new Set(tokenStyles).size).toBeGreaterThanOrEqual(3);
    expect(tokenStyles.some((style) => style?.includes("comment"))).toBe(true);
  });
});
