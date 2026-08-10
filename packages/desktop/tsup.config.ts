import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/shared/contracts.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
});
