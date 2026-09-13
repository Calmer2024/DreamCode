import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  packageRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const foreground = process.env.DREAMCODE_DEV_FOREGROUND === "1";
const child = spawn(executable, [path.join(packageRoot, "dist-main", "main", "index.js")], {
  cwd: packageRoot,
  detached: !foreground,
  env: { ...process.env, VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173" },
  stdio: foreground ? "inherit" : "ignore",
  windowsHide: !foreground,
});
if (!foreground) {
  child.unref();
}
