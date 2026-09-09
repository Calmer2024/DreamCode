import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAttachmentService } from "./attachment-service";

const homes: string[] = [];
const runFile = promisify(execFile);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("DesktopAttachmentService", () => {
  it("stages a validated image without exposing managed paths", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-attachments-"));
    homes.push(home);
    const service = new DesktopAttachmentService(home);
    await service.initialize();

    const result = await service.importBytes([{ name: "pixel.png", bytes: png }]);
    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ name: "pixel.png", kind: "image", mimeType: "image/png" });
    expect(result.attachments[0]).not.toHaveProperty("sourcePath");
    const runtime = service.resolve([result.attachments[0]!.id])[0]!;
    expect(await readFile(runtime.sourcePath!)).toEqual(expect.any(Buffer));
  });

  it("partially accepts a batch and explains unsupported files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-attachments-"));
    homes.push(home);
    const service = new DesktopAttachmentService(home);
    await service.initialize();

    const result = await service.importBytes([
      { name: "pixel.png", bytes: png },
      { name: "notes.pdf", bytes: Buffer.from("%PDF-1.7") },
    ]);
    expect(result.attachments).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ name: "notes.pdf", code: "unsupported_type" }),
    ]);
  });

  it("sanitizes and validates MP3 and MP4 files with bundled media tools", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dreamcode-attachments-"));
    homes.push(home);
    const mp3 = path.join(home, "tone.mp3");
    const mp4 = path.join(home, "clip.mp4");
    await runFile(ffmpeg.path, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", mp3]);
    await runFile(ffmpeg.path, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1", "-c:v", "mpeg4", mp4]);
    const service = new DesktopAttachmentService(home);
    await service.initialize();

    const result = await service.importPaths([mp3, mp4]);
    expect(result.errors).toEqual([]);
    expect(result.attachments.map((item) => item.kind)).toEqual(["audio", "video"]);
  });
});
