# ============================================================
# scaffold.ps1 - 生成项目脚手架（按软件最少化）
# 由 AI 在阶段 0/4 调用；也可手动运行。仅在需要时运行，无后台进程。
# 用法:
#   .\内置\scripts\scaffold.ps1 -ProjectRoot "..\我的项目" -Engine codex
#   Engine: codex | claude | trae | all
# ============================================================
[CmdletBinding()]
param(
  [string]$ProjectRoot = '',
  [string]$Engine = 'all'
)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path      # ...\内置\scripts
$HarnessRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir) # ...\AI-Dev-Harness

if (-not $ProjectRoot) {
  $ProjectRoot = Join-Path (Split-Path -Parent $HarnessRoot) '我的项目'
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$null = New-Item -ItemType Directory -Force -Path $ProjectRoot

$tplDir = Join-Path $HarnessRoot '自定义\项目规则模板'
$agentTpl = Join-Path $tplDir 'AGENTS.template.md'
$claudeTpl = Join-Path $tplDir 'CLAUDE.template.md'
$traeTpl = Join-Path $tplDir 'trae-project_rules.template.md'

$Engine = $Engine.ToLower()
$makeAgents = ($Engine -eq 'all' -or $Engine -eq 'codex')
$makeClaude = ($Engine -eq 'all' -or $Engine -eq 'claude')
$makeTrae   = ($Engine -eq 'all' -or $Engine -eq 'trae')

if ($makeAgents -and (Test-Path -LiteralPath $agentTpl)) {
  Copy-Item -LiteralPath $agentTpl -Destination (Join-Path $ProjectRoot 'AGENTS.md') -Force
  Write-Host 'OK AGENTS.md'
}
if ($makeClaude -and (Test-Path -LiteralPath $claudeTpl)) {
  Copy-Item -LiteralPath $claudeTpl -Destination (Join-Path $ProjectRoot 'CLAUDE.md') -Force
  Write-Host 'OK CLAUDE.md'
}
if ($makeTrae -and (Test-Path -LiteralPath $traeTpl)) {
  $traeDir = Join-Path $ProjectRoot '.trae\rules'
  $null = New-Item -ItemType Directory -Force -Path $traeDir
  Copy-Item -LiteralPath $traeTpl -Destination (Join-Path $traeDir 'project_rules.md') -Force
  Write-Host 'OK .trae\rules\project_rules.md'
}

# 工作区 .harness\（开发期存在，完成后自动清理）
$hDir = Join-Path $ProjectRoot '.harness'
$null = New-Item -ItemType Directory -Force -Path $hDir
$plan = Join-Path $hDir 'plan.md'
if (-not (Test-Path -LiteralPath $plan)) {
  $planLines = @(
    '# 执行计划（工作文件，完成后随 .harness 一并清理）',
    '',
    '- [ ] 待按《方案.md》拆分任务'
  )
  Set-Content -LiteralPath $plan -Value $planLines -Encoding UTF8
}
foreach ($f in @('ARCHITECTURE.md','CHECKPOINTS.md','STATUS.md','exec-prompt.md')) {
  $fp = Join-Path $hDir $f
  if (-not (Test-Path -LiteralPath $fp)) {
    Set-Content -LiteralPath $fp -Value ("# " + $f) -Encoding UTF8
  }
}

# .gitignore
$gi = Join-Path $ProjectRoot '.gitignore'
if (-not (Test-Path -LiteralPath $gi)) {
  $giLines = @('node_modules/','dist/','coverage/','.git/','.env','venv/','__pycache__/','*.log')
  Set-Content -LiteralPath $gi -Value $giLines -Encoding UTF8
}

# git init（仅当没有仓库时）
if (Get-Command git -ErrorAction SilentlyContinue) {
  Push-Location $ProjectRoot
  try {
    $ErrorActionPreference = 'Continue'
    & git rev-parse --is-inside-work-tree 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { & git init 2>&1 | Out-Null; Write-Host 'OK git init' }
  } finally { $ErrorActionPreference = 'Stop'; Pop-Location }
}

Write-Host "ProjectRoot: $ProjectRoot"
Write-Host "HarnessRoot: $HarnessRoot"
Write-Host '完成。接下来由 AI 按对话协议执行。'
