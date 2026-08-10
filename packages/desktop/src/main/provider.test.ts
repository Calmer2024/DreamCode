import { describe, expect, it } from "vitest";
import { createDesktopProvider } from "./provider";

describe("desktop provider resolution", () => {
  it("constructs the deterministic Fake Provider without an API key", () => {
    const result = createDesktopProvider("Fix tests", { provider: "fake" });

    expect(result.provider.name).toBe("fake");
  });

  it("enables the abortable blocking Fake variant only for E2E", async () => {
    const previous = process.env.DREAMCODE_E2E;
    try {
      delete process.env.DREAMCODE_E2E;
      expect(
        createDesktopProvider("Keep running", { provider: "fake", model: "e2e-blocking" }).provider
          .name,
      ).toBe("fake");

      process.env.DREAMCODE_E2E = "1";
      const controller = new AbortController();
      const provider = createDesktopProvider("Keep running", {
        provider: "fake",
        model: "e2e-blocking",
      }).provider;
      const stream = provider
        .stream({
          messages: [],
          tools: [],
          model: "e2e-blocking",
          mode: "yolo",
          workspaceRoot: "D:/fixture",
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();

      expect(provider.name).toBe("fake-e2e-blocking");
      await expect(stream.next()).resolves.toMatchObject({
        value: { type: "text_delta" },
        done: false,
      });
      const blocked = stream.next();
      controller.abort("Stopped by E2E.");
      await expect(blocked).rejects.toBe("Stopped by E2E.");
    } finally {
      if (previous === undefined) delete process.env.DREAMCODE_E2E;
      else process.env.DREAMCODE_E2E = previous;
    }
  });
});
