import { readdir, readFile, mkdir, cp, writeFile, stat, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { assertTree } from "./loader.js";
import type { EvalCase } from "./types.js";
const exec = promisify(execFile);
export interface FileState {
  hash: string;
  bytes: number;
  mode: number;
}
export async function snapshot(root: string): Promise<Record<string, FileState>> {
  await assertTree(root);
  const output: Record<string, FileState> = {};
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const bytes = await readFile(file);
        output[path.relative(root, file).split(path.sep).join("/")] = {
          hash: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          mode: (await stat(file)).mode,
        };
      }
    }
  }
  await visit(root);
  return output;
}
function glob(pattern: string, file: string) {
  // Git-style relative globs: ** spans directories, * and ? do not.
  const regex = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) =>
      part === "**/"
        ? "(?:.*/)?"
        : part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part === "?"
              ? "[^/]"
              : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${regex}$`).test(file);
}
export function changedFiles(before: Record<string, FileState>, after: Record<string, FileState>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(
      (file) =>
        before[file]?.hash !== after[file]?.hash || before[file]?.mode !== after[file]?.mode,
    )
    .sort();
}
export function constraintViolations(value: EvalCase, files: string[]) {
  if (!value.constraints) return [];
  return files.filter(
    (file) =>
      !value.constraints!.editable.some((pattern) => glob(pattern, file)) ||
      value.constraints!.protected?.some((pattern) => glob(pattern, file)),
  );
}
export async function prepareWorkspace(source: string, target: string) {
  await assertTree(source);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  const trusted = path.join(path.dirname(target), "trusted-git");
  await exec("git", ["init", "--bare", "--quiet", trusted]);
  const args = [
    "--git-dir",
    trusted,
    "--work-tree",
    target,
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.hooksPath=/dev/null",
  ];
  await exec("git", [...args, "add", "--force", "."]);
  await exec("git", [
    ...args,
    "-c",
    "user.name=DreamEval",
    "-c",
    "user.email=eval@localhost",
    "commit",
    "--quiet",
    "-m",
    "Initial case workspace",
  ]);
  let existingGit = false;
  try {
    const info = await lstat(path.join(target, ".git"));
    if (!info.isDirectory())
      throw Error("Initial Git state must use an in-workspace .git directory");
    existingGit = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Preserve deliberately prepared branch/merge state for terminal cases.
  if (!existingGit) {
    await exec("git", ["init", "--quiet", target]);
    await exec("git", ["-C", target, "config", "core.autocrlf", "false"]);
    await exec("git", ["-C", target, "-c", "core.hooksPath=/dev/null", "add", "--force", "."]);
    await exec("git", [
      "-C",
      target,
      "-c",
      "user.name=DreamEval",
      "-c",
      "user.email=eval@localhost",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "Initial case workspace",
    ]);
  }
}
export async function collectArtifacts(workspace: string, destination: string) {
  const state = await snapshot(workspace);
  await mkdir(destination, { recursive: true });
  // Never trust a candidate-controlled Git index for final contents.
  for (const file of Object.keys(state)) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(workspace, file)));
  }
  // Terminal cases can require a resolved merge/commit state. Preserve the actual
  // candidate Git files for regrading, but never execute their config on the host.
  try {
    await cp(path.join(workspace, ".git"), path.join(destination, ".git"), { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return state;
}
export async function workspaceDiff(workspace: string) {
  // Candidate .git/config and hooks must never execute on the host.
  const args = [
    "--git-dir",
    path.join(path.dirname(workspace), "trusted-git"),
    "--work-tree",
    workspace,
    "-c",
    "core.hooksPath=/dev/null",
  ];
  await exec("git", [...args, "add", "--force", "."]);
  return (
    await exec("git", [...args, "diff", "--cached", "--binary", "HEAD"], {
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
}
