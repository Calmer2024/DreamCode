// Tighten CASE-001 acceptance in the candidate only. No model calls.
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
const root = path.resolve("evals/dataset-candidate-2026-10-10/cases/CASE-001");
const baseline = path.resolve("evals/dataset/cases/CASE-001/workspace");
const files = {},
  tests = {};
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else {
      const relative = path.relative(baseline, file).replaceAll("\\", "/");
      const text = await readFile(file, "utf8");
      if (relative.startsWith("src/")) files[relative] = text;
      if (
        relative.startsWith("tests/") &&
        entry.name.startsWith("test_") &&
        entry.name.endsWith(".py")
      )
        tests[relative] = [...text.matchAll(/^\s*(?:async )?def (test_\w+)\(/gm)].map((m) => m[1]);
    }
  }
}
await visit(baseline);
const packed = gzipSync(JSON.stringify({ files, tests })).toString("base64");
const original = await readFile("evals/dataset/cases/CASE-001/tests/check.py", "utf8");
const extra = `
import ast, os, shutil, base64
BASELINE = json.loads(gzip.decompress(base64.b64decode(${JSON.stringify(packed)})))

def explicit_help():
    def version(ctx,param,value):
        if value:
            click.echo("VERSION")
            ctx.exit()
    @click.command(add_help_option=False)
    @click.help_option("--help", "-h")
    @click.option("--version",is_flag=True,is_eager=True,expose_value=False,callback=version)
    @click.argument("name",required=True)
    def cli(name): click.echo("hello "+name)
    runner=CliRunner()
    for alias in ("--help", "-h"):
        r=runner.invoke(cli,[alias,"--version"])
        assert r.exit_code==0 and "Usage:" in r.output and "VERSION" not in r.output, r.output
        r=runner.invoke(cli,["--version",alias])
        assert r.exit_code==0 and r.output.strip()=="VERSION", r.output
    assert runner.invoke(cli,["Ada"]).output.strip()=="hello Ada"
    assert runner.invoke(cli,[]).exit_code==2

def general_order():
    # Existing tests exercise normal eager/non-eager ordering, not only our fixture.
    env=dict(os.environ, PYTHONPATH="/workspace/src")
    r=subprocess.run([sys.executable,"-m","pytest","-q","-p","no:cacheprovider",
        "tests/test_basic.py::test_evaluation_order"],cwd="/workspace",env=env,
        capture_output=True,text=True,timeout=15)
    assert r.returncode==0, r.stdout+r.stderr

def added_regression():
    candidates=[]
    for file in pathlib.Path("/workspace/tests").rglob("test_*.py"):
        relative=file.relative_to("/workspace").as_posix()
        existing=set(BASELINE["tests"].get(relative,[]))
        tree=ast.parse(file.read_text())
        for node in tree.body:
            if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name.startswith("test_") and node.name not in existing:
                candidates.append(relative+"::"+node.name)
    assert candidates, "Add a new top-level pytest regression test that fails before the fix and passes after it"
    assert len(candidates)<=30, "Regression probe is bounded to 30 new test functions"
    with tempfile.TemporaryDirectory() as temporary:
        fixed=pathlib.Path(temporary)/"fixed"
        shutil.copytree("/workspace",fixed,ignore=shutil.ignore_patterns(".git","__pycache__",".pytest_cache"))
        before=pathlib.Path(temporary)/"before"
        shutil.copytree(fixed,before)
        shutil.rmtree(before/"src")
        for relative,text in BASELINE["files"].items():
            destination=before/relative
            destination.parent.mkdir(parents=True,exist_ok=True)
            destination.write_text(text)
        def run(directory):
            env=dict(os.environ,PYTHONPATH=str(directory/"src"))
            return subprocess.run([sys.executable,"-m","pytest","-q","-p","no:cacheprovider",*candidates],
                cwd=directory,env=env,capture_output=True,text=True,timeout=15)
        good=run(fixed)
        assert good.returncode==0 and "passed" in good.stdout, good.stdout+good.stderr
        bad=run(before)
        # Require actual failing assertions, not import/collection errors or skips.
        assert bad.returncode==1 and "AssertionError" in bad.stdout, "The added test must fail by assertion against the original source: "+bad.stdout+bad.stderr

def parser_subclass():
    class ExistingCommand(click.Command):
        def make_parser(self,ctx):
            return super().make_parser(ctx)
    @click.command(cls=ExistingCommand)
    def cli(): click.echo("ok")
    result=CliRunner().invoke(cli,[])
    assert result.exit_code==0 and result.output=="ok\\n", repr(result.exception)+result.output

check("p2p:explicit-help",explicit_help)
check("p2p:general-order",general_order)
check("f2p:added-regression",added_regression)
check("p2p:parser-subclass",parser_subclass)
print(json.dumps({"checks":checks}))
`;
await writeFile(
  path.join(root, "tests/check.py"),
  original.replace('print(json.dumps({"checks": checks}))', "") + extra,
);
const config = JSON.parse(await readFile(path.join(root, "acceptance.json"), "utf8"));
config.criteria = [
  ...config.criteria.filter(
    (c) =>
      ![
        "p2p:explicit-help",
        "p2p:general-order",
        "f2p:added-regression",
        "p2p:parser-subclass",
      ].includes(c.id),
  ),
  {
    id: "p2p:explicit-help",
    description: "Explicit help decorators preserve help/version ordering and ordinary commands",
  },
  {
    id: "p2p:general-order",
    description: "Existing general eager and non-eager callback ordering test passes",
  },
  {
    id: "f2p:added-regression",
    description:
      "At least one added regression test passes after repair and fails by assertion on original source",
  },
  {
    id: "p2p:parser-subclass",
    description: "Existing Command subclasses overriding make_parser(ctx) keep working",
  },
];
config.program.timeoutMs = 45000;
await writeFile(path.join(root, "acceptance.json"), JSON.stringify(config, null, 2) + "\n");
console.log("Candidate CASE-001 acceptance now checks six task requirements");
