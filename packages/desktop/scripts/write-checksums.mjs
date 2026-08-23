import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.join(packageRoot, "release");
const { version } = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const artifactNames = [
  `DreamCode-Portable-${version}-x64.exe`,
  `DreamCode-Setup-${version}-x64.exe`,
];

const lines = [];
for (const name of artifactNames) {
  const filePath = path.join(releaseDirectory, name);
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Cannot hash missing or empty artifact: ${name}`);
  }
  const digest = createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
  lines.push(`${digest}  ${name}`);
}

await writeFile(path.join(releaseDirectory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote SHA256SUMS.txt for ${lines.length} artifacts.`);
