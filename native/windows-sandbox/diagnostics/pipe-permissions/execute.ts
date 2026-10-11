import { spawn } from "node:child_process";
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
}

export async function execute(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        // rustup resolves installed toolchains from the user runtime in local-trusted mode.
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        RUSTUP_HOME: process.env.RUSTUP_HOME,
        CARGO_HOME: process.env.CARGO_HOME,
        LANG: "C.UTF-8",
        ...extraEnv,
      },
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      outputExceeded = false;
    const stop = () => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => child.kill());
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) {
        stdout = stdout.slice(0, 2_000_000);
        outputExceeded = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) {
        stderr = stderr.slice(0, 2_000_000);
        outputExceeded = true;
        stop();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, outputExceeded });
    });
  });
}
