// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../test/setup";
import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders a bundled brand asset for a known provider", () => {
    const { container } = render(<ProviderIcon provider="openai" />);

    expect(container.querySelector(".provider-icon img")?.getAttribute("src")).toMatch(
      /^data:image\/svg\+xml/,
    );
  });

  it("uses the shared icon component for custom services", () => {
    render(<ProviderIcon provider="openai-compatible" />);

    expect(screen.getByTestId("provider-fallback-icon")).toBeInTheDocument();
  });
});
