# ============================================================
# _detect.ps1 - 终端模式：自动识别当前可用的 AI 引擎
# 优先级：ENGINE 环境变量 > 自动检测 > unsupported
# 返回: codex-cli | claude-code | deepseek-harness | traecode-cli | unsupported
# ============================================================
function Get-Engine {
  if ($env:ENGINE) {
    $e = $env:ENGINE.ToLower()
    switch ($e) {
      'codex-cli' { return 'codex-cli' }
      'claude-code' { return 'claude-code' }
      'deepseek-harness' { return 'deepseek-harness' }
      'traecode-cli' { return 'traecode-cli' }
      default { Write-Host "未知 ENGINE=$env:ENGINE，回退自动检测" }
    }
  }
  if (Get-Command codex -ErrorAction SilentlyContinue) { return 'codex-cli' }
  if (Get-Command claude -ErrorAction SilentlyContinue) { return 'claude-code' }
  if (Get-Command dsh -ErrorAction SilentlyContinue) { return 'deepseek-harness' }
  if (Get-Command traecode -ErrorAction SilentlyContinue) { return 'traecode-cli' }
  return 'unsupported'
}
