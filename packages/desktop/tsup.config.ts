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
    // Electron's sandboxed preload cannot resolve workspace packages at runtime.
    // Bundle the shared contracts and their workspace dependencies into preload.
    noExternal: ["zod", /^@dreamcode\//],
    outDir: "dist-main",
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    sourcemap: true,
  },
]);
