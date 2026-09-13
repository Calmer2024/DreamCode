import { access, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxPolicy } from "@dreamcode/shared";

export interface SpawnSpec {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  backend: "direct" | "linux-bwrap" | "windows-restricted-token";
}

function sandboxEnvironment(
  input: NodeJS.ProcessEnv,
  temporaryRoot: string | undefined,
): NodeJS.ProcessEnv {
  if (!temporaryRoot) return input;
  return {
    ...input,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    XDG_CACHE_HOME: path.join(temporaryRoot, ".cache"),
    npm_config_cache: path.join(temporaryRoot, ".npm-cache"),
  };
}

export async function prepareSandboxedSpawn(input: {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  policy: SandboxPolicy;
}): Promise<SpawnSpec> {
  if (input.policy.enforcement === "disabled") {
    return { ...input, backend: "direct" };
  }
  const temporaryRoot = input.policy.writableRoots.at(-1);
  if (temporaryRoot) await mkdir(temporaryRoot, { recursive: true });
  if (process.platform === "linux") return prepareLinux(input, temporaryRoot);
  if (process.platform === "win32") return prepareWindows(input, temporaryRoot);
  throw new SandboxUnavailableError(`No managed DreamCode file sandbox backend exists for ${process.platform}.`);
}

function prepareLinux(
  input: Parameters<typeof prepareSandboxedSpawn>[0],
  temporaryRoot: string | undefined,
): SpawnSpec {
  const args = [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc",
    "--unshare-uts", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
  ];
  if (input.policy.mode === "read-only") {
    args.push("--tmpfs", "/tmp");
  } else {
    for (const root of input.policy.writableRoots) args.push("--bind", root, root);
  }
  args.push("--chdir", input.cwd, "--", input.program, ...input.args);
  return {
    program: process.env.DREAMCODE_BWRAP_PATH || "bwrap",
    args,
    cwd: input.cwd,
    env: {
      ...sandboxEnvironment(input.env, temporaryRoot),
      ...(input.policy.mode === "read-only"
        ? { TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" }
        : temporaryRoot
          ? { TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot }
          : {}),
      DREAMCODE_SANDBOX: "linux-bwrap",
    },
    backend: "linux-bwrap",
  };
}

async function prepareWindows(
  input: Parameters<typeof prepareSandboxedSpawn>[0],
  temporaryRoot: string | undefined,
): Promise<SpawnSpec> {
  const helper = await resolveWindowsHelper();
  const capabilitySid = workspaceCapabilitySid(
    `${input.policy.mode}:${input.policy.writableRoots[0] ?? input.cwd}`,
  );
  const args = ["--mode", input.policy.mode, "--capability-sid", capabilitySid];
  for (const root of input.policy.writableRoots) args.push("--writable-root", root);
  args.push("--cwd", input.cwd, "--", input.program, ...input.args);
  return {
    program: helper,
    args,
    cwd: input.cwd,
    env: {
      ...sandboxEnvironment(input.env, temporaryRoot),
      DREAMCODE_SANDBOX: "windows-restricted-token",
    },
    backend: "windows-restricted-token",
  };
}

function workspaceCapabilitySid(policyKey: string): string {
  const digest = createHash("sha256").update(policyKey.toLowerCase()).digest();
  const components = Array.from({ length: 4 }, (_, index) => digest.readUInt32LE(index * 4));
  return `S-1-5-21-${components.join("-")}`;
}

async function resolveWindowsHelper(): Promise<string> {
  const candidates = [
    process.env.DREAMCODE_WINDOWS_SANDBOX_HELPER,
    path.join(path.dirname(process.execPath), "dreamcode-windows-sandbox.exe"),
    path.join(process.cwd(), "native", "windows-sandbox", "target", "release", "dreamcode-windows-sandbox.exe"),
    path.resolve(process.cwd(), "..", "..", "native", "windows-sandbox", "target", "release", "dreamcode-windows-sandbox.exe"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try next */ }
  }
  throw new SandboxUnavailableError("The Windows DreamCode file sandbox helper is unavailable.");
}

export class SandboxUnavailableError extends Error {
  readonly code = "sandbox_unavailable";
  constructor(message: string) { super(message); this.name = "SandboxUnavailableError"; }
}
