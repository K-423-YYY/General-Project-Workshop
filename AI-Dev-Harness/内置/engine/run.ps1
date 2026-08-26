# ============================================================
# run.ps1 - 终端模式入口（可选；平时推荐直接用客户端对话框）
# 自动识别 AI 引擎，注入中文提示词与对话协议，指向同级项目文件夹。
# 用法:
#   .\内置\engine\run.bat "你的项目目标"
#   或 $env:PROJECT_ROOT="..\我的项目"; .\内置\engine\run.ps1 "目标"
# 仅在用户主动运行时执行，无后台进程。
# ============================================================
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InputArgs
)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path       # ...\内置\engine
$HarnessRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)  # ...\AI-Dev-Harness
$WorkRoot = Split-Path -Parent $HarnessRoot                        # ...\本文件夹

if ($env:PROJECT_ROOT) {
  $ProjectRoot = [System.IO.Path]::GetFullPath($env:PROJECT_ROOT)
} else {
  $ProjectRoot = Join-Path $WorkRoot '我的项目'
}
$null = New-Item -ItemType Directory -Force -Path $ProjectRoot
Set-Location -LiteralPath $ProjectRoot

. (Join-Path $HarnessRoot '内置\adapters\_detect.ps1')
$engine = Get-Engine
Write-Host "识别引擎: $engine | 项目: $ProjectRoot"
if ($engine -eq 'unsupported') {
  Write-Host '未检测到支持的 AI 引擎（codex / claude / dsh / traecode），请先安装其一，或用客户端对话框。'
  exit 1
}

$goal = ($InputArgs -join ' ').Trim()
if ([string]::IsNullOrWhiteSpace($goal)) { $goal = Read-Host '请输入项目目标' }

$prompt = "你是通用项目开发助手。请先完整读取并严格遵循工作目录上级的 ..\AI-Dev-Harness\自定义\对话协议.md，然后从阶段0开始与我协作。当前工作目录就是项目文件夹。用户目标：$goal。要求：全程中文对话、不让用户输入命令、所有路径用相对路径、不开启任何后台常驻进程。"

switch ($engine) {
  'codex-cli'        { & codex exec $prompt '--sandbox' 'workspace-write' '--skip-git-repo-check' }
  'claude-code'      { & claude '-p' $prompt '--output-format' 'text' '--dangerously-skip-permissions' }
  'deepseek-harness' {
    if (Get-Command dsh -ErrorAction SilentlyContinue) {
      & dsh '--profile' 'headless' $prompt
    } else {
      $hDir = Join-Path $ProjectRoot '.harness'
      $null = New-Item -ItemType Directory -Force -Path $hDir
      Set-Content -LiteralPath (Join-Path $hDir 'exec-prompt.md') -Value $prompt -Encoding UTF8
      Write-Host '已将执行指令写入 .harness\exec-prompt.md，请交给 DeepSeek Harness 中的 AI 执行。'
    }
  }
  'traecode-cli'     { & traecode $prompt }
  default            { Write-Host "引擎 $engine 暂不支持终端自动执行，请用客户端对话框。"; exit 1 }
}
