# ============================================================
# verify.ps1 - 最小静态验证（按需运行，无后台进程）
# 检查项目根常见工程文件是否就绪，并尽量运行轻量验证。
# 用法: .\内置\scripts\verify.ps1 [-ProjectRoot "..\项目名"]
# ============================================================
[CmdletBinding()]
param([string]$ProjectRoot = '')
$ErrorActionPreference = 'Continue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HarnessRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
if (-not $ProjectRoot) { $ProjectRoot = Join-Path (Split-Path -Parent $HarnessRoot) '我的项目' }
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $ProjectRoot)) { Write-Error "项目文件夹不存在: $ProjectRoot"; exit 1 }

$ok = $true
# Node 项目
if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json')) {
  Write-Host '[node] 检测到 package.json'
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules')) {
    Push-Location $ProjectRoot
    try { & npm test --silent 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $ok = $false; Write-Warning '[node] npm test 失败' } } finally { Pop-Location }
  } else { Write-Host '[node] 未安装依赖，跳过 npm test（可在开发期安装后验证）' }
}
# Python 项目
$pyFiles = @(Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -Filter '*.py' -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($pyFiles) {
  Write-Host '[python] 检测到 .py 文件'
  if (Get-Command python -ErrorAction SilentlyContinue) {
    $bad = @(Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -Filter '*.py' -ErrorAction SilentlyContinue | Where-Object { $py = $_.FullName; $null = & python -m py_compile $py 2>&1; $LASTEXITCODE -ne 0 })
    if ($bad.Count -gt 0) { $ok = $false; Write-Warning '[python] 语法检查存在失败文件' }
  }
}
# 静态站点
if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'index.html')) { Write-Host '[web] 检测到 index.html' }

if ($ok) { Write-Host '验证通过（最小检查）。'; exit 0 } else { Write-Host '验证存在失败项。'; exit 1 }
