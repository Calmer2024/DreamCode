import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertTree } from "./loader.js";
export async function datasetDigest(root: string) {
  await assertTree(root);
  const files: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["preparation", "integrity.json", "README.md"].includes(entry.name) && directory === root)
        continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files.push(path.relative(root, file).split(path.sep).join("/"));
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const bytes = await readFile(path.join(root, file));
    hash.update(JSON.stringify([file, bytes.length]));
    hash.update(bytes);
  }
  return { algorithm: "sha256-tree-v1", digest: hash.digest("hex"), files: files.length };
}
export async function freezeIntegrity(root: string) {
  const result = await datasetDigest(root);
  await writeFile(path.join(root, "integrity.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
export async function verifyIntegrity(root: string) {
  const expected = JSON.parse(await readFile(path.join(root, "integrity.json"), "utf8"));
  const actual = await datasetDigest(root);
  if (
    expected.algorithm !== actual.algorithm ||
    expected.digest !== actual.digest ||
    expected.files !== actual.files
  )
    throw Error("Dataset integrity mismatch");
  return actual;
}
