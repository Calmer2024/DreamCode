param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$cleanupRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$protectedRoots = @('evals/dataset', 'evals/dataset-candidate-2026-10-10')
foreach ($relative in $protectedRoots) {
    if (-not (Test-Path -LiteralPath (Join-Path $cleanupRoot "$relative/dataset.json"))) {
        throw "Protected dataset missing: $relative"
    }
}

$targets = @(
    'evals/tasks',
    'evals/fixtures',
    'docs/evals/archive',
    '.archive/dreameval-v2-2026-10-10',
    'packages/evals/src/agents.ts',
    'packages/evals/src/agents.test.ts',
    'packages/evals/src/index.test.ts'
)
$runsRoot = Join-Path $cleanupRoot 'evals/runs'
if (Test-Path -LiteralPath $runsRoot) {
    $targets += @(Get-ChildItem -LiteralPath $runsRoot -Directory |
        Where-Object { $_.Name -match '^(B01-|F01-|K01-|suite-|web-|v2-|dataset-v2-)' } |
        ForEach-Object { $_.FullName })
}
$resolvedTargets = @($targets | ForEach-Object {
    $candidate = [IO.Path]::GetFullPath((Join-Path $cleanupRoot $_))
    if ([IO.Path]::IsPathRooted($_)) { $candidate = [IO.Path]::GetFullPath($_) }
    if (-not $candidate.StartsWith($cleanupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Target outside workspace: $candidate"
    }
    foreach ($relative in $protectedRoots) {
        $protectedPath = [IO.Path]::GetFullPath((Join-Path $cleanupRoot $relative))
        if ($candidate -eq $protectedPath -or
            $candidate.StartsWith($protectedPath + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $protectedPath.StartsWith($candidate + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Target overlaps protected dataset: $candidate"
        }
    }
    if (Test-Path -LiteralPath $candidate) { (Resolve-Path -LiteralPath $candidate).Path }
})

Write-Output 'Legacy paths to remove:'
$resolvedTargets | ForEach-Object { Write-Output $_ }
if (-not $Apply) {
    Write-Output 'Preview only. Run with -Apply to clean and update references.'
    return
}

# Fingerprint case contracts and manifests before touching legacy data.
$protectedFiles = @($protectedRoots | ForEach-Object {
    Get-ChildItem -LiteralPath (Join-Path $cleanupRoot $_) -Recurse -File |
        Where-Object { $_.Name -in @('dataset.json', 'case.json', 'execution.json') } |
        ForEach-Object { $_.FullName }
})
$beforeHashes = @(Get-FileHash -LiteralPath $protectedFiles)
foreach ($target in $resolvedTargets) {
    Remove-Item -LiteralPath $target -Recurse -Force
}

$utf8 = [Text.UTF8Encoding]::new($false)
function Write-WorkspaceFile([string]$Relative, [string]$Content) {
    [IO.File]::WriteAllText((Join-Path $cleanupRoot $Relative), $Content, $utf8)
}
function Replace-WorkspaceText([string]$Relative, [string]$Old, [string]$New) {
    $file = Join-Path $cleanupRoot $Relative
    $content = [IO.File]::ReadAllText($file)
    if ($content.Contains($Old)) { Write-WorkspaceFile $Relative ($content.Replace($Old, $New)) }
}

# Existing package/bin paths now use the current dataset implementation.
Write-WorkspaceFile 'packages/evals/src/index.ts' "export * from `"./dataset/index.js`";`n"
Write-WorkspaceFile 'packages/evals/src/cli.ts' "import `"./dataset/cli.js`";`n"

# Desktop E2E already has generators for all three scenarios it uses.
$desktopFile = 'packages/desktop/e2e/fixtures.ts'
$desktop = [IO.File]::ReadAllText((Join-Path $cleanupRoot $desktopFile))
$desktop = $desktop.Replace('import { cp, mkdir,', 'import { mkdir,')
$desktop = $desktop -replace 'import \{ existsSync \} from "node:fs";\r?\n', ''
$desktop = $desktop -replace 'const repositoryRoot = path.resolve\(packageRoot, "../\.\."\);\r?\n', ''
$desktop = $desktop -replace '(?s)  const fixturePath = path.join\(repositoryRoot, "evals", "fixtures", fixtureName\);\r?\n  if \(existsSync\(fixturePath\)\) \{.*?\r?\n  \}', '  await createFallbackFixture(workspace, fixtureName);'
Write-WorkspaceFile $desktopFile $desktop

Replace-WorkspaceText '.gitignore' "!evals/fixtures/safety/.env`r`n" ''
Replace-WorkspaceText '.gitignore' "!evals/fixtures/safety/.env`n" ''
Replace-WorkspaceText 'README.md' 'pnpm dreamcode --provider fake --cwd evals/fixtures/failing-test-js "修复当前项目的测试失败, 并运行测试确认。"' 'pnpm dreamcode'
Replace-WorkspaceText 'README.md' 'node packages/cli/dist/main.js --provider fake --cwd evals/fixtures/readme-update "根据 package.json 和源码更新 README 的使用说明。"' 'node packages/cli/dist/main.js'
Replace-WorkspaceText 'README.md' '[历史评分与操作资料](docs/evals/archive/README.md) 已归档，不作为新实现依据。' '旧数据集设计、题库和运行数据已清理。'
Replace-WorkspaceText 'README.md' '现存真实模型评测报告见 [历史运行报告](docs/evals/archive/README.md#历史运行报告)。' '当前数据集试跑状态见 [候选数据集修订记录](docs/evals/DreamEval-dataset-real-trial-revision-2026-10-10.md)。'
Replace-WorkspaceText 'docs/evals/README.md' '旧数据集保留历史用途。' '旧数据集及设计归档已清理。'
Replace-WorkspaceText 'docs/evals/README.md' '## 历史资料' '## 数据集保留范围'
Replace-WorkspaceText 'docs/evals/README.md' '[归档索引](archive/README.md) 保存旧方案、评审、运行报告、审核证据和示例，供追溯使用，不作为新实现依据。' '保留正式数据集 `evals/dataset`（1.0.1）与候选数据集 `evals/dataset-candidate-2026-10-10`（1.1.0-candidate.4），以及两者的设计、验证和运行记录。候选尚未成为默认入口，详见 [真实试跑与修订记录](DreamEval-dataset-real-trial-revision-2026-10-10.md)。旧 52 题题库、退役 V2 题库和旧设计归档已删除。'
Replace-WorkspaceText 'docs/evals/README.md' '旧结论被替代后移入归档，不在根目录保留多个竞争入口。' '被替代的旧数据集资料应清理，当前入口保持一致。'
Replace-WorkspaceText 'docs/evals/DreamEval-dataset-60-implementation-report-2026-10-10.md' '旧文档保留在[归档索引](archive/README.md)，活动文档入口已经指向当前决策、实施计划和本报告。' '旧文档归档已清理，活动文档入口指向当前决策、实施计划和本报告。'
Replace-WorkspaceText 'docs/evals/DreamEval-dataset-60-implementation-plan-2026-10-09.md' '建议新数据集位于 `evals/dataset/`；现有 `evals/dataset-v2/` 在新数据集完成前保持为旧实现，不作为新格式的兼容入口。' '新数据集位于 `evals/dataset/`；退役 `evals/dataset-v2/` 及其归档已清理。'
Replace-WorkspaceText 'docs/evals/DreamEval-platform-ui-cleanup-2026-10-10.md' '- 旧材料进入 `.archive/dreameval-v2-2026-10-10`，包含原路径结构和 `manifest.json`；目录已排除版本管理与当前构建。恢复归档不属于兼容入口。' '- 旧材料曾进入 `.archive/dreameval-v2-2026-10-10`；随后按用户要求清理了该归档、旧数据集与旧运行数据。'

$architecturePath = 'docs/architecture/dreamcode-architecture.md'
$architecture = [IO.File]::ReadAllText((Join-Path $cleanupRoot $architecturePath))
$architecture = $architecture -replace '(?s)建立 `evals/tasks/`:.*?这是学习 agent 产品最关键的工程资产之一。', '当前任务评测使用 `evals/dataset/` 的六字段 case 协议，修订试跑使用 `evals/dataset-candidate-2026-10-10/`。旧 `evals/tasks/` 题库已清理。设计与运行规则见 [DreamEval 文档入口](../evals/README.md)。'
Write-WorkspaceFile $architecturePath $architecture

foreach ($before in $beforeHashes) {
    if ((Get-FileHash -LiteralPath $before.Path).Hash -ne $before.Hash) {
        throw "Protected file changed: $($before.Path)"
    }
}
foreach ($target in $resolvedTargets) {
    if (Test-Path -LiteralPath $target) { throw "Legacy path still exists: $target" }
}
Write-Output "Cleaned $($resolvedTargets.Count) legacy paths; protected dataset contracts unchanged."
Write-Output 'Run pnpm typecheck, pnpm test, and pnpm --filter @dreamcode/evals build to verify and refresh compiled outputs.'
