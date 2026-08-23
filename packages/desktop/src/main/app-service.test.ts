import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSession,
  loadDreamCodeConfig,
  saveDreamCodeConfig,
  upsertLlmProfile,
} from "@dreamcode/store";
import { describe, expect, it } from "vitest";
import { DesktopAppService } from "./app-service";

function emptyConfig() {
  return { version: 2 as const, profiles: {} };
}

describe("DesktopAppService", () => {
  it("creates collision-safe managed projects under the DreamCode projects directory", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);

    const first = await service.createProject({ name: "Managed App" });
    const second = await service.createProject({ name: "Managed App" });

    expect(first.workspaceRoot).toBe(path.join(home, "projects", "Managed App"));
    expect(second.workspaceRoot).toBe(path.join(home, "projects", "Managed App-2"));
    await expect(access(first.workspaceRoot)).resolves.toBeUndefined();
    await expect(access(second.workspaceRoot)).resolves.toBeUndefined();
    expect(second.bootstrap.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Managed App", workspaceRoot: first.workspaceRoot }),
        expect.objectContaining({ name: "Managed App", workspaceRoot: second.workspaceRoot }),
      ]),
    );
  });

  it("preserves project creation order when a project is edited", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);
    const firstRoot = path.join(home, "first");
    const secondRoot = path.join(home, "second");

    await service.saveProject({ workspaceRoot: firstRoot, name: "First" });
    await service.saveProject({ workspaceRoot: secondRoot, name: "Second" });
    const bootstrap = await service.saveProject({ workspaceRoot: firstRoot, name: "Renamed" });

    expect(bootstrap.projects?.map((project) => project.name)).toEqual(["Renamed", "Second"]);
  });

  it("exposes the normal Fake Provider preset without E2E-only variants", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));

    const bootstrap = await new DesktopAppService(home).bootstrap();

    expect(bootstrap.presets).toContainEqual({
      id: "fake",
      displayName: "Fake Provider",
      defaultModel: "fake",
    });
    expect(bootstrap.presets.some((preset) => preset.id.startsWith("e2e-"))).toBe(false);
  });

  it("never returns persisted API key plaintext", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);
    await saveDreamCodeConfig(
      upsertLlmProfile(emptyConfig(), "deepseek", {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: "secret-value",
      }),
      home,
    );

    const bootstrap = await service.bootstrap();

    expect(JSON.stringify(bootstrap)).not.toContain("secret-value");
    expect(bootstrap.profiles[0]?.credentialAvailable).toBe(true);
  });

  it("preserves an existing credential when a redacted profile is saved without a replacement", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);
    await saveDreamCodeConfig(
      upsertLlmProfile(emptyConfig(), "work", {
        provider: "openai",
        model: "gpt-existing",
        apiKey: "secret-value",
      }),
      home,
    );

    const profileId = (await service.bootstrap()).profiles[0]!.id;
    await service.updateProfile({
      profileId,
      alias: "work",
      provider: "openai",
      model: "gpt-next",
      credential: { mode: "preserve" },
    });

    const updated = await loadDreamCodeConfig(home);
    expect(updated.profiles[profileId]).toMatchObject({
      alias: "work",
      model: "gpt-next",
      apiKey: "secret-value",
    });
  });

  it("replaces an existing API key environment variable with a supplied plaintext API key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);
    await saveDreamCodeConfig(
      upsertLlmProfile(emptyConfig(), "work", {
        provider: "openai",
        model: "gpt-existing",
        apiKeyEnv: "DREAMCODE_OLD_KEY",
      }),
      home,
    );

    const profileId = (await service.bootstrap()).profiles[0]!.id;
    await service.updateProfile({
      profileId,
      alias: "work",
      provider: "openai",
      model: "gpt-next",
      credential: { mode: "inline", apiKey: "replacement-key" },
    });

    const updated = await loadDreamCodeConfig(home);
    expect(updated.profiles[profileId]).toMatchObject({ apiKey: "replacement-key" });
    expect(updated.profiles[profileId]?.apiKeyEnv).toBeUndefined();
  });

  it("stores and redacts the Exa web search credential", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);

    const bootstrap = await service.updateWebSearchCredential({
      mode: "inline",
      apiKey: "exa-secret-value",
    });

    expect(bootstrap.webSearch).toMatchObject({
      provider: "exa",
      credentialSource: "inline",
      credentialAvailable: true,
    });
    expect(JSON.stringify(bootstrap)).not.toContain("exa-secret-value");
    await expect(loadDreamCodeConfig(home)).resolves.toMatchObject({
      exaApiKey: "exa-secret-value",
    });
  });

  it("creates multiple profiles per provider without implicitly changing the default", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);

    const first = await service.createProfile({
      alias: "工作",
      provider: "openai",
      model: "gpt-5.5",
      credential: { mode: "clear" },
    });
    const second = await service.createProfile({
      alias: "个人",
      provider: "openai",
      model: "gpt-5.4",
      credential: { mode: "clear" },
    });

    expect(second.profiles.map((profile) => profile.alias)).toEqual(["工作", "个人"]);
    expect(first.currentProfileId).toBeUndefined();
    expect(second.currentProfileId).toBeUndefined();
  });

  it("moves the default to the next profile when the default is deleted", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);
    let snapshot = await service.createProfile({
      alias: "工作",
      provider: "openai",
      model: "gpt-5.5",
      credential: { mode: "clear" },
    });
    snapshot = await service.createProfile({
      alias: "个人",
      provider: "openai",
      model: "gpt-5.4",
      credential: { mode: "clear" },
    });
    const [first, second] = snapshot.profiles;
    await service.setDefaultProfile(first!.id);

    const deleted = await service.deleteProfile(first!.id);

    expect(deleted.currentProfileId).toBe(second!.id);
    expect(deleted.profiles.map((profile) => profile.id)).toEqual([second!.id]);
  });

  it("tests a Fake Provider draft without persisting it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);

    await expect(
      service.testProfile({
        alias: "离线测试",
        provider: "fake",
        model: "fake",
        credential: { mode: "clear" },
      }),
    ).resolves.toEqual({ ok: true, message: "连接测试成功。" });
    await expect(loadDreamCodeConfig(home)).resolves.toMatchObject({ profiles: {} });
  });

  it("rejects duplicate aliases within the same provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const service = new DesktopAppService(home);
    await service.createProfile({
      alias: "Work",
      provider: "openai",
      model: "gpt-5.5",
      credential: { mode: "clear" },
    });

    await expect(
      service.createProfile({
        alias: "work",
        provider: "openai",
        model: "gpt-5.4",
        credential: { mode: "clear" },
      }),
    ).rejects.toMatchObject({ code: "profile_alias_conflict" });
  });

  it("returns a stored diff only for the exact changed-file path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const sessionId = "sess_diff";
    const sessionDir = path.join(home, "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt_diff",
        timestamp: "2026-08-10T00:00:00.000Z",
        type: "file.changed",
        payload: {
          changedFile: {
            path: "src/changed.ts",
            operation: "update",
            diff: "@@ -1 +1 @@\n-before\n+after",
          },
        },
      })}\n`,
      "utf8",
    );
    await writeFile(path.join(home, "outside.ts"), "not a stored diff", "utf8");

    const service = new DesktopAppService(home);

    await expect(service.readChangedFileDiff(sessionId, "src/changed.ts")).resolves.toBe(
      "@@ -1 +1 @@\n-before\n+after",
    );
    await expect(
      service.readChangedFileDiff(sessionId, path.join(home, "outside.ts")),
    ).resolves.toBe("");
  });

  it("returns the complete stored event stream with replayed session state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const { session, eventLog } = await createSession({ workspaceRoot: home, home });
    await eventLog.append({
      id: "evt_user",
      sessionId: session.id,
      turnId: "turn_1",
      type: "user.message",
      timestamp: "2026-08-10T00:00:00.000Z",
      payload: { content: "Keep the whole conversation" },
    });

    const detail = await new DesktopAppService(home).readSession(session.id);

    expect(detail.latestPrompt).toBe("Keep the whole conversation");
    expect(detail.events).toEqual([
      expect.objectContaining({
        type: "user.message",
        payload: { content: "Keep the whole conversation" },
      }),
    ]);
  });

  it("persists an inline session rename across bootstrap refreshes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const { session, eventLog } = await createSession({ workspaceRoot: home, home });
    await eventLog.append({
      id: "evt_title",
      sessionId: session.id,
      turnId: "turn_1",
      type: "user.message",
      timestamp: "2026-08-10T00:00:00.000Z",
      payload: { content: "Original prompt" },
    });
    const service = new DesktopAppService(home);

    const bootstrap = await service.renameSession({ sessionId: session.id, title: "自定义名称" });

    expect(bootstrap.sessions.find((item) => item.id === session.id)?.title).toBe("自定义名称");
    await expect(service.bootstrap()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: session.id, title: "自定义名称" })],
    });
  });

  it("rejects traversal session identifiers before reading or rolling back", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const externalSessionDir = path.join(home, "outside");
    await mkdir(externalSessionDir, { recursive: true });
    await writeFile(
      path.join(externalSessionDir, "session.json"),
      JSON.stringify({
        id: "sess_external",
        workspaceRoot: home,
        sessionDir: externalSessionDir,
        createdAt: "2026-08-10T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      path.join(externalSessionDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt_external",
        timestamp: "2026-08-10T00:00:00.000Z",
        type: "file.changed",
        payload: {
          changedFile: {
            path: "src/external.ts",
            operation: "update",
            diff: "external-secret-diff",
          },
        },
      })}\n`,
      "utf8",
    );

    const service = new DesktopAppService(home);
    const traversalId = "../outside";

    expect(() => service.readSession(traversalId)).toThrow("Invalid session ID");
    await expect(service.readChangedFileDiff(traversalId, "src/external.ts")).rejects.toThrow(
      "Invalid session ID",
    );
    await expect(
      service.rollback({ sessionId: traversalId, filePath: "src/external.ts" }),
    ).rejects.toThrow("Invalid session ID");
  });

  it("deletes project conversations and metadata without deleting workspace files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-desktop-"));
    const workspaceRoot = path.join(home, "workspace");
    const sourcePath = path.join(workspaceRoot, "README.md");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(sourcePath, "keep me", "utf8");
    const { session } = await createSession({ workspaceRoot, home });
    const service = new DesktopAppService(home);

    await service.saveProject({ workspaceRoot, name: "Workspace", pinned: true });
    const deleted = await service.deleteProject(workspaceRoot);

    expect(deleted.projects).toEqual([]);
    expect(deleted.sessions).toEqual([]);
    await expect(access(sourcePath)).resolves.toBeUndefined();
    await expect(access(path.join(home, "sessions", session.id))).rejects.toThrow();
  });
});
