import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { toErrorMessage } from "@dreamcode/shared";

export type ManagedProcessState =
  | "starting"
  | "running"
  | "exited"
  | "stopped"
  | "failed"
  | "orphaned";

export interface ProcessScope {
  sessionId: string;
  sessionDir: string;
  workspaceRoot: string;
}

export interface ProcessStartInput {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label?: string;
  signal?: AbortSignal;
}

export interface ManagedProcessInfo {
  processId: string;
  state: ManagedProcessState;
  alive: boolean;
  program: string;
  args: string[];
  cwd: string;
  label?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
  stopRequested: boolean;
  terminationUncertain?: boolean;
  logsTruncated?: { stdout: boolean; stderr: boolean };
}

export interface ProcessLogCursor {
  stdoutOffset: number;
  stderrOffset: number;
}

export interface ProcessLogsResult {
  processId: string;
  state: ManagedProcessState;
  stdout: ProcessLogChunk;
  stderr: ProcessLogChunk;
  nextCursor: ProcessLogCursor;
  hasMore: boolean;
  logsTruncated: { stdout: boolean; stderr: boolean };
}

interface ProcessLogChunk {
  text: string;
  startOffset: number;
  nextOffset: number;
  endOffset: number;
}

export interface ProcessStopResult {
  processId: string;
  previousState: ManagedProcessState;
  state: ManagedProcessState;
  exitCode?: number;
  signal?: string;
  forced: boolean;
  terminationUncertain: boolean;
}

export interface ProcessSupervisorOptions {
  maxActivePerSession?: number;
  maxActiveGlobal?: number;
  maxLogBytesPerStream?: number;
  defaultStopGraceMs?: number;
}

interface ProcessRecord extends ManagedProcessInfo {
  scope: ProcessScope;
  child?: ChildProcess;
  directory: string;
  stdoutPath: string;
  stderrPath: string;
  metadataPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutWrite: Promise<void>;
  stderrWrite: Promise<void>;
  metadataWrite: Promise<void>;
  closePromise: Promise<void>;
  resolveClose: () => void;
}

const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;

export class ProcessSupervisor {
  readonly #records = new Map<string, ProcessRecord>();
  readonly #maxActivePerSession: number;
  readonly #maxActiveGlobal: number;
  readonly #maxLogBytesPerStream: number;
  readonly #defaultStopGraceMs: number;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.#maxActivePerSession = options.maxActivePerSession ?? 4;
    this.#maxActiveGlobal = options.maxActiveGlobal ?? 16;
    this.#maxLogBytesPerStream = options.maxLogBytesPerStream ?? DEFAULT_MAX_LOG_BYTES;
    this.#defaultStopGraceMs = options.defaultStopGraceMs ?? 3000;
  }

  async start(scope: ProcessScope, input: ProcessStartInput): Promise<ManagedProcessInfo> {
    if (input.signal?.aborted) throw processError("start_aborted", "Process start was aborted.");
    this.#assertCapacity(scope.sessionId);

    const processId = `proc_${randomUUID().replaceAll("-", "")}`;
    const directory = path.join(scope.sessionDir, "processes", processId);
    const startedAt = new Date().toISOString();
    let resolveClose: () => void = () => undefined;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const record: ProcessRecord = {
      processId,
      state: "starting",
      alive: false,
      program: input.program,
      args: [...input.args],
      cwd: input.cwd,
      label: input.label,
      startedAt,
      stopRequested: false,
      scope: { ...scope },
      directory,
      stdoutPath: path.join(directory, "stdout.log"),
      stderrPath: path.join(directory, "stderr.log"),
      metadataPath: path.join(directory, "metadata.json"),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutWrite: Promise.resolve(),
      stderrWrite: Promise.resolve(),
      metadataWrite: Promise.resolve(),
      closePromise,
      resolveClose,
    };
    this.#records.set(processId, record);

    let child: ChildProcess;
    try {
      await mkdir(directory, { recursive: true });
      child = spawn(input.program, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      record.child = child;
      this.#captureStream(record, "stdout", child.stdout);
      this.#captureStream(record, "stderr", child.stderr);
      this.#observeClose(record);
      await waitForSpawn(child, input.signal);
      if (!record.endedAt) {
        record.state = "running";
        record.alive = true;
      }
      await this.#persist(record);
      return publicInfo(record);
    } catch (error) {
      record.state = "failed";
      record.alive = false;
      record.endedAt = new Date().toISOString();
      record.resolveClose();
      await this.#persist(record).catch(() => undefined);
      this.#records.delete(processId);
      if (record.child) terminateProcessTree(record.child, true);
      throw error;
    }
  }

  async status(scope: ProcessScope, processId: string): Promise<ManagedProcessInfo> {
    const record = await this.#ownedRecord(scope, processId);
    await Promise.all([record.stdoutWrite, record.stderrWrite]);
    return publicInfo(record);
  }

  async logs(
    scope: ProcessScope,
    processId: string,
    cursor: ProcessLogCursor,
    maxBytes: number,
  ): Promise<ProcessLogsResult> {
    const record = await this.#ownedRecord(scope, processId);
    await Promise.all([record.stdoutWrite, record.stderrWrite]);
    const stdoutBudget = Math.ceil(maxBytes / 2);
    const stderrBudget = Math.floor(maxBytes / 2);
    const [stdout, stderr] = await Promise.all([
      readLogChunk(record.stdoutPath, cursor.stdoutOffset, stdoutBudget),
      readLogChunk(record.stderrPath, cursor.stderrOffset, stderrBudget),
    ]);
    return {
      processId,
      state: record.state,
      stdout,
      stderr,
      nextCursor: { stdoutOffset: stdout.nextOffset, stderrOffset: stderr.nextOffset },
      hasMore: stdout.nextOffset < stdout.endOffset || stderr.nextOffset < stderr.endOffset,
      logsTruncated: {
        stdout: Boolean(record.logsTruncated?.stdout),
        stderr: Boolean(record.logsTruncated?.stderr),
      },
    };
  }

  async stop(
    scope: ProcessScope,
    processId: string,
    options: { graceMs?: number; force?: boolean } = {},
  ): Promise<ProcessStopResult> {
    const record = await this.#ownedRecord(scope, processId);
    const previousState = record.state;
    if (!record.alive || !record.child) {
      return {
        processId,
        previousState,
        state: record.state,
        exitCode: record.exitCode,
        signal: record.signal,
        forced: false,
        terminationUncertain: Boolean(record.terminationUncertain),
      };
    }

    record.stopRequested = true;
    await this.#persist(record);
    const graceMs = options.graceMs ?? this.#defaultStopGraceMs;
    let forced = Boolean(options.force);
    terminateProcessTree(record.child, forced);
    if (!forced) {
      const closed = await waitForClose(record.closePromise, graceMs);
      if (!closed && record.alive) {
        forced = true;
        terminateProcessTree(record.child, true);
      }
    }
    if (record.alive) {
      const closed = await waitForClose(record.closePromise, 2000);
      if (!closed) record.terminationUncertain = true;
    }
    await Promise.all([record.stdoutWrite, record.stderrWrite]);
    await this.#persist(record);
    return {
      processId,
      previousState,
      state: record.state,
      exitCode: record.exitCode,
      signal: record.signal,
      forced,
      terminationUncertain: Boolean(record.terminationUncertain),
    };
  }

  async stopSession(sessionId: string): Promise<void> {
    const records = [...this.#records.values()].filter(
      (record) => record.scope.sessionId === sessionId && record.alive,
    );
    await Promise.all(
      records.map((record) =>
        this.stop(record.scope, record.processId, { graceMs: this.#defaultStopGraceMs }).catch(
          () => undefined,
        ),
      ),
    );
  }

  async stopWorkspace(workspaceRoot: string): Promise<void> {
    const resolved = path.resolve(workspaceRoot);
    const records = [...this.#records.values()].filter(
      (record) => record.alive && path.resolve(record.scope.workspaceRoot) === resolved,
    );
    await Promise.all(
      records.map((record) =>
        this.stop(record.scope, record.processId, { graceMs: this.#defaultStopGraceMs }).catch(
          () => undefined,
        ),
      ),
    );
  }

  async dispose(): Promise<void> {
    const records = [...this.#records.values()].filter((record) => record.alive);
    await Promise.all(
      records.map((record) =>
        this.stop(record.scope, record.processId, { graceMs: this.#defaultStopGraceMs }).catch(
          () => undefined,
        ),
      ),
    );
  }

  hasActiveProcess(workspaceRoot: string): boolean {
    const resolved = path.resolve(workspaceRoot);
    return [...this.#records.values()].some(
      (record) => record.alive && path.resolve(record.scope.workspaceRoot) === resolved,
    );
  }

  #assertCapacity(sessionId: string): void {
    const active = [...this.#records.values()].filter(
      (record) => record.alive || record.state === "starting",
    );
    if (active.length >= this.#maxActiveGlobal) {
      throw processError(
        "process_limit_exceeded",
        "The host long-running process limit was reached.",
      );
    }
    if (
      active.filter((record) => record.scope.sessionId === sessionId).length >=
      this.#maxActivePerSession
    ) {
      throw processError(
        "process_limit_exceeded",
        "The session long-running process limit was reached.",
      );
    }
  }

  async #ownedRecord(scope: ProcessScope, processId: string): Promise<ProcessRecord> {
    const record = this.#records.get(processId) ?? (await this.#loadRecord(scope, processId));
    if (
      !record ||
      record.scope.sessionId !== scope.sessionId ||
      path.resolve(record.scope.workspaceRoot) !== path.resolve(scope.workspaceRoot)
    ) {
      throw processError(
        "process_not_found",
        "No managed process with that ID exists in this session.",
      );
    }
    return record;
  }

  async #loadRecord(scope: ProcessScope, processId: string): Promise<ProcessRecord | undefined> {
    if (!/^proc_[a-f0-9]{32}$/.test(processId)) return undefined;
    const directory = path.join(scope.sessionDir, "processes", processId);
    try {
      const saved = JSON.parse(
        await readFile(path.join(directory, "metadata.json"), "utf8"),
      ) as ManagedProcessInfo & { owner?: { sessionId: string; workspaceRoot: string } };
      if (
        saved.owner &&
        (saved.owner.sessionId !== scope.sessionId ||
          path.resolve(saved.owner.workspaceRoot) !== path.resolve(scope.workspaceRoot))
      ) {
        return undefined;
      }
      let resolveClose: () => void = () => undefined;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      const record: ProcessRecord = {
        ...saved,
        state: saved.alive ? "orphaned" : saved.state,
        alive: false,
        scope: { ...scope },
        directory,
        stdoutPath: path.join(directory, "stdout.log"),
        stderrPath: path.join(directory, "stderr.log"),
        metadataPath: path.join(directory, "metadata.json"),
        stdoutBytes: await fileSize(path.join(directory, "stdout.log")),
        stderrBytes: await fileSize(path.join(directory, "stderr.log")),
        stdoutWrite: Promise.resolve(),
        stderrWrite: Promise.resolve(),
        metadataWrite: Promise.resolve(),
        closePromise,
        resolveClose,
      };
      resolveClose();
      this.#records.set(processId, record);
      if (saved.alive) await this.#persist(record);
      return record;
    } catch {
      return undefined;
    }
  }

  #captureStream(
    record: ProcessRecord,
    stream: "stdout" | "stderr",
    source: NodeJS.ReadableStream | null,
  ): void {
    source?.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const bytesField = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
      const writeField = stream === "stdout" ? "stdoutWrite" : "stderrWrite";
      const logPath = stream === "stdout" ? record.stdoutPath : record.stderrPath;
      const remaining = Math.max(0, this.#maxLogBytesPerStream - record[bytesField]);
      const visible = chunk.subarray(0, remaining);
      if (visible.length < chunk.length) {
        record.logsTruncated = {
          stdout: false,
          stderr: false,
          ...record.logsTruncated,
          [stream]: true,
        };
      }
      if (!visible.length) return;
      record[bytesField] += visible.length;
      record[writeField] = record[writeField]
        .then(() => appendFile(logPath, visible))
        .catch((error) => {
          record.logsTruncated = {
            stdout: false,
            stderr: false,
            ...record.logsTruncated,
            [stream]: true,
          };
          void error;
        });
    });
  }

  #observeClose(record: ProcessRecord): void {
    record.child?.once("close", (code, signal) => {
      if (record.state === "failed") {
        record.resolveClose();
        return;
      }
      record.alive = false;
      record.endedAt = new Date().toISOString();
      record.exitCode = code ?? undefined;
      record.signal = signal ?? undefined;
      record.state = record.stopRequested ? "stopped" : "exited";
      record.resolveClose();
      void Promise.all([record.stdoutWrite, record.stderrWrite]).then(() => this.#persist(record));
    });
  }

  async #persist(record: ProcessRecord): Promise<void> {
    record.metadataWrite = record.metadataWrite.then(async () => {
      await mkdir(record.directory, { recursive: true });
      const temporaryPath = `${record.metadataPath}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify(
          {
            ...publicInfo(record),
            owner: {
              sessionId: record.scope.sessionId,
              workspaceRoot: record.scope.workspaceRoot,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await rename(temporaryPath, record.metadataPath);
    });
    await record.metadataWrite;
  }
}

function publicInfo(record: ProcessRecord): ManagedProcessInfo {
  return {
    processId: record.processId,
    state: record.state,
    alive: record.alive,
    program: record.program,
    args: [...record.args],
    cwd: record.cwd,
    label: record.label,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    stopRequested: record.stopRequested,
    terminationUncertain: record.terminationUncertain,
    logsTruncated: record.logsTruncated,
  };
}

async function waitForSpawn(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(processError("start_aborted", "Process start was aborted."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () =>
      finish(() => reject(processError("start_aborted", "Process start was aborted.")));
    child.once("spawn", () => finish(resolve));
    child.once("error", (error) =>
      finish(() =>
        reject(
          processError(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "program_not_found"
              : "spawn_failed",
            toErrorMessage(error),
          ),
        ),
      ),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readLogChunk(
  filePath: string,
  offset: number,
  maxBytes: number,
): Promise<ProcessLogChunk> {
  const endOffset = await fileSize(filePath);
  const startOffset = Math.min(Math.max(0, offset), endOffset);
  const length = Math.min(maxBytes, endOffset - startOffset);
  if (!length) return { text: "", startOffset, nextOffset: startOffset, endOffset };
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, startOffset);
    const safeBytesRead = completeUtf8PrefixLength(buffer.subarray(0, bytesRead));
    return {
      text: buffer.subarray(0, safeBytesRead).toString("utf8"),
      startOffset,
      nextOffset: startOffset + safeBytesRead,
      endOffset,
    };
  } finally {
    await handle.close();
  }
}

function completeUtf8PrefixLength(buffer: Buffer): number {
  if (!buffer.length) return 0;
  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0 && (buffer[leadIndex]! & 0xc0) === 0x80) leadIndex -= 1;
  if (leadIndex < 0) return 0;
  const lead = buffer[leadIndex]!;
  const expectedLength =
    (lead & 0x80) === 0
      ? 1
      : (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : (lead & 0xf8) === 0xf0
            ? 4
            : 1;
  return buffer.length - leadIndex < expectedLength ? leadIndex : buffer.length;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function waitForClose(closePromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    closePromise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function terminateProcessTree(child: ChildProcess, force: boolean): void {
  if (!child.pid) {
    child.kill(force ? "SIGKILL" : "SIGTERM");
    return;
  }
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])];
    const killer = spawn("taskkill", args, { shell: false, windowsHide: true, stdio: "ignore" });
    killer.once("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function processError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
