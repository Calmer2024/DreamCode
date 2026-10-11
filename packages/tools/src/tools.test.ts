import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, ToolRegistry } from "./index";

describe("builtin tools", () => {
  const shellToolName = process.platform === "win32" ? "pwsh" : "bash";
  const shellCommand = (command: string) => ({ command, description: "test command" });

  it("atomically replaces dynamic namespaces while existing snapshots stay stable", () => {
    const registry = new ToolRegistry();
    const tool = (name: string) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      risk: { tags: [] },
      execute: async () => ({ toolCallId: "test", status: "success" as const, summary: name }),
    });
    registry.replaceNamespace("mcp:one", [tool("mcp__one__old")]);
    const snapshot = registry.snapshot();

    registry.replaceNamespace("mcp:one", [tool("mcp__one__new")]);
    expect(registry.get("mcp__one__old")).toBeUndefined();
    expect(registry.get("mcp__one__new")).toBeDefined();
    expect(snapshot.get("mcp__one__old")).toBeDefined();
    expect(snapshot.get("mcp__one__new")).toBeUndefined();

    expect(() => registry.replaceNamespace("mcp:two", [tool("mcp__one__new")])).toThrow();
    expect(registry.get("mcp__one__new")).toBeDefined();
  });

  it("emits OpenAI-compatible object schemas for model tools", () => {
    const specs = createDefaultToolRegistry().toModelSpecs();

    for (const spec of specs) {
      expect(spec.inputSchema.type).toBe("object");
      expect(spec.inputSchema).not.toHaveProperty("$ref");
      expect(spec.inputSchema).not.toHaveProperty("$schema");
      expect(spec.inputSchema).not.toHaveProperty("definitions");
      expect(JSON.stringify(spec.inputSchema)).not.toContain('"$ref"');
    }
    const registry = createDefaultToolRegistry();
    expect(registry.list().map((tool) => tool.name)).not.toContain(["file", "list"].join("."));
    const readSpec = registry.toModelSpecs().find((spec) => spec.name === "file.read");
    expect(Object.keys(readSpec?.inputSchema.properties as object)).toEqual([
      "file_path",
      "offset",
      "limit",
    ]);
  });

  it("reads exact line-numbered windows and reports the total line count", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-read-"));
    await writeFile(path.join(workspaceRoot, "example.txt"), "one\ntwo\nthree\n", "utf8");
    const result = await createDefaultToolRegistry().get("file.read")!.execute(
      { file_path: "example.txt", offset: 2, limit: 1 },
      {
        workspaceRoot,
        sessionDir: workspaceRoot,
        sessionId: "read_window",
        mode: "workspace-write",
        toolCallId: "read_window",
      },
    );
    expect(result.data).toEqual({
      path: "example.txt",
      offset: 2,
      lines: [{ number: 2, text: "two" }],
      totalLines: 3,
    });
    expect(result.summary).toContain("offset=3");
  });

  it("reads and searches absolute paths outside the workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-local-workspace-"));
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-local-external-"));
    const externalFile = path.join(externalRoot, "guide.txt");
    await writeFile(externalFile, "external needle\n", "utf8");
    const registry = createDefaultToolRegistry();
    const context = {
      workspaceRoot,
      sessionDir: workspaceRoot,
      mode: "workspace-write" as const,
    };

    const read = await registry
      .get("file.read")!
      .execute({ file_path: externalFile }, { ...context, toolCallId: "external_read" });
    const glob = await registry
      .get("search.glob")!
      .execute(
        { pattern: "*.txt", path: externalRoot },
        { ...context, toolCallId: "external_glob" },
      );
    const grep = await registry
      .get("search.grep")!
      .execute(
        { pattern: "needle", path: externalRoot },
        { ...context, toolCallId: "external_grep" },
      );

    expect((read.data as { path: string }).path).toBe(path.resolve(externalFile));
    expect((glob.data as { paths: string[] }).paths).toContain(path.resolve(externalFile));
    expect((grep.data as { matches: Array<{ path: string }> }).matches[0]?.path).toBe(
      path.resolve(externalFile),
    );
  });

  it("excludes sensitive files from broad searches", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-sensitive-search-"));
    await writeFile(path.join(workspaceRoot, "visible.txt"), "needle", "utf8");
    await writeFile(path.join(workspaceRoot, ".env"), "TOKEN=needle", "utf8");
    const registry = createDefaultToolRegistry();
    const context = { workspaceRoot, sessionDir: workspaceRoot, mode: "workspace-write" as const };

    const glob = await registry
      .get("search.glob")!
      .execute({ pattern: "*" }, { ...context, toolCallId: "sensitive_glob" });
    const grep = await registry
      .get("search.grep")!
      .execute({ pattern: "needle" }, { ...context, toolCallId: "sensitive_grep" });

    expect((glob.data as { paths: string[] }).paths).toContain("visible.txt");
    expect((glob.data as { paths: string[] }).paths).not.toContain(".env");
    expect((grep.data as { matches: Array<{ path: string }> }).matches).toEqual([
      expect.objectContaining({ path: "visible.txt" }),
    ]);
  });

  it("discovers ignored hidden files at any depth and excludes VCS metadata", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-glob-"));
    await mkdir(path.join(workspaceRoot, "src", "nested"), { recursive: true });
    await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(path.join(workspaceRoot, "src", "nested", "deep.ts"), "deep", "utf8");
    await writeFile(path.join(workspaceRoot, "ignored.ts"), "ignored", "utf8");
    await writeFile(path.join(workspaceRoot, ".hidden.ts"), "hidden", "utf8");
    await writeFile(path.join(workspaceRoot, ".git", "private.ts"), "private", "utf8");
    const result = await createDefaultToolRegistry()
      .get("search.glob")!
      .execute(
        { pattern: "*.ts" },
        { workspaceRoot, sessionDir: workspaceRoot, mode: "workspace-write", toolCallId: "glob" },
      );
    const paths = (result.data as { paths: string[] }).paths.map((item) =>
      item.replaceAll("\\", "/"),
    );
    expect(paths).toEqual(
      expect.arrayContaining(["src/nested/deep.ts", "ignored.ts", ".hidden.ts"]),
    );
    expect(paths).not.toContain(".git/private.ts");
  });

  it("returns grep locations without colon-based parsing", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-grep-"));
    await writeFile(path.join(workspaceRoot, "colon.txt"), "prefix:value:needle:suffix\n", "utf8");
    const result = await createDefaultToolRegistry()
      .get("search.grep")!
      .execute(
        { pattern: "needle", include: "*.txt" },
        { workspaceRoot, sessionDir: workspaceRoot, mode: "workspace-write", toolCallId: "grep" },
      );
    expect(result.data).toEqual({
      matches: [{ path: "colon.txt", lineNumber: 1, line: "prefix:value:needle:suffix" }],
    });
  });

  it("patches a workspace file and records a changed file", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-tools-"));
    await writeFile(path.join(workspaceRoot, "example.txt"), "hello old world\n", "utf8");
    const registry = createDefaultToolRegistry();
    const tool = registry.get("file.patch");
    expect(tool).toBeDefined();

    const context = {
      workspaceRoot,
      sessionDir: workspaceRoot,
      sessionId: "patch_observation",
      mode: "workspace-write" as const,
    };
    await registry
      .get("file.read")!
      .execute({ file_path: "example.txt" }, { ...context, toolCallId: "call_read" });

    const result = await tool!.execute(
      { path: "example.txt", search: "old", replace: "new" },
      { ...context, toolCallId: "call_patch" },
    );

    expect(result.status).toBe("success");
    expect(result.changedFiles?.[0]?.path).toBe("example.txt");
    expect(result.changedFiles?.[0]?.beforeSnapshotRef).toBeDefined();
    expect(result.changedFiles?.[0]?.patchRef).toBeDefined();
    await expect(readFile(path.join(workspaceRoot, "example.txt"), "utf8")).resolves.toContain(
      "new world",
    );
    await expect(readFile(result.changedFiles![0]!.beforeSnapshotRef!, "utf8")).resolves.toContain(
      "old world",
    );
  });

  it("rejects a patch when the file changed after it was read", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-stale-"));
    const target = path.join(workspaceRoot, "example.txt");
    await writeFile(target, "old", "utf8");
    const registry = createDefaultToolRegistry();
    const context = {
      workspaceRoot,
      sessionDir: workspaceRoot,
      sessionId: "stale_patch",
      mode: "workspace-write" as const,
    };
    await registry
      .get("file.read")!
      .execute({ file_path: "example.txt" }, { ...context, toolCallId: "stale_read" });
    await writeFile(target, "external change", "utf8");
    const result = await registry
      .get("file.patch")!
      .execute(
        { path: "example.txt", search: "external", replace: "internal" },
        { ...context, toolCallId: "stale_patch" },
      );
    expect(result).toMatchObject({ status: "error", error: { code: "stale_file_version" } });
    await expect(readFile(target, "utf8")).resolves.toBe("external change");
  });

  it("runs multiple verification commands through separate shell calls", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-shell-many-"));
    const tool = createDefaultToolRegistry().get(shellToolName)!;
    const context = { workspaceRoot, sessionDir: workspaceRoot, mode: "workspace-write" as const };
    const first = await tool.execute(
      shellCommand(process.platform === "win32" ? "Write-Output one" : "printf one"),
      { ...context, toolCallId: "shell_one" },
    );
    const second = await tool.execute(
      shellCommand(process.platform === "win32" ? "Write-Output two" : "printf two"),
      { ...context, toolCallId: "shell_two" },
    );
    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
  });

  it("terminates timed-out shell commands", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-shell-"));
    const tool = createDefaultToolRegistry().get(shellToolName);
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { ...shellCommand('node -e "setTimeout(() => {}, 2000)"'), timeoutMs: 200 },
      {
        workspaceRoot,
        sessionDir: workspaceRoot,
        mode: "workspace-write",
        toolCallId: "call_shell",
      },
    );

    expect(result.status).toBe("cancelled");
    expect((result.data as { timedOut?: boolean }).timedOut).toBe(true);
  });

  it("runs a platform shell command with an explicit environment", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-shell-"));
    const registry = createDefaultToolRegistry();
    const command =
      process.platform === "win32"
        ? "Write-Output $env:DREAMCODE_PROCESS_TEST"
        : "printf $DREAMCODE_PROCESS_TEST";
    const result = await registry
      .get(shellToolName)!
      .execute(
        { ...shellCommand(command), env: { DREAMCODE_PROCESS_TEST: "structured" } },
        {
          workspaceRoot,
          sessionDir: workspaceRoot,
          mode: "workspace-write",
          toolCallId: "process",
        },
      );
    expect(result.status).toBe("success");
    expect(result.execution).toMatchObject({ outcome: "exited_zero", started: true, exitCode: 0 });
    expect(result.streams?.stdout.preview.trim()).toBe("structured");
  });

  it("returns structured process failures and bounded output previews", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-output-"));
    const tool = createDefaultToolRegistry().get(shellToolName)!;
    const failed = await tool.execute(shellCommand("exit 7"), {
      workspaceRoot,
      sessionDir: workspaceRoot,
      mode: "workspace-write",
      toolCallId: "failed",
    });
    expect(failed.status).toBe("error");
    expect(failed.error).toMatchObject({
      category: "execution",
      reason: "nonzero_exit",
      retryable: false,
    });

    const large = await tool.execute(
      shellCommand(
        process.platform === "win32"
          ? 'Write-Host ("x" * 9000) -NoNewline'
          : "printf 'x%.0s' {1..9000}",
      ),
      { workspaceRoot, sessionDir: workspaceRoot, mode: "workspace-write", toolCallId: "large" },
    );
    expect(Buffer.byteLength(large.streams!.stdout.preview)).toBeLessThanOrEqual(4096);
    expect(large.streams?.stdout).toMatchObject({ bytes: 9000, truncated: true });
    expect(large.streams?.stdout.artifactRef).toMatch(/^artifact:\/\//);
  });

  it("starts, observes, reads, and stops a managed long-running process", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-managed-process-"));
    const sessionDir = path.join(workspaceRoot, "session");
    const registry = createDefaultToolRegistry();
    const context = {
      workspaceRoot,
      sessionDir,
      sessionId: "session_managed",
      mode: "workspace-write" as const,
    };

    try {
      const started = await registry.get(shellToolName)!.execute(
        {
          command:
            'node -e \'console.log("managed-ready"); setInterval(() => console.error("managed-tick"), 25)\'',
          description: "test-server",
          run_in_background: true,
        },
        { ...context, toolCallId: "managed_start" },
      );
      expect(started.status).toBe("success");
      expect(started.execution).toMatchObject({ outcome: "background_started", started: true });
      const processId = (started.data as { jobId: string }).jobId;

      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await registry
        .get("job_output")!
        .execute({ job_id: processId }, { ...context, toolCallId: "managed_status" });
      expect(status.data).toMatchObject({ job: { id: processId, status: "running" } });

      const nextTurnRegistry = createDefaultToolRegistry({
        processSupervisor: registry.processSupervisor,
      });
      const nextTurnStatus = await nextTurnRegistry
        .get("job_output")!
        .execute({ job_id: processId }, { ...context, toolCallId: "managed_status_next_turn" });
      expect(nextTurnStatus.data).toMatchObject({ job: { id: processId, status: "running" } });

      const logs = await registry
        .get("job_output")!
        .execute(
          { job_id: processId, wait: true, timeout_ms: 1000 },
          { ...context, toolCallId: "managed_logs" },
        );
      expect((logs.data as { text: string }).text).toContain("managed-ready");
      expect(
        (logs.data as { nextCursor: { stdoutOffset: number } }).nextCursor.stdoutOffset,
      ).toBeGreaterThan(0);
      const nextCursor = (
        logs.data as { nextCursor: { stdoutOffset: number; stderrOffset: number } }
      ).nextCursor;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const incrementalLogs = await registry
        .get("job_output")!
        .execute(
          { job_id: processId, cursor: nextCursor },
          { ...context, toolCallId: "managed_logs_incremental" },
        );
      expect((incrementalLogs.data as { text: string }).text).not.toContain("managed-ready");

      const stopped = await registry
        .get("job_kill")!
        .execute(
          { job_id: processId, reason: "test complete" },
          { ...context, toolCallId: "managed_stop" },
        );
      expect(stopped.status).toBe("success");
      expect(stopped.data).toMatchObject({ processId, state: "stopped" });

      const stoppedAgain = await registry
        .get("job_kill")!
        .execute({ job_id: processId }, { ...context, toolCallId: "managed_stop_again" });
      expect(stoppedAgain.status).toBe("success");
    } finally {
      await registry.processSupervisor.dispose();
    }
  });

  it("isolates managed process IDs between sessions", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-process-scope-"));
    const registry = createDefaultToolRegistry();
    try {
      const started = await registry.get(shellToolName)!.execute(
        {
          command: 'node -e "setInterval(() => {}, 1000)"',
          description: "scope test",
          run_in_background: true,
        },
        {
          workspaceRoot,
          sessionDir: path.join(workspaceRoot, "session-a"),
          sessionId: "session_a",
          mode: "workspace-write",
          toolCallId: "scope_start",
        },
      );
      const processId = (started.data as { jobId: string }).jobId;
      const foreign = await registry.get("job_output")!.execute(
        { job_id: processId },
        {
          workspaceRoot,
          sessionDir: path.join(workspaceRoot, "session-b"),
          sessionId: "session_b",
          mode: "workspace-write",
          toolCallId: "scope_status",
        },
      );
      expect(foreign).toMatchObject({
        status: "error",
        error: { code: "process_not_found" },
      });
    } finally {
      await registry.processSupervisor.dispose();
    }
  });

  it("retains status and logs for fast exits and classifies start failures", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-process-exit-"));
    const registry = createDefaultToolRegistry();
    const context = {
      workspaceRoot,
      sessionDir: path.join(workspaceRoot, "session"),
      sessionId: "session_exit",
      mode: "workspace-write" as const,
    };
    try {
      const started = await registry.get(shellToolName)!.execute(
        {
          command: "node -e 'console.log(\"before-exit\"); process.exit(7)'",
          description: "fast exit",
          run_in_background: true,
        },
        { ...context, toolCallId: "fast_start" },
      );
      expect(started.status).toBe("success");
      const processId = (started.data as { jobId: string }).jobId;
      let status = await registry
        .get("job_output")!
        .execute(
          { job_id: processId, wait: true, timeout_ms: 1000 },
          { ...context, toolCallId: "fast_status_0" },
        );
      for (
        let attempt = 1;
        attempt <= 20 && (status.data as { alive: boolean }).alive;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = await registry
          .get("job_output")!
          .execute(
            { job_id: processId, wait: true, timeout_ms: 1000 },
            { ...context, toolCallId: `fast_status_${attempt}` },
          );
      }
      expect(status.data).toMatchObject({ job: { status: "exited" } });
      const logs = await registry
        .get("job_output")!
        .execute({ job_id: processId }, { ...context, toolCallId: "fast_logs" });
      expect((logs.data as { text: string }).text).toContain("before-exit");

      const missing = await registry
        .get(shellToolName)!
        .execute(
          { command: `definitely-missing-${Date.now()}`, description: "missing command" },
          { ...context, toolCallId: "missing_start" },
        );
      expect(missing).toMatchObject({
        status: "error",
        error: { code: "nonzero_exit" },
        execution: { outcome: "exited_nonzero", started: true },
      });
    } finally {
      await registry.processSupervisor.dispose();
    }
  });

  it("executes compound and stateful shell expressions", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-compound-shell-"));
    await mkdir(path.join(workspaceRoot, "nested"));
    const separator = process.platform === "win32" ? ";" : "&&";
    const command = `cd nested ${separator} node -e "console.log(process.cwd())"`;
    const result = await createDefaultToolRegistry()
      .get(shellToolName)!
      .execute(shellCommand(command), {
        workspaceRoot,
        sessionDir: workspaceRoot,
        sessionId: "compound_shell",
        mode: "workspace-write",
        toolCallId: "compound_shell",
      });
    expect(result.status).toBe("success");
    expect((result.data as { stdout: string }).stdout).toContain("nested");
  });

  it("propagates a native program exit code even when followed by shell output", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-native-exit-"));
    const registry = createDefaultToolRegistry();
    try {
      const command =
        process.platform === "win32"
          ? "node -e 'process.exit(7)'; Write-Output finished"
          : "node -e 'process.exit(7)'; printf finished";
      const result = await registry.get(shellToolName)!.execute(shellCommand(command), {
        workspaceRoot,
        sessionDir: workspaceRoot,
        mode: "workspace-write",
        toolCallId: "native_exit",
      });
      expect(result.status).toBe("error");
      expect(result.execution?.exitCode).toBe(7);
    } finally {
      await registry.processSupervisor.dispose();
    }
  });

  it("enforces file boundaries for compound shell expressions and read-only processes", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-sandbox-boundary-"));
    const inside = path.join(workspaceRoot, "inside.txt");
    const outside = path.join(
      path.dirname(workspaceRoot),
      `${path.basename(workspaceRoot)}-outside.txt`,
    );
    await writeFile(inside, "before", "utf8");
    await writeFile(outside, "outside", "utf8");
    const registry = createDefaultToolRegistry();
    const workspaceCommand =
      process.platform === "win32"
        ? `Set-Content -LiteralPath '${inside}' -Value inside; Set-Content -LiteralPath '${outside}' -Value escaped; Write-Output finished`
        : `printf inside > '${inside}'; printf escaped > '${outside}'; printf finished`;
    const workspaceResult = await registry
      .get(shellToolName)!
      .execute(shellCommand(workspaceCommand), {
        workspaceRoot,
        sessionDir: workspaceRoot,
        mode: "workspace-write",
        toolCallId: "workspace_boundary",
      });
    expect(workspaceResult).toMatchObject({
      status: "denied",
      execution: { outcome: "sandbox_denied", started: true },
      error: { code: "sandbox_denied", category: "permission", retryable: true },
      retry: {
        kind: "require_escalated",
        inputPatch: { sandbox_permissions: "require-escalated" },
        requiresApproval: true,
      },
    });
    await expect(readFile(inside, "utf8")).resolves.toContain("inside");
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");

    const readOnlyCommand =
      process.platform === "win32"
        ? `Set-Content -LiteralPath '${inside}' -Value changed`
        : `printf changed > '${inside}'`;
    const readOnlyResult = await registry
      .get(shellToolName)!
      .execute(shellCommand(readOnlyCommand), {
        workspaceRoot,
        sessionDir: workspaceRoot,
        mode: "read-only",
        toolCallId: "read_only_boundary",
      });
    expect(readOnlyResult).toMatchObject({
      status: "denied",
      execution: { outcome: "sandbox_denied", started: true },
      error: { code: "sandbox_denied", category: "permission", retryable: true },
    });
    await expect(readFile(inside, "utf8")).resolves.toContain("inside");

    const unrestrictedCommand =
      process.platform === "win32"
        ? `Set-Content -LiteralPath '${outside}' -Value unrestricted`
        : `printf unrestricted > '${outside}'`;
    const unrestrictedResult = await registry
      .get(shellToolName)!
      .execute(shellCommand(unrestrictedCommand), {
        workspaceRoot,
        sessionDir: workspaceRoot,
        mode: "danger-full-access",
        toolCallId: "unrestricted_boundary",
      });
    expect(unrestrictedResult.status).toBe("success");
    await expect(readFile(outside, "utf8")).resolves.toContain("unrestricted");
  });

  it("reads a bounded range from a session artifact reference", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-artifact-"));
    const sessionDir = path.join(workspaceRoot, "session");
    await mkdir(path.join(sessionDir, "artifacts"), { recursive: true });
    await writeFile(path.join(sessionDir, "artifacts", "large.txt"), "0123456789", "utf8");
    const tool = createDefaultToolRegistry().get("artifact.read");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { ref: "artifact://large.txt", offset: 3, maxBytes: 4 },
      {
        workspaceRoot,
        sessionDir,
        mode: "workspace-write",
        toolCallId: "call_artifact",
      },
    );

    expect(result.status).toBe("success");
    expect((result.data as { content?: string }).content).toBe("3456");
    expect((result.data as { nextOffset?: number }).nextOffset).toBe(7);
  });

  it("fetches a web page and stores a source artifact", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-web-"));
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<html><title>Fixture Page</title><body><p>Hello web source.</p></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }
    const tool = createDefaultToolRegistry().get("web.fetch");
    expect(tool).toBeDefined();

    try {
      const result = await tool!.execute(
        { url: `http://127.0.0.1:${address.port}/page`, extractMode: "text" },
        {
          workspaceRoot,
          sessionDir: workspaceRoot,
          mode: "danger-full-access",
          toolCallId: "call_web",
        },
      );
      expect(result.status).toBe("success");
      expect((result.data as { title?: string; summary?: string }).title).toBe("Fixture Page");
      expect((result.data as { summary?: string }).summary).toContain("Hello web source");
      await expect(readFile(result.artifactRefs![0]!, "utf8")).resolves.toContain(
        "Hello web source",
      );
    } finally {
      server.close();
    }
  });

  it("searches the web through Exa and normalizes source candidates", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-exa-"));
    let received: { method?: string; apiKey?: string; body?: unknown } = {};
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = {
        method: request.method,
        apiKey: request.headers["x-api-key"] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: [
            {
              title: "Exa result",
              url: "https://example.com/result",
              highlights: ["Useful highlighted passage."],
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start Exa fixture.");
    const tool = createDefaultToolRegistry({
      webSearch: { exaApiKey: "exa-test-key", exaBaseUrl: `http://127.0.0.1:${address.port}` },
    }).get("web.search");

    try {
      const result = await tool!.execute(
        { query: "coding agents", maxResults: 3, domains: ["example.com"] },
        {
          workspaceRoot,
          sessionDir: workspaceRoot,
          mode: "danger-full-access",
          toolCallId: "call_exa",
        },
      );
      expect(result.status).toBe("success");
      expect(received).toMatchObject({
        method: "POST",
        apiKey: "exa-test-key",
        body: {
          query: "coding agents",
          numResults: 3,
          type: "fast",
          includeDomains: ["example.com"],
        },
      });
      expect(result.data).toMatchObject({
        results: [
          {
            title: "Exa result",
            url: "https://example.com/result",
            snippet: "Useful highlighted passage.",
            source: "exa",
          },
        ],
      });
    } finally {
      server.close();
    }
  });

  it("returns an actionable error when the Exa API key is missing", async () => {
    const tool = createDefaultToolRegistry({ webSearch: { exaApiKey: "" } }).get("web.search");
    const result = await tool!.execute(
      { query: "coding agents" },
      {
        workspaceRoot: process.cwd(),
        sessionDir: process.cwd(),
        mode: "danger-full-access",
        toolCallId: "call_exa_missing",
      },
    );
    expect(result).toMatchObject({
      status: "error",
      error: { code: "exa_api_key_missing" },
    });
    expect(result.summary).toContain("EXA_API_KEY");
  });

  it("loads Skill instructions by name through the turn-scoped Registry", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dreamcode-skills-workspace-"));
    await writeFile(path.join(workspaceRoot, "placeholder.txt"), "ok", "utf8");
    const registry = createDefaultToolRegistry();
    const context = {
      workspaceRoot,
      sessionDir: workspaceRoot,
      mode: "danger-full-access" as const,
      toolCallId: "call_skill",
      skills: {
        generation: 1,
        catalog: [],
        load: async (name: string) => ({
          skillId: "skill_demo",
          name,
          path: path.join(workspaceRoot, "SKILL.md"),
          content: "<skill_content>Demo Skill</skill_content>",
          contentHash: "abc",
          cacheHit: false,
        }),
        loadExplicit: async (skillId: string) => ({
          skillId,
          name: "demo",
          path: path.join(workspaceRoot, "SKILL.md"),
          content: "<skill_content>Demo Skill</skill_content>",
          contentHash: "abc",
          cacheHit: false,
        }),
      },
    };

    const loaded = await registry.get("skill")!.execute({ name: "demo" }, context);
    expect((loaded.data as { content: string }).content).toContain("Demo Skill");
    expect(registry.get("skill.load")).toBeUndefined();
    expect(registry.get("skill.read_resource")).toBeUndefined();
  });
});
