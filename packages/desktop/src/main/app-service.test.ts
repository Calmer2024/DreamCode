import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDreamCodeConfig, saveDreamCodeConfig, upsertLlmProfile } from "@dreamcode/store";
import { describe, expect, it } from "vitest";
import { DesktopAppService } from "./app-service";

function emptyConfig() {
  return { version: 1 as const, profiles: {} };
}

describe("DesktopAppService", () => {
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
    expect(bootstrap.profiles[0]?.apiKeyConfigured).toBe(true);
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

    await service.saveProfile({ name: "work", provider: "openai", model: "gpt-next" });

    await expect(loadDreamCodeConfig(home)).resolves.toMatchObject({
      profiles: { work: { model: "gpt-next", apiKey: "secret-value" } },
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

    await service.saveProfile({
      name: "work",
      provider: "openai",
      model: "gpt-next",
      apiKey: "replacement-key",
    });

    const updated = await loadDreamCodeConfig(home);
    expect(updated.profiles.work).toMatchObject({ apiKey: "replacement-key" });
    expect(updated.profiles.work?.apiKeyEnv).toBeUndefined();
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
});
