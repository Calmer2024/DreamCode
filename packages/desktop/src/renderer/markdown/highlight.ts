import langJson from "@shikijs/langs/json";
import langBash from "@shikijs/langs/shellscript";
import langTs from "@shikijs/langs/typescript";
import {
  createCssVariablesTheme,
  createHighlighterCoreSync,
  type HighlighterCore,
} from "shiki/core";
import {
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor,
} from "shiki/engine/javascript";

type LangModule = { default: typeof langTs };

const bootLanguages = [langTs, langBash, langJson];
const lazyLanguages = new Map<string, () => Promise<LangModule>>([
  ["python", () => import("@shikijs/langs/python")],
  ["ruby", () => import("@shikijs/langs/ruby")],
  ["go", () => import("@shikijs/langs/go")],
  ["rust", () => import("@shikijs/langs/rust")],
  ["java", () => import("@shikijs/langs/java")],
  ["c", () => import("@shikijs/langs/c")],
  ["cpp", () => import("@shikijs/langs/cpp")],
  ["csharp", () => import("@shikijs/langs/csharp")],
  ["kotlin", () => import("@shikijs/langs/kotlin")],
  ["swift", () => import("@shikijs/langs/swift")],
  ["php", () => import("@shikijs/langs/php")],
  ["yaml", () => import("@shikijs/langs/yaml")],
  ["toml", () => import("@shikijs/langs/toml")],
  ["ini", () => import("@shikijs/langs/ini")],
  ["markdown", () => import("@shikijs/langs/markdown")],
  ["mdx", () => import("@shikijs/langs/mdx")],
  ["html", () => import("@shikijs/langs/html")],
  ["css", () => import("@shikijs/langs/css")],
  ["scss", () => import("@shikijs/langs/scss")],
  ["less", () => import("@shikijs/langs/less")],
  ["sql", () => import("@shikijs/langs/sql")],
  ["xml", () => import("@shikijs/langs/xml")],
  ["lua", () => import("@shikijs/langs/lua")],
]);

const aliases = new Map<string, string>([
  ["typescript", "typescript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["javascript", "typescript"],
  ["js", "typescript"],
  ["jsx", "typescript"],
  ["shellscript", "shellscript"],
  ["shell", "shellscript"],
  ["bash", "shellscript"],
  ["sh", "shellscript"],
  ["zsh", "shellscript"],
  ["json", "json"],
  ["jsonc", "json"],
  ["py", "python"],
  ["python", "python"],
  ["rb", "ruby"],
  ["ruby", "ruby"],
  ["go", "go"],
  ["rs", "rust"],
  ["rust", "rust"],
  ["java", "java"],
  ["c", "c"],
  ["cpp", "cpp"],
  ["cs", "csharp"],
  ["csharp", "csharp"],
  ["kotlin", "kotlin"],
  ["swift", "swift"],
  ["php", "php"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["toml", "toml"],
  ["ini", "ini"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["mdx", "mdx"],
  ["html", "html"],
  ["css", "css"],
  ["scss", "scss"],
  ["less", "less"],
  ["sql", "sql"],
  ["xml", "xml"],
  ["lua", "lua"],
]);

const theme = createCssVariablesTheme({
  name: "css-variables",
  variablePrefix: "--shiki-",
  fontStyle: true,
});
const regexEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: (pattern) =>
    defaultJavaScriptRegexConstructor(pattern, {
      lazyCompileLength: Number.POSITIVE_INFINITY,
    }),
});
let singleton: HighlighterCore | undefined;
const requested = new Set<string>();
const listeners = new Set<() => void>();
let loadCount = 0;

function highlighter(): HighlighterCore {
  singleton ??= createHighlighter();
  return singleton;
}

function createHighlighter(): HighlighterCore {
  const instance = createHighlighterCoreSync({
    themes: [theme],
    langs: bootLanguages,
    engine: regexEngine,
  });
  for (const sample of [
    { lang: "typescript", code: "const answer: number = 42" },
    { lang: "shellscript", code: "printf '%s\\n' \"$HOME\"" },
    { lang: "json", code: '{"ready":true}' },
  ] as const) {
    instance.codeToTokens(sample.code, {
      lang: sample.lang,
      theme: "css-variables",
      tokenizeTimeLimit: 0,
    });
  }
  return instance;
}

function ensureLanguage(language: string): boolean {
  const load = lazyLanguages.get(language);
  if (!load || highlighter().getLoadedLanguages().includes(language)) return true;
  if (!requested.has(language)) {
    requested.add(language);
    void load().then((module) => {
      highlighter().loadLanguageSync(module.default);
      loadCount += 1;
      for (const listener of listeners) listener();
    });
  }
  return false;
}

export function subscribeGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function grammarLoadCount(): number {
  return loadCount;
}

export function highlightToHtml(code: string, language?: string): string | undefined {
  const resolved = language ? aliases.get(language.toLowerCase()) : undefined;
  if (!resolved || !ensureLanguage(resolved)) return undefined;
  return makeShikiHtmlCspSafe(
    highlighter().codeToHtml(code, { lang: resolved, theme: "css-variables" }),
  );
}

function makeShikiHtmlCspSafe(html: string): string {
  return html.replace(/\sstyle="([^"]*)"/g, (_attribute, inlineStyle: string) => {
    const markers: string[] = [];
    for (const declaration of inlineStyle.split(";")) {
      const [rawProperty, rawValue] = declaration.split(":", 2);
      const property = rawProperty?.trim();
      const value = rawValue?.trim();
      if (!property || !value) continue;
      if (property === "color") {
        const color = /^var\(--shiki-(?:token-)?([a-z-]+)\)$/.exec(value)?.[1];
        if (color) markers.push(`color-${color}`);
      } else if (property === "font-style" && value === "italic") {
        markers.push("italic");
      } else if (property === "font-weight" && (value === "bold" || value === "700")) {
        markers.push("bold");
      } else if (property === "text-decoration" && value.includes("underline")) {
        markers.push("underline");
      }
    }
    return markers.length ? ` data-shiki="${markers.join(" ")}"` : "";
  });
}

const warmupTimer = setTimeout(() => highlighter(), 0);
(warmupTimer as { unref?: () => void }).unref?.();
