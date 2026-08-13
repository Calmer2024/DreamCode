import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "../..");

describe("desktop renderer architecture", () => {
  it("keeps the product UI in the React renderer", () => {
    expect(existsSync(path.join(desktopRoot, "src/renderer/main.tsx"))).toBe(true);
    expect(existsSync(path.join(desktopRoot, "src/renderer/app/App.tsx"))).toBe(true);
    expect(existsSync(path.join(desktopRoot, "src/renderer/app/app.css"))).toBe(true);
    expect(existsSync(path.join(desktopRoot, "src/renderer.html"))).toBe(false);
  });

  it("keeps index.html as a Vite mount document only", () => {
    const indexHtml = readFileSync(path.join(desktopRoot, "index.html"), "utf8");

    expect(indexHtml).toContain('<div id="root"></div>');
    expect(indexHtml).toContain('src="/src/renderer/main.tsx"');
    expect(indexHtml).not.toMatch(/<style\b/i);
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(indexHtml).not.toMatch(/\bon(?:click|input|change|keydown)=/i);
  });
});
