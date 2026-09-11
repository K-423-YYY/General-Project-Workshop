# ============================================================
# selftest.ps1 - 自检：核对 Harness 结构是否完整（按需运行）
# 用法: .\内置\scripts\selftest.ps1
#
# 第 2 段（清单更新）：原来只有 27 项、覆盖的是老 harness 的结构；
# 现在补上 .claude\ 机制层、自定义\bin\、自定义\scripts\、两个能力表、规则源.md、
# 引擎适配\、prompt-模板\、日志中心，并**调用 自定义\scripts\selftest-ext.mjs** 做
# 「引用完整性 / 8 工具 × 3 形态 / 内置区 BOM / 源码里不再有 .harness\logs」这类语义核对。
# 分工：本脚本管"该有的东西在不在"（快、只看路径）；selftest-ext.mjs 管"在的东西对不对"。
# ============================================================
$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HarnessRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$WorkRoot = Split-Path -Parent $HarnessRoot

$required = @(
  '开始项目.md','使用说明.md',
  # ---- 自定义区：规则 / 流程 / 技能 / 模板 ----
  '自定义\对话协议.md',
  '自定义\流程\万能项目开发流程模板.md',
  '自定义\skills\README.md',
  '自定义\skills\skill-audit\SKILL.md',
  '自定义\skills\project-workflow\SKILL.md',
  '自定义\templates\方案模板.md',
  '自定义\templates\需求与理念模板.md',
  '自定义\项目规则模板\AGENTS.template.md',
  '自定义\项目规则模板\CLAUDE.template.md',
  '自定义\项目规则模板\trae-project_rules.template.md',
  # ---- 自定义区：第 1~2 段新增（包装层 / 能力层 / 能力表 / 规则源 / 引擎适配 / prompt 模板）----
  '自定义\bin\_log.mjs',
  '自定义\bin\_env.sh',
  '自定义\bin\README.md',
  '自定义\scripts\env-doctor.mjs',
  '自定义\scripts\probe-model.mjs',
  '自定义\scripts\probe-engines.mjs',
  '自定义\scripts\scaffold-ext.mjs',
  '自定义\scripts\gen-rules.mjs',
  '自定义\scripts\build-prompt.mjs',
'自定义\scripts\audit.mjs',
'自定义\scripts\audit-rules.json',
'自定义\scripts\purity-check.mjs',
'自定义\scripts\selftest-ext.mjs',
  '自定义\scripts\lib\resolve-command.mjs',
  '自定义\scripts\lib\engine-detect.mjs',
  '自定义\scripts\lib\model-capability.mjs',
  '自定义\scripts\lib\log-center.mjs',
  '自定义\scripts\tests\hooks-selftest.mjs',
  '自定义\scripts\tests\context-selftest.mjs',
  '自定义\scripts\tests\scaffold-selftest.mjs',
  '自定义\scripts\tests\probe-selftest.mjs',
  '自定义\scripts\tests\engine-probe-selftest.mjs',
  '自定义\scripts\tests\wrappers-selftest.mjs',
'自定义\scripts\tests\model-learning-selftest.mjs',
'自定义\scripts\tests\purity-selftest.mjs',
'自定义\scripts\tests\rules-selftest.mjs',
  '自定义\模型能力表.json',
  '自定义\引擎能力表.json',
  '自定义\规则源.md',
  '自定义\引擎适配\README.md',
  '自定义\引擎适配\引擎能力矩阵.md',
  '自定义\引擎适配\codex\README.md',
  '自定义\引擎适配\claude-code\README.md',
  '自定义\引擎适配\dsh\README.md',
  '自定义\引擎适配\traecode\README.md',
  '自定义\skills\spec\SKILL.md',
  '自定义\prompt-模板\基础.md',
  '自定义\prompt-模板\硬规则.md',
  '自定义\prompt-模板\引擎\codex-cli.md',
  '自定义\prompt-模板\引擎\claude-code.md',
  '自定义\prompt-模板\引擎\deepseek-harness.md',
  '自定义\prompt-模板\引擎\traecode-cli.md',
  # ---- 内置区 ----
  '内置\adapters\codex-client.md',
  '内置\adapters\claude-code-client.md',
  '内置\adapters\claude-code-terminal.md',
  '内置\adapters\deepseek-harness.md',
  '内置\adapters\trae-ide-cn.md',
  '内置\adapters\trae-ide-intl.md',
  '内置\adapters\trae-work.md',
  '内置\adapters\traecode-cli.md',
  '内置\adapters\_detect.ps1',
  '内置\scripts\scaffold.ps1',
  '内置\scripts\cleanup.ps1',
  '内置\scripts\verify.ps1',
  '内置\scripts\selftest.ps1',
  '内置\engine\run.ps1',
  '内置\engine\run.bat',
  '内置\engine\run.sh',
  # ---- 工作区根：机制层与日志中心 ----
  '.claude\settings.json',
  '.claude\hooks\guard-bash.mjs',
  '.claude\hooks\guard-tools.mjs',
  '.claude\hooks\shape-output.mjs',
  '.claude\hooks\compact-instructions.mjs',
  '.claude\hooks\inject-rules.mjs',
  '.claude\hooks\on-stop.mjs',
  '.claude\hooks\statusline.mjs',
  '.claude\hooks\verify-gate.mjs',
  '.claude\hooks\log-summary.mjs',
  '.claude\hooks\lib\policy.mjs',
  '.claude\hooks\lib\log-center.mjs',
  '.claude\hooks\lib\learn.mjs',
  '日志\README.md'
)

# 注意：'.claude\...' 与 '日志\...' 是**工作区根**下的路径，其余都在 AI-Dev-Harness\ 下。
# 全新克隆里 日志\ 可能还没被创建（git 不跟踪空目录）——日志中心本来就"用到即建"，
# 所以核对清单前先做一次幂等初始化；这样"刚克隆、什么都没跑过"也不会假红。
$logCli = Join-Path $HarnessRoot '自定义\scripts\lib\log-center.mjs'
if ((Test-Path -LiteralPath $logCli) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  & node $logCli 'init' | Out-Null
}

$missing = @($required | Where-Object {
  $rel = $_
  if ($rel -like '.claude\*' -or $rel -like '日志\*') { $base = $WorkRoot } else { $base = $HarnessRoot }
  -not (Test-Path -LiteralPath (Join-Path $base $rel))
})

Write-Host ("清单核对：$($required.Count) 项，缺少 $($missing.Count) 项。")
if ($missing.Count -gt 0) {
  Write-Host '缺少以下文件/目录：'
  $missing | ForEach-Object { Write-Host ('  - ' + $_) }
}

# ---- 扩展自检：语义一致性（引用完整性 / 形态齐全 / 编码 / 迁移完整性）----
$ext = Join-Path $HarnessRoot '自定义\scripts\selftest-ext.mjs'
$extCode = 1
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '扩展自检：未安装 node，无法运行 selftest-ext.mjs' -ForegroundColor Red
} elseif (-not (Test-Path -LiteralPath $ext)) {
  Write-Host "扩展自检：缺少 $ext" -ForegroundColor Red
} else {
  & node $ext
  $extCode = $LASTEXITCODE
}

if ($missing.Count -eq 0 -and $extCode -eq 0) {
  Write-Host '自检通过：清单齐全 + 扩展自检全绿。' -ForegroundColor Green
  exit 0
} else {
  Write-Host "自检失败：清单缺 $($missing.Count) 项，扩展自检退出码 $extCode。" -ForegroundColor Red
  exit 1
}
