import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveDreamCodeConfig, upsertLlmProfile } from "@dreamcode/store";
import { DesktopAppService } from "./app-service";

function emptyConfig() {
  return { version: 1 as const, profiles: {} };
}

describe("DesktopAppService", () => {
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
    await expect(service.readChangedFileDiff(sessionId, path.join(home, "outside.ts"))).resolves.toBe(
      "",
    );
  });
});
