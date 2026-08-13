// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { ErrorBoundary } from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  it("replaces a crashed renderer with a reload recovery screen", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <CrashedView />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("界面遇到了意外问题");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
    consoleError.mockRestore();
  });
});

function CrashedView(): never {
  throw new Error("renderer crash");
}
