// Reuse the independently verified fail-before/pass-after probe for additional Python cases.
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
const template = await readFile(
  "evals/dataset-candidate-2026-10-10/cases/CASE-001/tests/check.py",
  "utf8",
);
const probe = template.slice(
  template.indexOf("def added_regression():"),
  template.indexOf('check("p2p:explicit-help"'),
);
for (const id of process.argv.slice(2)) {
  const candidate = `evals/dataset-candidate-2026-10-10/cases/${id}`;
  const original = `evals/dataset/cases/${id}`;
  const c = JSON.parse(await readFile(candidate + "/case.json", "utf8"));
  if (c.metadata.project !== "httpx")
    throw Error("Only independently checked HTTPX adaptation enabled");
  const files = {},
    tests = {};
  async function visit(directory) {
    for (const e of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, e.name);
      if (e.isDirectory()) await visit(file);
      else {
        const relative = path.relative(original + "/workspace", file).replaceAll("\\", "/");
        const text = await readFile(file, "utf8");
        if (relative.startsWith("httpx/")) files[relative] = text;
        if (relative.startsWith("tests/") && e.name.startsWith("test_") && e.name.endsWith(".py"))
          tests[relative] = [...text.matchAll(/^\s*(?:async )?def (test_\w+)\(/gm)].map(
            (m) => m[1],
          );
      }
    }
  }
  await visit(original + "/workspace");
  const packed = gzipSync(JSON.stringify({ files, tests })).toString("base64");
  const base = await readFile(original + "/tests/check.py", "utf8");
  const adapted = probe
    .replace('before/"src"', 'before/"httpx"')
    .replace('str(directory/"src")', "str(directory)");
  await writeFile(
    candidate + "/tests/check.py",
    base.replace('print(json.dumps({"checks": checks}))', "") +
      `\nimport ast, os, shutil, base64\nBASELINE=json.loads(gzip.decompress(base64.b64decode(${JSON.stringify(packed)})))\n` +
      adapted +
      '\ncheck("f2p:added-regression",added_regression)\nprint(json.dumps({"checks":checks}))\n',
  );
  const config = JSON.parse(await readFile(candidate + "/acceptance.json", "utf8"));
  config.criteria = config.criteria.filter((c) => c.id !== "f2p:added-regression");
  config.criteria.push({
    id: "f2p:added-regression",
    description:
      "An added pytest regression test passes after repair and fails by assertion on original source",
  });
  config.program.timeoutMs = 45000;
  await writeFile(candidate + "/acceptance.json", JSON.stringify(config, null, 2) + "\n");
  await writeFile(
    candidate + "/instruction.md",
    (await readFile(candidate + "/instruction.md", "utf8")) +
      "\n新增回归测试使用独立顶层 test_ 函数，可由 pytest 收集；修复前必须断言失败、修复后通过。相关参数实现位于 httpx/_urls.py，已有参数测试位于 tests/test_urls.py。\n",
  );
  console.log(id + " regression acceptance tightened");
}
