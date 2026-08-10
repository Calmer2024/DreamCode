import { describe, expect, it } from "vitest";
import { createDesktopProvider } from "./provider";

describe("desktop provider resolution", () => {
  it("constructs the deterministic Fake Provider without an API key", () => {
    const result = createDesktopProvider("Fix tests", { provider: "fake" });

    expect(result.provider.name).toBe("fake");
  });
});
