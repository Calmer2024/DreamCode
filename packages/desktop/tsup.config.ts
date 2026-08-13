import { defineConfig } from "tsup";

export default defineConfig([
  {
    clean: true,
    dts: false,
    entry: {
      "main/index": "src/main/index.ts",
      "shared/contracts": "src/shared/contracts.ts",
    },
    external: ["electron"],
    format: ["esm"],
    outDir: "dist-main",
    platform: "node",
    sourcemap: true,
  },
  {
    clean: false,
    dts: false,
    entry: { "preload/index": "src/preload/index.ts" },
    external: ["electron"],
    format: ["cjs"],
    noExternal: ["zod"],
    outDir: "dist-main",
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    sourcemap: true,
  },
]);
