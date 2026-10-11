import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatasetGroup } from "./dataset-types";

export function validateGroup(body: Record<string, unknown>, ids: string[]) {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)
    throw Error("测评组名称须为 1–80 个字符");
  if (
    body.description !== undefined &&
    (typeof body.description !== "string" || body.description.length > 2000)
  )
    throw Error("测评组说明最多 2000 个字符");
  if (
    !Array.isArray(body.caseIds) ||
    !body.caseIds.length ||
    new Set(body.caseIds).size !== body.caseIds.length ||
    body.caseIds.some((id) => typeof id !== "string" || !ids.includes(id))
  )
    throw Error("请选择当前数据集中的不重复题目");
  return {
    name: body.name.trim(),
    description: (body.description as string | undefined)?.trim() ?? "",
    caseIds: ids.filter((id) => (body.caseIds as string[]).includes(id)),
  };
}

/** Group definitions are outside the dataset tree. Jobs retain their own immutable scope. */
export function groupStore(repoRoot: string, runs: string) {
  const directory = path.join(runs, "web-groups");
  let queue = Promise.resolve();
  const customFile = (id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("内置测评组不能修改或删除");
    return path.join(directory, `${id}.json`);
  };
  return {
    async list(ids: string[]): Promise<DatasetGroup[]> {
      const defaults: DatasetGroup[] = [
        {
          id: "default-60",
          name: "完整测评组",
          description: "默认组，包含当前数据集的全部题目。",
          caseIds: [...ids],
          builtin: true,
        },
      ];
      const builtin = await readFile(path.join(repoRoot, "evals/groups.json"), "utf8")
        .then((text) => JSON.parse(text) as Array<Record<string, unknown>>)
        .catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      for (const group of builtin) {
        if (
          typeof group.id !== "string" ||
          group.id === "default-60" ||
          defaults.some((g) => g.id === group.id)
        )
          throw Error("内置测评组标识重复或无效");
        defaults.push({ id: group.id, ...validateGroup(group, ids), builtin: true });
      }
      const custom: DatasetGroup[] = [];
      for (const file of await readdir(directory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
        const group = JSON.parse(
          await readFile(path.join(directory, file), "utf8"),
        ) as DatasetGroup;
        if (`${group.id}.json` !== file) throw Error("测评组标识与文件不一致");
        custom.push({
          ...group,
          ...validateGroup(group as unknown as Record<string, unknown>, ids),
          builtin: false,
        });
      }
      return [
        ...defaults,
        ...custom.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
      ];
    },
    async save(body: Record<string, unknown>, ids: string[], id?: string) {
      const value = validateGroup(body, ids),
        groupId = id ?? randomUUID(),
        file = customFile(groupId);
      const work = queue.then(async () => {
        await mkdir(directory, { recursive: true });
        const previous = id
          ? (JSON.parse(await readFile(file, "utf8")) as DatasetGroup)
          : undefined;
        const now = new Date().toISOString();
        const group: DatasetGroup = {
          id: groupId,
          ...value,
          builtin: false,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(group, null, 2));
        await rename(temporary, file);
        return group;
      });
      queue = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
    async remove(id: string) {
      const file = customFile(id);
      const work = queue.then(() => unlink(file));
      queue = work.catch(() => undefined);
      await work;
    },
  };
}
