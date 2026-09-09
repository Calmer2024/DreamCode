import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MediaAttachment, MediaAttachmentKind } from "@dreamcode/shared";
import { createId } from "@dreamcode/shared";
import { getDreamCodeHome, getSessionDir } from "@dreamcode/store";

const runFile = promisify(execFile);
const localRequire = createRequire(import.meta.url);
const maximumAttachmentCount = 10;
const maximumTotalBytes = 250 * 1024 * 1024;
const maximumBytesByKind: Record<MediaAttachmentKind, number> = {
  image: 20 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

export type DesktopAttachment = Omit<
  MediaAttachment,
  "relativePath" | "sendRelativePath" | "sourcePath" | "originalSourcePath"
>;

export interface AttachmentImportError {
  name: string;
  code: "unsupported_type" | "file_too_large" | "total_too_large" | "invalid_media" | "disk_full" | "read_failed";
  message: string;
}

export interface AttachmentImportResult {
  attachments: DesktopAttachment[];
  errors: AttachmentImportError[];
}

interface StagedAttachment extends DesktopAttachment {
  originalSourcePath: string;
  sourcePath: string;
}

export class DesktopAttachmentService {
  readonly #home: string;
  readonly #stagingRoot: string;
  readonly #staged = new Map<string, StagedAttachment>();

  constructor(home = getDreamCodeHome()) {
    this.#home = home;
    this.#stagingRoot = path.join(home, "attachment-staging");
  }

  async initialize(): Promise<void> {
    await rm(this.#stagingRoot, { recursive: true, force: true });
    await mkdir(this.#stagingRoot, { recursive: true });
  }

  async importPaths(filePaths: string[], existing: DesktopAttachment[] = []): Promise<AttachmentImportResult> {
    const attachments: DesktopAttachment[] = [];
    const errors: AttachmentImportError[] = [];
    for (const filePath of filePaths) {
      if (existing.length + attachments.length >= maximumAttachmentCount) {
        errors.push(importError(path.basename(filePath), "total_too_large", `每条消息最多添加 ${maximumAttachmentCount} 个附件。`));
        continue;
      }
      try {
        const metadata = await stat(filePath);
        if (!metadata.isFile()) throw new Error("not a regular file");
        const bytes = await readFile(filePath);
        const result = await this.#stage(path.basename(filePath), bytes, existing, attachments);
        if ("code" in result) errors.push(result);
        else attachments.push(result);
      } catch {
        errors.push(importError(path.basename(filePath), "read_failed", "无法读取这个文件。"));
      }
    }
    return { attachments, errors };
  }

  async importBytes(
    files: Array<{ name: string; bytes: Uint8Array }>,
    existing: DesktopAttachment[] = [],
  ): Promise<AttachmentImportResult> {
    const attachments: DesktopAttachment[] = [];
    const errors: AttachmentImportError[] = [];
    for (const file of files) {
      if (existing.length + attachments.length >= maximumAttachmentCount) {
        errors.push(importError(file.name, "total_too_large", `每条消息最多添加 ${maximumAttachmentCount} 个附件。`));
        continue;
      }
      try {
        const result = await this.#stage(file.name, Buffer.from(file.bytes), existing, attachments);
        if ("code" in result) errors.push(result);
        else attachments.push(result);
      } catch {
        errors.push(importError(file.name, "read_failed", "无法处理这个文件。"));
      }
    }
    return { attachments, errors };
  }

  resolve(ids: string[]): MediaAttachment[] {
    return ids.map((id) => {
      const staged = this.#staged.get(id);
      if (!staged) throw new Error(`Attachment ${id} is no longer staged.`);
      return {
        ...staged,
        relativePath: "",
        sendRelativePath: "",
        sourcePath: staged.sourcePath,
        originalSourcePath: staged.originalSourcePath,
      };
    });
  }

  async discard(ids: string[]): Promise<void> {
    await Promise.all(ids.map(async (id) => {
      const staged = this.#staged.get(id);
      this.#staged.delete(id);
      if (staged) await rm(path.dirname(staged.originalSourcePath), { recursive: true, force: true });
    }));
  }

  async read(input: { attachmentId: string; sessionId?: string }): Promise<Uint8Array> {
    if (input.sessionId) {
      const attachmentDir = path.join(getSessionDir(input.sessionId, this.#home), "attachments", safeId(input.attachmentId));
      const entries = await import("node:fs/promises").then(({ readdir }) => readdir(attachmentDir));
      const original = entries.find((entry) => entry.startsWith("original."));
      if (!original) throw new Error("Attachment file is missing.");
      return readFile(path.join(attachmentDir, original));
    }
    const staged = this.#staged.get(input.attachmentId);
    if (!staged) throw new Error("Attachment draft is no longer available.");
    return readFile(staged.originalSourcePath);
  }

  async #stage(
    suppliedName: string,
    bytes: Buffer,
    existing: DesktopAttachment[],
    pending: DesktopAttachment[],
  ): Promise<DesktopAttachment | AttachmentImportError> {
    const detected = detectMedia(bytes);
    const name = sanitizeName(suppliedName, detected?.extension ?? "bin");
    if (!detected) return importError(name, "unsupported_type", "仅支持 PNG、JPEG、WebP、GIF、MP3 和 MP4。\n");
    if (bytes.length > maximumBytesByKind[detected.kind]) {
      return importError(name, "file_too_large", `${kindLabel(detected.kind)}大小超过 ${formatBytes(maximumBytesByKind[detected.kind])}。`);
    }
    const total = [...existing, ...pending].reduce((sum, item) => sum + item.size, 0) + bytes.length;
    if (total > maximumTotalBytes) return importError(name, "total_too_large", "单条消息的附件总大小不能超过 250 MB。");
    const disk = await statfs(this.#stagingRoot);
    if (disk.bavail * disk.bsize < bytes.length * 2 + 64 * 1024 * 1024) {
      return importError(name, "disk_full", "可用磁盘空间不足，无法暂存附件。 ");
    }
    const id = createId("attachment");
    const directory = path.join(this.#stagingRoot, safeId(id));
    const originalSourcePath = path.join(directory, `original.${detected.extension}`);
    const sourcePath = path.join(directory, `send.${detected.extension}`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(originalSourcePath, bytes);
    } catch {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      return importError(name, "disk_full", "无法将附件写入本地暂存区，请检查可用磁盘空间。");
    }
    try {
      await sanitizeMedia(originalSourcePath, sourcePath, detected);
      await validateMedia(sourcePath, detected.kind);
    } catch {
      await rm(directory, { recursive: true, force: true });
      return importError(name, "invalid_media", "媒体文件损坏，或无法安全移除元数据。 ");
    }
    const staged: StagedAttachment = {
      id,
      name,
      kind: detected.kind,
      mimeType: detected.mimeType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      originalSourcePath,
      sourcePath,
    };
    this.#staged.set(id, staged);
    return publicAttachment(staged);
  }
}

function publicAttachment(attachment: StagedAttachment): DesktopAttachment {
  const { originalSourcePath: _original, sourcePath: _source, ...value } = attachment;
  return value;
}

function detectMedia(bytes: Buffer): { kind: MediaAttachmentKind; mimeType: string; extension: string } | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mimeType: "image/png", extension: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", mimeType: "image/jpeg", extension: "jpg" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { kind: "image", mimeType: "image/webp", extension: "webp" };
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return { kind: "image", mimeType: "image/gif", extension: "gif" };
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return { kind: "audio", mimeType: "audio/mpeg", extension: "mp3" };
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return { kind: "video", mimeType: "video/mp4", extension: "mp4" };
  return undefined;
}

async function sanitizeMedia(
  input: string,
  output: string,
  media: { kind: MediaAttachmentKind; mimeType: string },
): Promise<void> {
  if (media.kind === "image") {
    const bytes = await readFile(input);
    const sanitized = media.mimeType === "image/png"
      ? stripPngMetadata(bytes)
      : media.mimeType === "image/jpeg"
        ? stripJpegMetadata(bytes)
        : media.mimeType === "image/webp"
          ? stripWebpMetadata(bytes)
          : stripGifMetadata(bytes);
    await writeFile(output, sanitized);
    return;
  }
  await runFile(runtimeBinary("ffmpeg"), ["-y", "-v", "error", "-i", input, "-map_metadata", "-1", "-map_chapters", "-1", "-c", "copy", output], { windowsHide: true });
}

async function validateMedia(filePath: string, kind: MediaAttachmentKind): Promise<void> {
  if (kind === "image") {
    const bytes = await readFile(filePath);
    if (!detectMedia(bytes)) throw new Error("Invalid image output.");
    return;
  }
  await runFile(runtimeBinary("ffprobe"), ["-v", "error", "-show_entries", "format=format_name", "-of", "json", filePath], { windowsHide: true });
}

function runtimeBinary(tool: "ffmpeg" | "ffprobe"): string {
  const executable = process.platform === "win32" ? `${tool}.exe` : tool;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "dist-main", "bin", executable),
    path.resolve(moduleDirectory, "../bin", executable),
    tool === "ffmpeg"
      ? path.resolve(moduleDirectory, "../../node_modules/@ffmpeg-installer", `${os.platform()}-${os.arch()}`, executable)
      : path.resolve(moduleDirectory, "../../node_modules/ffprobe-static/bin", os.platform(), os.arch(), executable),
  ];
  const resolved = candidates.find(existsSync);
  if (resolved) return resolved;
  try {
    const installed = localRequire(tool === "ffmpeg" ? "@ffmpeg-installer/ffmpeg" : "ffprobe-static") as { path?: string };
    if (installed.path && existsSync(installed.path)) return installed.path;
  } catch {
    // Packaged builds intentionally do not ship the npm wrappers.
  }
  throw new Error(`${tool} executable is unavailable.`);
}

function stripPngMetadata(bytes: Buffer): Buffer {
  if (bytes.length < 12) throw new Error("Invalid PNG.");
  const output = [bytes.subarray(0, 8)];
  const removed = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Invalid PNG chunk.");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!removed.has(type)) output.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(output);
}

function stripJpegMetadata(bytes: Buffer): Buffer {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid JPEG.");
  const output = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff || offset + 1 >= bytes.length) throw new Error("Invalid JPEG marker.");
    const marker = bytes[offset + 1]!;
    if (marker === 0xda) {
      output.push(bytes.subarray(offset));
      return Buffer.concat(output);
    }
    if (marker === 0xd9) {
      output.push(bytes.subarray(offset, offset + 2));
      return Buffer.concat(output);
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      output.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) throw new Error("Invalid JPEG segment.");
    const length = bytes.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) throw new Error("Invalid JPEG segment length.");
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) output.push(bytes.subarray(offset, end));
    offset = end;
  }
  throw new Error("Incomplete JPEG.");
}

function stripWebpMetadata(bytes: Buffer): Buffer {
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") throw new Error("Invalid WebP.");
  const chunks: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = bytes.readUInt32LE(offset + 4);
    const paddedLength = length + (length % 2);
    const end = offset + 8 + paddedLength;
    if (end > bytes.length) throw new Error("Invalid WebP chunk.");
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = Buffer.from(bytes.subarray(offset, end));
      if (type === "VP8X" && length >= 1) chunk[8] = chunk[8]! & ~0x0c;
      chunks.push(chunk);
    }
    offset = end;
  }
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function stripGifMetadata(bytes: Buffer): Buffer {
  if (!["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) throw new Error("Invalid GIF.");
  const packed = bytes[10]!;
  const globalTableLength = packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;
  let offset = 13 + globalTableLength;
  const output = [bytes.subarray(0, offset)];
  while (offset < bytes.length) {
    const introducer = bytes[offset]!;
    if (introducer === 0x3b) {
      output.push(bytes.subarray(offset, offset + 1));
      return Buffer.concat(output);
    }
    if (introducer === 0x2c) {
      if (offset + 10 > bytes.length) throw new Error("Invalid GIF image descriptor.");
      const localPacked = bytes[offset + 9]!;
      const localLength = localPacked & 0x80 ? 3 * 2 ** ((localPacked & 0x07) + 1) : 0;
      const dataStart = offset + 10 + localLength + 1;
      const end = gifSubBlocksEnd(bytes, dataStart);
      output.push(bytes.subarray(offset, end));
      offset = end;
      continue;
    }
    if (introducer !== 0x21 || offset + 2 > bytes.length) throw new Error("Invalid GIF extension.");
    const label = bytes[offset + 1]!;
    const dataStart = offset + 2;
    const fixedSize = label === 0xf9 ? 1 + (bytes[dataStart] ?? 0) : 0;
    const end = fixedSize ? dataStart + fixedSize + 1 : gifSubBlocksEnd(bytes, dataStart);
    const isComment = label === 0xfe;
    const isXmp = label === 0xff && bytes.subarray(dataStart + 1, dataStart + 12).toString("ascii").startsWith("XMP DataXMP");
    if (!isComment && !isXmp) output.push(bytes.subarray(offset, end));
    offset = end;
  }
  throw new Error("Incomplete GIF.");
}

function gifSubBlocksEnd(bytes: Buffer, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset]!;
    offset += 1;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.length) break;
  }
  throw new Error("Invalid GIF data blocks.");
}

function sanitizeName(name: string, extension: string): string {
  const base = Array.from(path.basename(name || `attachment.${extension}`))
    .filter((character) => character.charCodeAt(0) > 0x1f)
    .join("")
    .slice(0, 180);
  return base || `attachment.${extension}`;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid attachment ID.");
  return value;
}

function importError(name: string, code: AttachmentImportError["code"], message: string): AttachmentImportError {
  return { name, code, message: message.trim() };
}

function kindLabel(kind: MediaAttachmentKind): string {
  return ({ image: "图片", audio: "音频", video: "视频" } as const)[kind];
}

function formatBytes(value: number): string {
  return `${Math.round(value / 1024 / 1024)} MB`;
}
