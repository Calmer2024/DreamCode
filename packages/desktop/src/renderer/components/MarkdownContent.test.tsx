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
});
