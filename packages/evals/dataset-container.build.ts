import { defineConfig } from "tsup";
import path from "node:path";
import { copyFile } from "node:fs/promises";

export default defineConfig({
  entry: { worker: "packages/evals/src/dataset/container-worker.ts" },
  outDir: "packages/evals/dist-dataset-container",
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node24",
  noExternal: [/.*/],
  clean: true,
  async onSuccess() {
    await copyFile("packages/evals/container/agents/dsh-driver.mjs", "packages/evals/dist-dataset-container/dsh-driver.mjs");
  },
  splitting: false,
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      "@vscode/ripgrep": path.resolve("packages/evals/src/dataset/container-ripgrep.ts"),
    };
  },
  banner: {
    js: "import { createRequire as __workerRequire } from 'node:module'; const require = __workerRequire(import.meta.url);",
  },
});
