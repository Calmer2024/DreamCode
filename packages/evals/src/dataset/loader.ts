import { readFile, realpath, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { AcceptanceConfig, EvalCase, LoadedCase, Runtime } from "./types.js";

function object(value: unknown, keys: string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected object");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (!keys.includes(key)) throw Error(`Unknown field: ${key}`);
  for (const key of required) if (!(key in result)) throw Error(`Missing field: ${key}`);
  return result;
}
function string(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw Error("Expected nonempty string");
}
export function parseCase(input: unknown): EvalCase {
  const value = object(
    input,
    ["id", "instruction", "environment", "acceptance", "constraints", "metadata"],
    ["id", "instruction", "environment", "acceptance"],
  );
  string(value.id);
  string(value.instruction);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.id)) throw Error("Invalid case ID");
  const environment = object(value.environment, ["workspace", "runtime"]);
  string(environment.workspace);
  string(environment.runtime);
  const acceptance = object(value.acceptance, ["evaluator", "config"]);
  string(acceptance.evaluator);
  string(acceptance.config);
  if (value.constraints !== undefined) {
    const constraints = object(value.constraints, ["editable", "protected"], ["editable"]);
    for (const field of ["editable", "protected"]) {
      const patterns = constraints[field];
      if (field === "protected" && patterns === undefined) continue;
      if (!Array.isArray(patterns)) throw Error(`Expected array: ${field}`);
      for (const pattern of patterns) {
        string(pattern);
        validateRelative(pattern);
      }
    }
  }
  if (value.metadata !== undefined) {
    const metadata = object(value.metadata, ["project", "scenario"], []);
    for (const entry of Object.values(metadata)) string(entry);
  }
  return value as unknown as EvalCase;
}
export function validateRelative(value: string) {
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === "." || part === "") ||
    /[:\x00-\x1f]/.test(value)
  )
    throw Error(`Unsafe relative path: ${value}`);
}
export async function resolveInside(root: string, relative: string) {
  validateRelative(relative);
  const base = await realpath(root);
  let current = base;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw Error(`Symlink forbidden: ${relative}`);
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(`${base}${path.sep}`)) throw Error(`Path escapes root: ${relative}`);
  return resolved;
}
export async function assertTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error(`Symlink forbidden: ${entry.name}`);
    if (!entry.isDirectory() && !entry.isFile()) throw Error(`Unsupported file: ${entry.name}`);
    if (entry.isDirectory()) await assertTree(path.join(root, entry.name));
  }
}
export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}
export function parseAcceptance(input: unknown, evaluator: string): AcceptanceConfig {
  if (!["program", "judge", "combined"].includes(evaluator))
    throw Error(`Unknown evaluator: ${evaluator}`);
  const value = object(input, ["criteria", "program", "rubric"], ["criteria"]);
  if (!Array.isArray(value.criteria) || !value.criteria.length) throw Error("Empty criteria");
  const ids = new Set<string>();
  for (const item of value.criteria) {
    const criterion = object(item, ["id", "description", "method"], ["id", "description"]);
    string(criterion.id);
    string(criterion.description);
    if (evaluator === "combined" && !["program", "judge"].includes(String(criterion.method)))
      throw Error("Combined criterion must explicitly select program or judge");
    if (
      evaluator !== "combined" &&
      criterion.method !== undefined &&
      criterion.method !== evaluator
    )
      throw Error("Criterion method conflicts with evaluator");
    if (ids.has(criterion.id)) throw Error(`Duplicate criterion: ${criterion.id}`);
    ids.add(criterion.id);
  }
  if (
    evaluator === "combined" &&
    (![...value.criteria].some((item) => item.method === "program") ||
      ![...value.criteria].some((item) => item.method === "judge"))
  )
    throw Error("Combined acceptance requires both methods");
  if (evaluator !== "judge") {
    const program = object(value.program, ["file", "timeoutMs"]);
    string(program.file);
    validateRelative(program.file);
    if (!Number.isSafeInteger(program.timeoutMs) || Number(program.timeoutMs) <= 0)
      throw Error("Invalid program timeout");
  } else if (value.program !== undefined) throw Error("Judge acceptance cannot contain program");
  if (evaluator !== "program") string(value.rubric);
  else if (value.rubric !== undefined) throw Error("Program acceptance cannot contain rubric");
  return value as unknown as AcceptanceConfig;
}
export async function loadCase(datasetRoot: string, relative: string): Promise<LoadedCase> {
  const caseFile = await resolveInside(datasetRoot, relative);
  const root = path.dirname(caseFile),
    value = parseCase(await readJson(caseFile));
  const workspace = await resolveInside(root, value.environment.workspace);
  if (!(await lstat(workspace)).isDirectory()) throw Error("Workspace must be directory");
  await assertTree(workspace);
  const instruction = await readFile(await resolveInside(root, value.instruction), "utf8");
  if (!instruction.trim()) throw Error("Empty instruction");
  const acceptance = parseAcceptance(
    await readJson(await resolveInside(root, value.acceptance.config)),
    value.acceptance.evaluator,
  );
  if (acceptance.program) await resolveInside(root, acceptance.program.file);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value.environment.runtime)) throw Error("Invalid runtime name");
  const runtimeInput = object(
    await readJson(await resolveInside(datasetRoot, `runtimes/${value.environment.runtime}.json`)),
    ["image", "timeoutMs"],
  );
  string(runtimeInput.image);
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeInput.image))
    throw Error("Runtime image must be pinned");
  if (!Number.isSafeInteger(runtimeInput.timeoutMs) || Number(runtimeInput.timeoutMs) <= 0)
    throw Error("Invalid runtime timeout");
  return {
    value,
    root,
    workspace,
    instruction,
    acceptance,
    runtime: runtimeInput as unknown as Runtime,
  };
}
export async function loadDataset(root: string) {
  const manifest = object(await readJson(await resolveInside(root, "dataset.json")), [
    "version",
    "cases",
  ]);
  string(manifest.version);
  if (!Array.isArray(manifest.cases)) throw Error("Invalid case list");
  const cases: LoadedCase[] = [],
    ids = new Set<string>();
  for (const relative of manifest.cases) {
    string(relative);
    const entry = await loadCase(root, relative);
    if (ids.has(entry.value.id)) throw Error(`Duplicate case: ${entry.value.id}`);
    ids.add(entry.value.id);
    cases.push(entry);
  }
  return { version: manifest.version, cases };
}
