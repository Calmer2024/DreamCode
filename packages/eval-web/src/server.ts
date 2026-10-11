import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatasetPlatform } from "./dataset-platform";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const runsRoot = process.env.DREAMCODE_EVAL_RUNS_ROOT
  ? path.resolve(process.env.DREAMCODE_EVAL_RUNS_ROOT)
  : path.join(repoRoot, "evals", "runs");
const clientRoot = path.join(packageRoot, "dist-client");
const port = Number(process.env.DREAMCODE_EVAL_WEB_PORT ?? 4178);
const isDevelopment = process.argv.includes("--dev");
const datasetPlatform = createDatasetPlatform({ repoRoot, runsRoot, port });
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  let target = path.resolve(clientRoot, requested);
  if (
    !target.startsWith(`${clientRoot}${path.sep}`) &&
    target !== path.join(clientRoot, "index.html")
  ) {
    json(res, 400, { error: "Invalid path." });
    return;
  }
  if (!(await stat(target).catch(() => undefined))?.isFile())
    target = path.join(clientRoot, "index.html");
  const content = await readFile(target);
  res.writeHead(200, {
    "content-type": mimeTypes[path.extname(target)] ?? "application/octet-stream",
    "cache-control":
      path.basename(target) === "index.html" ? "no-cache" : "public, max-age=31536000",
  });
  res.end(content);
}

async function main() {
  await mkdir(runsRoot, { recursive: true });
  const vite = isDevelopment
    ? await import("vite").then((module) =>
        module.createServer({
          root: packageRoot,
          server: { middlewareMode: true },
          appType: "spa",
        }),
      )
    : undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (await datasetPlatform(req, res, url)) return;
    if (url.pathname.startsWith("/api/")) {
      json(res, 404, { error: "API route not found." });
      return;
    }
    if (
      url.pathname !== "/" &&
      !url.pathname.startsWith("/assets/") &&
      !(
        isDevelopment &&
        (url.pathname.startsWith("/src/") ||
          url.pathname.startsWith("/@") ||
          url.pathname.startsWith("/node_modules/"))
      )
    ) {
      json(res, 404, { error: "Page not found." });
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => json(res, 404, { error: "Page not found." }));
      return;
    }
    await serveStatic(res, decodeURIComponent(url.pathname)).catch((error) =>
      json(res, 500, { error: error instanceof Error ? error.message : String(error) }),
    );
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`DreamCode Eval Web: http://127.0.0.1:${port}`);
  });
}

void main();
