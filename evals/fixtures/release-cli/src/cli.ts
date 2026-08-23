import { readFile } from "node:fs/promises";

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest.name) errors.push("name is required");
  if (!manifest.version) errors.push("version is required");
  return errors;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, file] = argv;
  if (command === "validate") {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    const errors = validateManifest(manifest);
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log("valid release manifest");
    return;
  }
  if (command === "summary") {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    console.log(`${manifest.name}@${manifest.version}`);
    return;
  }
  console.error("usage: release <validate|summary> <manifest.json>");
  process.exitCode = 1;
}

if (import.meta.main) await main();
