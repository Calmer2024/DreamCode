import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";

export interface TerminalOutput {
  terminalId: string;
  stream: "stdout";
  text: string;
}

export class DesktopTerminalManager {
  private readonly terminals = new Map<string, IPty>();

  start(cwd: string, emit: (output: TerminalOutput) => void): { terminalId: string } {
    const terminalId = `terminal_${randomUUID()}`;
    const windows = process.platform === "win32";
    const options = {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env: cleanEnvironment(),
      useConpty: windows,
    };
    const terminal = windows
      ? spawnWindowsTerminal(options)
      : spawn(process.env.SHELL ?? "/bin/sh", ["-i"], options);
    this.terminals.set(terminalId, terminal);
    terminal.onData((text) => emit({ terminalId, stream: "stdout", text }));
    terminal.onExit(() => this.terminals.delete(terminalId));
    return { terminalId };
  }

  write(terminalId: string, data: string): void {
    this.terminals.get(terminalId)?.write(data);
  }

  resize(terminalId: string, columns: number, rows: number): void {
    this.terminals.get(terminalId)?.resize(columns, rows);
  }

  close(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    this.terminals.delete(terminalId);
    terminal.kill();
  }

  dispose(): void {
    for (const terminalId of this.terminals.keys()) this.close(terminalId);
  }
}

function spawnWindowsTerminal(options: Parameters<typeof spawn>[2]): IPty {
  let lastError: unknown;
  for (const shell of ["pwsh.exe", "powershell.exe"]) {
    try {
      return spawn(shell, ["-NoLogo"], options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法启动 PowerShell。");
}

function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
