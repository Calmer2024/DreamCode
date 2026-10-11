/** Diagnostic only. Does not change the production sandbox helper or Agent runtime. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./execute.js";
import { prepareSandboxedSpawn } from "../../../../packages/tools/src/sandbox.js";

if (process.platform !== "win32") throw Error("This diagnostic requires Windows");
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "dreamcode-pipe-diagnostic-"));
const workspace = path.join(root, "workspace");
await mkdir(workspace);
const outside = path.join(root, "outside.txt");
await writeFile(outside, "protected");
const user = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
  encoding: "utf8",
}).match(/S-1-5-21-[0-9-]+/)?.[0];
if (!user) throw Error("Could not resolve signed-in user SID");
// A disposable fixture with an explicit user grant catches unsafe principal-SID fixes.
execFileSync("icacls.exe", [outside, "/grant", `*${user}:(F)`]);
const program = path.join(directory, "target/release/pipe-debug.exe");
const base = await prepareSandboxedSpawn({
  program,
  args: [],
  cwd: workspace,
  env: process.env,
  policy: {
    mode: "workspace-write",
    readableRoots: "all",
    writableRoots: [workspace, path.join(workspace, "tmp")],
    networkAccess: true,
    enforcement: "managed",
  },
});
const capability = base.args[base.args.indexOf("--capability-sid") + 1];
const sddl = `D:(A;;GA;;;${capability})(A;;GA;;;${user})`;
const evidence: unknown[] = [];
for (const mode of ["host-default", "managed-default", "managed-explicit", "managed-repair"]) {
  const managed = mode !== "host-default";
  const result = await execute(
    managed ? base.program : program,
    managed ? base.args : [],
    workspace,
    15000,
    {
      ...base.env,
      ...(managed ? { DC_BOUNDARY_FILE: outside } : {}),
      ...(mode === "managed-explicit" || mode === "managed-repair" ? { DC_PIPE_SDDL: sddl } : {}),
      ...(mode === "managed-repair" ? { DC_PIPE_REPAIR: "1" } : {}),
    },
  );
  if (result.exitCode !== 0 || result.timedOut || result.outputExceeded)
    throw Error(`Diagnostic failed: ${mode}: ${JSON.stringify(result)}`);
  if (mode === "managed-default" && !result.stdout.includes("client access=c0040000 error=5"))
    throw Error("Expected access-denied baseline did not reproduce");
  if (
    mode !== "managed-default" &&
    (!result.stdout.includes("ok access=c0040000") ||
      !result.stdout.includes("roundtrip=ping/pong"))
  )
    throw Error(`Pipe proof failed: ${mode}`);
  if (managed && !result.stdout.includes("outside file write denied="))
    throw Error(`Boundary proof failed: ${mode}`);
  evidence.push({ mode, ...result });
  console.log(`${mode}: expected result verified`);
}
if ((await readFile(outside, "utf8")) !== "protected") throw Error("Outside fixture was modified");
await writeFile(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(`Evidence: ${path.join(root, "evidence.json")}`);
