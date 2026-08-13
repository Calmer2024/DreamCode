import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_PROVIDER_PRESETS } from "@dreamcode/models";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | undefined;
const logs: Array<{ time: string; type: string; text: string }> = [];

function addLog(type: string, text: string) {
  const entry = { time: new Date().toISOString(), type, text };
  logs.push(entry);
  win?.webContents.send("agent-log", entry);
}

function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 1024, minHeight: 700, backgroundColor: "#ffffff", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, "renderer.html"));
  win.webContents.once("did-finish-load", () => { win?.webContents.send("providers", MODEL_PROVIDER_PRESETS); logs.forEach((entry) => win?.webContents.send("agent-log", entry)); });
}

ipcMain.handle("get-providers", () => MODEL_PROVIDER_PRESETS);
ipcMain.handle("get-logs", () => logs);
ipcMain.handle("run-demo", async (_event, prompt: string) => {
  addLog("turn.started", `开始执行：${prompt}`);
  addLog("context.built", "已构建工作区上下文");
  addLog("model.started", "模型开始生成响应");
  await new Promise((resolve) => setTimeout(resolve, 350));
  addLog("model.delta", "我会先检查项目结构，然后完成请求。");
  addLog("tool.started", "准备执行工具：workspace.inspect");
  await new Promise((resolve) => setTimeout(resolve, 250));
  addLog("tool.completed", "workspace.inspect 已完成");
  addLog("turn.completed", "Agent 执行完成");
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
