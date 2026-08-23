import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

export function allowViteDevelopmentStyles(html: string): string {
  return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
}

const developmentCspPlugin: Plugin = {
  name: "dreamcode-development-csp",
  apply: "serve",
  transformIndexHtml: allowViteDevelopmentStyles,
};

export default defineConfig({
  base: "./",
  plugins: [react(), developmentCspPlugin],
  build: { outDir: "dist-renderer" },
});
