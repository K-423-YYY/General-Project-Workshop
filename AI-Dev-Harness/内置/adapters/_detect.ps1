# ============================================================
# _detect.ps1 —— 引擎列表 / 选择 / 记忆（第 3 段 · 锁定决策 10）
#
# ★ 设计原则：**引擎「装没装、装在哪」的判定只有一份实现** ——
#     AI-Dev-Harness\自定义\scripts\lib\engine-detect.mjs
#   （它再往下用第 1 段的统一解析器 resolve-command.mjs：.exe → .cmd → .bat → .com → 无扩展名）
#   本文件只做三件事，绝不自己扫 PATH：
#     1. 让 node 报出可用引擎列表（--json）
#     2. 读 / 写「上次用的引擎」（落盘在 HARNESS_STATE_DIR 或 <harness>\state\engine-choice.json）
#     3. node 不可用时退回 Get-Command 的尽力而为模式（fail-open，绝不让启动卡死）
#
# 为什么必须这么做：旧实现自己扫 PATH 且把**空扩展名排第一**，
# 实测后果就是「codex 明明装了，却被探成没有」—— 同一个误报也会影响引擎选择。
#
# 返回的引擎 id：codex-cli | claude-code | claude-code-desktop |
#                deepseek-harness | traecode-cli | trae-ide | unsupported
# ============================================================

# 上次选择落在哪：HARNESS_STATE_DIR 优先（锁定决策 4），否则 <harness>\state\
function Get-EngineStateDir {
  if ($env:HARNESS_STATE_DIR) { return [System.IO.Path]::GetFullPath($env:HARNESS_STATE_DIR) }
  return (Join-Path $HarnessRoot 'state')
}

function Get-EngineChoiceFile { return (Join-Path (Get-EngineStateDir) 'engine-choice.json') }

<#
 调 engine-detect.mjs 拿可用引擎清单。
 返回 @{ available=@(...); last=$null|string; default=$null|string; source='node'|'fallback'; stateDir=...; choiceFile=... }
 任何一步失败都返回 source='fallback' 的结果，绝不抛异常（fail-open）。
#>
function Get-EngineList {
  param([string]$HarnessRootPath)

  $fallback = @{
    available = @(); last = $null; default = $null
    source = 'fallback'; stateDir = $null; choiceFile = $null
  }
  $cli = Join-Path $HarnessRootPath '自定义\scripts\lib\engine-detect.mjs'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $fallback }
  if (-not (Test-Path -LiteralPath $cli)) { return $fallback }

  try {
    $raw = (& node $cli '--json' 2>$null) -join "`n"
    if ([string]::IsNullOrWhiteSpace($raw)) { return $fallback }
    $j = $raw | ConvertFrom-Json
  } catch {
    return $fallback
  }

  $list = @()
  foreach ($d in @($j.available)) {
    $list += [pscustomobject]@{
      id = [string]$d.id; label = [string]$d.label; kind = [string]$d.kind
      path = [string]$d.path; via = [string]$d.via
    }
  }
  return @{
    available = $list
    last = if ($j.last) { [string]$j.last } else { $null }
    default = if ($j.default) { [string]$j.default } else { $null }
    source = 'node'
    stateDir = [string]$j.stateDir
    choiceFile = [string]$j.choiceFile
  }
}

# 读「上次用的引擎」（文件级兜底：node 不可用时也能沿用）
function Read-EngineChoice {
  try {
    $f = Get-EngineChoiceFile
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    $j = (Get-Content -Raw -LiteralPath $f | ConvertFrom-Json)
    if ($j.engine) { return [string]$j.engine }
  } catch { }
  return $null
}

# 记住本次选择（写失败只出声，绝不影响启动）
function Save-EngineChoice {
  param([string]$EngineId, [string]$HarnessRootPath)
  try {
    $cli = Join-Path $HarnessRootPath '自定义\scripts\lib\engine-detect.mjs'
    if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $cli)) {
      & node $cli '--remember' $EngineId | Out-Null
      if ($LASTEXITCODE -eq 0) { return $true }
    }
    $dir = Get-EngineStateDir
    $null = New-Item -ItemType Directory -Force -Path $dir
    $obj = [pscustomobject]@{ engine = $EngineId; at = (Get-Date).ToUniversalTime().ToString('o') }
    Set-Content -LiteralPath (Get-EngineChoiceFile) -Value ($obj | ConvertTo-Json) -Encoding UTF8
    return $true
  } catch {
    Write-Host "引擎选择记忆: 写入失败（不影响启动）：$($_.Exception.Message)"
    return $false
  }
}

<#
 兼容老调用点：ENGINE 环境变量 > 上次选择 > 列表默认项 > Get-Command 兜底。
 交互式选择在 run.ps1 里做（本函数只负责「自动挑一个」）。
#>
function Get-Engine {
  param([string]$HarnessRootPath)

  if ($env:ENGINE) {
    $e = $env:ENGINE.ToLower()
    switch ($e) {
      'codex-cli' { return 'codex-cli' }
      'claude-code' { return 'claude-code' }
      'claude-code-desktop' { return 'claude-code-desktop' }
      'deepseek-harness' { return 'deepseek-harness' }
      'traecode-cli' { return 'traecode-cli' }
      'trae-ide' { return 'trae-ide' }
      default { Write-Host "未知 ENGINE=$env:ENGINE，回退自动检测" }
    }
  }

  $list = Get-EngineList -HarnessRootPath $HarnessRootPath
  if ($list.default) { return $list.default }
  if ($list.last) { return $list.last }

  # 最后的兜底：老行为（Get-Command）。只在前面的路全断时才会走到这里。
  if (Get-Command codex -ErrorAction SilentlyContinue) { return 'codex-cli' }
  if (Get-Command claude -ErrorAction SilentlyContinue) { return 'claude-code' }
  if (Get-Command dsh -ErrorAction SilentlyContinue) { return 'deepseek-harness' }
  if (Get-Command traecode -ErrorAction SilentlyContinue) { return 'traecode-cli' }
  return 'unsupported'
}
