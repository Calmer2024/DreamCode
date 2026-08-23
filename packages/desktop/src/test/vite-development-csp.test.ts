import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowViteDevelopmentStyles } from "../../vite.config";

describe("desktop Vite development CSP", () => {
  it("allows Vite style injection only in the transformed development document", () => {
    const indexHtml = readFileSync(path.resolve(import.meta.dirname, "../../index.html"), "utf8");
    const developmentHtml = allowViteDevelopmentStyles(indexHtml);

    expect(indexHtml).toContain("style-src 'self'");
    expect(indexHtml).not.toContain("'unsafe-inline'");
    expect(developmentHtml).toContain("style-src 'self' 'unsafe-inline'");
  });
});
