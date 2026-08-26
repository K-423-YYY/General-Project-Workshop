# ============================================================
# selftest.ps1 - 自检：核对 Harness 结构是否完整（按需运行）
# 用法: .\内置\scripts\selftest.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HarnessRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)

$required = @(
  '开始项目.md','使用说明.md',
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
  '内置\adapters\codex-client.md',
  '内置\adapters\claude-code-client.md',
  '内置\adapters\claude-code-terminal.md',
  '内置\adapters\deepseek-harness.md',
  '内置\adapters\trae-ide-cn.md',
  '内置\adapters\trae-ide-intl.md',
  '内置\adapters\trae-work.md',
  '内置\adapters\traecode-cli.md',
  '内置\scripts\scaffold.ps1',
  '内置\scripts\cleanup.ps1',
  '内置\scripts\verify.ps1',
  '内置\scripts\selftest.ps1',
  '内置\engine\run.ps1',
  '内置\engine\run.bat',
  '内置\engine\run.sh'
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $HarnessRoot $_)) })
if ($missing.Count -eq 0) {
  Write-Host '自检通过：所有关键文件齐全。'
  exit 0
} else {
  Write-Host '自检失败，缺少以下文件：'
  $missing | ForEach-Object { Write-Host ('  - ' + $_) }
  exit 1
}
