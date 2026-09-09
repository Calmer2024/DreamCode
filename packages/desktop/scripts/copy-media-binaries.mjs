import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(directory, "../dist-main/bin");
const ffmpeg = require("@ffmpeg-installer/ffmpeg");
const ffprobe = require("ffprobe-static");

await mkdir(target, { recursive: true });
await Promise.all([
  copyFile(ffmpeg.path, path.join(target, "ffmpeg.exe")),
  copyFile(ffprobe.path, path.join(target, "ffprobe.exe")),
  copyFile(
    path.resolve(directory, "../build/THIRD_PARTY_MEDIA_NOTICES.txt"),
    path.join(target, "THIRD_PARTY_MEDIA_NOTICES.txt"),
  ),
]);
