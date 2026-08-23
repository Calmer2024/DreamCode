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

  it("keeps a visible, isolated scrollbar on the conversation stream", () => {
    const css = readFileSync(path.join(desktopRoot, "src/renderer/app/app.css"), "utf8");

    expect(css).toMatch(/\.conversation-scroll\s*\{[^}]*overflow-y:\s*scroll;/s);
    expect(css).toMatch(/\.conversation-scroll\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
    expect(css).toMatch(/\.conversation-scroll::-webkit-scrollbar-thumb\s*\{/);
    expect(css).toMatch(/scrollbar-color:\s*#ededed transparent;/);
  });

  it("self-hosts Noto Sans SC for ordinary desktop UI typography", () => {
    const entry = readFileSync(path.join(desktopRoot, "src/renderer/main.tsx"), "utf8");
    const css = readFileSync(path.join(desktopRoot, "src/renderer/app/app.css"), "utf8");

    for (const weight of [400, 500, 600, 700]) {
      expect(entry).toContain(`@fontsource/noto-sans-sc/chinese-simplified-${weight}.css`);
    }
    expect(css).toContain('--font-ui: "Noto Sans SC", sans-serif;');
    expect(css).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-ui\);/s);
    expect(css).not.toMatch(/--font-ui:[^;]*(Segoe UI|Microsoft YaHei)/);
  });

  it("renders tooltips in a fixed top-level layer instead of sidebar pseudo-elements", () => {
    const css = readFileSync(path.join(desktopRoot, "src/renderer/app/app.css"), "utf8");
    const tooltip = readFileSync(
      path.join(desktopRoot, "src/renderer/components/TooltipLayer.tsx"),
      "utf8",
    );

    expect(css).toMatch(/\.app-tooltip\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*1000;/s);
    expect(css).not.toMatch(/\[data-tooltip\]::after/);
    expect(tooltip).toContain("createPortal");
    expect(tooltip).toContain("document.body");
  });

  it("documents the production scrollbar and compact left-aligned dropdown menu", () => {
    const guide = readFileSync(
      path.resolve(desktopRoot, "../../docs/component-guidelines.html"),
      "utf8",
    );

    expect(guide).toContain('id="scrollbar"');
    expect(guide).toContain("scrollbar-width: thin");
    expect(guide).toContain("scrollbar-color: #ededed transparent");
    expect(guide).toContain("Width 218 · Radius 14");
    expect(guide).toContain("左边缘与触发按钮左边缘对齐");
    expect(guide).toContain("标题仅展示文本，折叠按钮固定在右侧");
    expect(guide).toContain("挂载到 body 的 fixed 顶层浮层");
  });
});
