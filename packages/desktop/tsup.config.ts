import { defineConfig } from "tsup";

export default defineConfig([
  {
    clean: true,
    dts: false,
    entry: {
      "main/index": "src/main/index.ts",
      "shared/contracts": "src/shared/contracts.ts",
    },
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    sourcemap: true,
  },
  {
    clean: false,
    dts: false,
    entry: { "preload/index": "src/preload/index.ts" },
    format: ["cjs"],
    outDir: "dist",
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    sourcemap: true,
  },
]);
