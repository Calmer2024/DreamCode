// Runs the official SDK composition. Framework-owned events are translated by the common worker.
import { pathToFileURL } from "node:url";
const { DeepSeekHarness } = await import(pathToFileURL("/opt/harness/sdk/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js").href);
const [prompt, model] = process.argv.slice(2);
const harness = new DeepSeekHarness({
  launch: { command: "node", args: ["/opt/harness/node_modules/@deepseek-ai/dsh/lib/bin.js", "--profile", "sdk-minimal"],
    cwd: "/workspace", env: process.env },
  cwd: "/workspace", provider: "deepseek-official", model,
});
try {
  const result = await harness.run(prompt, { onNotification: (notification) => {
    process.stdout.write(`${JSON.stringify(notification)}\n`);
  } });
  process.stdout.write(`${JSON.stringify({ type: "dsh.result", finalResponse: result.finalResponse })}\n`);
} finally { await harness.close(); }
