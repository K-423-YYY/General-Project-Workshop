# ============================================================
# cleanup.ps1 - 纯净化清理：归档 .harness\，删除项目内脚手架
# 仅在用户确认「结束并清理」后运行；无后台进程。
# 用法:
#   .\内置\scripts\cleanup.ps1 -ProjectRoot "..\我的项目" [-Commit]
# ============================================================
[CmdletBinding()]
param(
  [string]$ProjectRoot = '',
  [switch]$Commit
)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HarnessRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)

if (-not $ProjectRoot) {
  $ProjectRoot = Join-Path (Split-Path -Parent $HarnessRoot) '我的项目'
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ProjectName = Split-Path -Leaf $ProjectRoot

# 归档 .harness\ 到 state\<项目名>\harness\
$hDir = Join-Path $ProjectRoot '.harness'
if (Test-Path -LiteralPath $hDir) {
  $archive = Join-Path $HarnessRoot ("state\" + $ProjectName + "\harness")
  $null = New-Item -ItemType Directory -Force -Path $archive
  Copy-Item -LiteralPath (Join-Path $hDir '*') -Destination $archive -Recurse -Force
  Write-Host "OK 归档到 state\$ProjectName\harness"
}

# 删除项目内脚手架
foreach ($rel in @('AGENTS.md','CLAUDE.md','.harness')) {
  $fp = Join-Path $ProjectRoot $rel
  if (Test-Path -LiteralPath $fp) { Remove-Item -LiteralPath $fp -Recurse -Force; Write-Host "DEL $rel" }
}
$traeDir = Join-Path $ProjectRoot '.trae'
if (Test-Path -LiteralPath $traeDir) { Remove-Item -LiteralPath $traeDir -Recurse -Force; Write-Host 'DEL .trae' }

# 更新状态标记
$state = Join-Path $HarnessRoot ("state\" + $ProjectName + "\status.json")
$status = @{ project = $ProjectName; status = 'completed'; cleanedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
$status | ConvertTo-Json | Set-Content -LiteralPath $state -Encoding UTF8
Write-Host "OK 状态已标记: $state"

# 可选：git 提交纯净版
if ($Commit -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Push-Location $ProjectRoot
  try {
    & git add -A 2>$null | Out-Null
    & git commit -m "清理脚手架，交付纯净版" 2>$null | Out-Null
    Write-Host 'OK 已提交纯净版'
  } finally { Pop-Location }
}
Write-Host '纯净化清理完成。'
