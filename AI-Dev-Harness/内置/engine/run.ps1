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

# ---- 日志中心（第 2 段 · 要求 A）：写环境变量，供所有子进程（hooks / 包装器 / 脚本）复用 ----
# 为什么必须由启动器设：日志中心在**工作区根**（不在项目里），项目内会话的 hooks 靠这个变量
# 就能直接写到同一处；没设时它们才退化成"从 cwd 向上找 AI-Dev-Harness\"来推导。
$LogRoot = Join-Path $WorkRoot '日志'
$env:HARNESS_LOG_ROOT = $LogRoot
$LogCli = Join-Path $HarnessRoot '自定义\scripts\lib\log-center.mjs'

# ---- 中文编码要**尽早**设好（第 3 段）----
# 为什么提前到这里：下面要调 engine-detect.mjs 拿「可用引擎列表」，输出里全是中文标签；
# PowerShell 5.1 若还按 ANSI 解码，列表会变成乱码（引擎选择反而更难用）。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

# 写日志的统一入口：只追加、失败绝不影响启动（fail-open，但会在终端出声）
function Write-HarnessLog {
  param([string]$Category, [string]$File, [string]$Text)
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '日志: 未安装 node，跳过写日志'; return }
  if (-not (Test-Path -LiteralPath $LogCli)) { Write-Host "日志: 缺少 $LogCli，跳过写日志"; return }
  $tmp = Join-Path $env:TEMP ("harness-log-{0}.txt" -f ([guid]::NewGuid().ToString('N')))
  try {
    # 中文内容先落 UTF-8 临时文件再交给 node 读，避免 PowerShell 管道编码把中文写坏
    Set-Content -LiteralPath $tmp -Value $Text -Encoding UTF8
    & node $LogCli 'append' '--category' $Category '--file' $File '--from' $tmp | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "日志: 写入 $Category\$File 退出码 $LASTEXITCODE（不影响启动）" }
  } catch {
    Write-Host "日志: 写入失败（不影响启动）：$($_.Exception.Message)"
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

if ($env:PROJECT_ROOT) {
  $ProjectRoot = [System.IO.Path]::GetFullPath($env:PROJECT_ROOT)
} else {
  $ProjectRoot = Join-Path $WorkRoot '我的项目'
}
$null = New-Item -ItemType Directory -Force -Path $ProjectRoot
Set-Location -LiteralPath $ProjectRoot

# ---- 项目内机制层（第 5 批 · A13）：确保 <项目>\.claude\ 存在 ----
# 为什么必须在启动前做：Claude Code 用「会话 cwd」当项目根，**不向上寻找** .claude\settings.json
# （第 2 批实测）。本脚本的 cwd 就是上面 Set-Location 到的项目目录，
# 所以项目内没有 .claude\ 时，hooks（拦截 / 输出整形 / 状态栏）在这条主路径上完全不生效。
# --rules none：规则文件由 内置\scaffold.ps1 与对话协议负责，启动器只管机制层。
# 幂等、fail-open：node 缺失或脚本不存在时静默跳过，绝不影响启动。
$scaffoldExt = Join-Path $HarnessRoot '自定义\scripts\scaffold-ext.mjs'
if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $scaffoldExt)) {
  try {
    # 注意：不要写成 `... 2>&1 | Out-Null` —— $ErrorActionPreference='Stop' 下
    # 合并 stderr 会让 PowerShell 把原生命令的 stderr 当异常抛出（PS 5.1 的老毛病）。
    & node $scaffoldExt '--project' $ProjectRoot '--rules' 'none' '--quiet' | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host '机制层: .claude\ 已就绪'
    } else {
      Write-Host '机制层: 未完全就绪（跑 node 自定义\scripts\scaffold-ext.mjs --project . 看详情）'
    }
  } catch { Write-Host '机制层: 同步失败，跳过（不影响启动）' }
}

# _detect.ps1 没有 UTF-8 BOM，PowerShell 5.1 会按 ANSI 读其中文而解析失败。
# 这里显式按 UTF-8 读出再点源，从而不必改动 内置\ 下的文件。
$detectPath = Join-Path $HarnessRoot '内置\adapters\_detect.ps1'
$detectSrc = [System.IO.File]::ReadAllText($detectPath, [System.Text.Encoding]::UTF8)
. ([ScriptBlock]::Create($detectSrc))

# ════════════════════════════════════════════════════════════
# 引擎选择（第 3 段 · 锁定决策 10）
#   列出可用引擎 → 回车沿用上次选择 → 选择结果落盘，下次回车继续沿用。
#   非交互（管道/CI/HARNESS_NONINTERACTIVE=1/显式 $env:ENGINE）一律自动挑，**不阻塞**。
# ════════════════════════════════════════════════════════════
$engineList = Get-EngineList -HarnessRootPath $HarnessRoot
$engine = $null

if ($env:ENGINE) {
  $engine = Get-Engine -HarnessRootPath $HarnessRoot
  Write-Host "引擎: 由环境变量 ENGINE 指定 → $engine（跳过选择）"
} else {
  $interactive = -not $env:HARNESS_NONINTERACTIVE
  try { if ([Console]::IsInputRedirected) { $interactive = $false } } catch { $interactive = $false }

  $avail = @($engineList.available)
  if ($avail.Count -eq 0) {
    $engine = Get-Engine -HarnessRootPath $HarnessRoot   # 兜底
  } elseif (-not $interactive -or $avail.Count -eq 1) {
    $engine = $engineList.default
    $why = if ($avail.Count -eq 1) { '本机只有这一个可用引擎' } else { '非交互式启动' }
    Write-Host "引擎: $why → $engine（可用引擎 $($avail.Count) 个；要换用 `$env:ENGINE=<id>）"
  } else {
    Write-Host ''
    Write-Host '── 可用引擎 ──────────────────────────────────────────────'
    for ($i = 0; $i -lt $avail.Count; $i++) {
      $d = $avail[$i]
      $tag = if ($d.kind -eq 'cli') { '可直接启动' } else { '仅生成启动词（图形端）' }
      $last = if ($d.id -eq $engineList.default -and $d.id -eq $engineList.last) { '  ← 上次用的' } else { '' }
      Write-Host ("  [{0}] {1}  ({2}){3}" -f ($i + 1), $d.label, $tag, $last)
    }
    Write-Host '──────────────────────────────────────────────────────────'
    $defIdx = 1
    for ($i = 0; $i -lt $avail.Count; $i++) { if ($avail[$i].id -eq $engineList.default) { $defIdx = $i + 1 } }
    $ans = Read-Host ("选择引擎编号 [回车 = {0}. {1}]" -f $defIdx, $avail[$defIdx - 1].label)
    if ([string]::IsNullOrWhiteSpace($ans)) {
      $engine = $engineList.default
    } else {
      $n = 0
      if ([int]::TryParse($ans.Trim(), [ref]$n) -and $n -ge 1 -and $n -le $avail.Count) {
        $engine = $avail[$n - 1].id
      } else {
        $hit = $avail | Where-Object { $_.id -eq $ans.Trim() }
        if ($hit) { $engine = $hit[0].id }
        else { Write-Host "输入无法识别（$ans）→ 沿用默认：$($engineList.default)"; $engine = $engineList.default }
      }
    }
  }
}

if (-not $engine -or $engine -eq 'unsupported') {
  Write-Host '未检测到支持的 AI 引擎（codex / claude / dsh / traecode / Trae IDE / Claude 桌面端）。'
  Write-Host '请先安装其一，或直接打开客户端对话框手动开项目。'
  exit 1
}

# 记住本次选择（下次回车即沿用）。写失败只出声，不拦启动。
if (-not $env:ENGINE) { $null = Save-EngineChoice -EngineId $engine -HarnessRootPath $HarnessRoot }
$engineLabel = $engine
$engineKind = 'cli'
foreach ($d in @($engineList.available)) { if ($d.id -eq $engine) { $engineLabel = $d.label; $engineKind = $d.kind } }
if ($engineKind -eq '' -or $null -eq $engineKind) { $engineKind = 'cli' }
Write-Host "识别引擎: $engineLabel [$engine] | 项目: $ProjectRoot"

# ---- 命令包装器（第 7 批 · U4）：把 自定义\bin\ 前置到 PATH ----
# 为什么有效：AI 无论用什么引擎、什么模型，改代码都要通过 shell 执行命令。
#   前置 PATH 后，它调用的 sed / perl / python / sleep / npx / npm / playwright
#   都会先命中 harness 的包装器：违规的拦下并给出替代做法，放行的**原样执行**（退出码透传），
#   两种情况都记一行到 **工作区根** 的 日志\02-命令\cmd-<日期>.jsonl（供 audit.mjs 事后审计）；
#   被拦下的再记一行到 日志\04-拦截\block-<日期>.jsonl。
# 边界：只对「通过本脚本启动」的会话生效；在 Trae IDE 里直接开对话不经过这里。
$HarnessBin = Join-Path $HarnessRoot '自定义\bin'
if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $HarnessBin)) {
  $env:PATH = "$HarnessBin;$env:PATH"
  $env:HARNESS_BIN = $HarnessBin
  $env:HARNESS_PROJECT = $ProjectRoot
  $env:HARNESS_ENGINE = $engine
  $env:HARNESS_SESSION_KEY = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$PID"
  # Git Bash 需要 /c/... 形式；BASH_ENV 兜底非登录 bash（`bash -c`）—— 引擎若重置了 PATH，它还能把
  # bin 前置回来。注意：login shell（`bash -l`）不读 BASH_ENV，那条路径靠 U5 的 hooks（已实测）。
  $HarnessBinPosix = if ($HarnessBin -match '^([A-Za-z]):') {
    '/' + $Matches[1].ToLower() + '/' + ($HarnessBin.Substring(2).TrimStart('\', '/') -replace '\\', '/')
  } else { $HarnessBin }
  $env:HARNESS_BIN_POSIX = $HarnessBinPosix
  # ---- BASH_ENV 收敛（第 3 段 · P2-3）----
  # 旧行为：无条件 export BASH_ENV → 连 npm / git 内部起的**非登录 bash** 都被注入，
  # 属于「为了兜底一种少见情形，去动所有第三方进程」。
  # 新行为：默认**不设** BASH_ENV（PATH 前置 + U5 hooks 已覆盖主路径）；
  # 确实需要时用 HARNESS_BASH_ENV=1 显式开启，且 _env.sh 自身幂等、失败不致命。
  if ($env:HARNESS_BASH_ENV -eq '1' -and (Test-Path -LiteralPath (Join-Path $HarnessBin '_env.sh'))) {
    $env:BASH_ENV = "$HarnessBinPosix/_env.sh"
    Write-Host '命令包装: 已按 HARNESS_BASH_ENV=1 额外设 BASH_ENV（只影响非登录 bash）'
  }
  Write-Host '命令包装: 已前置 自定义\bin（跨引擎强制层）'
}

# 引擎适配层要能找到 harness 根（自主学习 / adapters 都靠它，项目被复制走时也认得出）
$env:HARNESS_ROOT = $HarnessRoot

$goal = ($InputArgs -join ' ').Trim()
if ([string]::IsNullOrWhiteSpace($goal)) { $goal = Read-Host '请输入项目目标' }

# ---- 启动词：统一由 自定义\scripts\build-prompt.mjs 拼装（内联 40 行硬规则）----
# 这样 Codex / Claude Code / DeepSeek Harness 拿到的都是同一份硬规则。
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '未检测到 node，无法生成启动词。请先安装 Node.js。'
  exit 1
}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8
$buildPrompt = Join-Path $HarnessRoot '自定义\scripts\build-prompt.mjs'
if (-not (Test-Path -LiteralPath $buildPrompt)) {
  Write-Host "缺少启动词生成脚本：$buildPrompt"
  exit 1
}
# 必须加 --single-line：codex/claude/dsh 在 Windows 上是 npm 生成的 *.cmd 垫片，
# 垫片用 %* 转发参数，cmd.exe 会在第一个换行处截断，导致 40 条硬规则全丢。
$prompt = (& node $buildPrompt '--engine' $engine '--goal' $goal '--single-line') -join " "
if ([string]::IsNullOrWhiteSpace($prompt)) {
  Write-Host '启动词生成失败（build-prompt.mjs 没有输出）。'
  exit 1
}

# ---- 日志中心：启动词快照（01-会话）+ 本次引擎与机制层状态（06-引擎）----
# 为什么这两条一定要留：事后复盘时"这一会话到底是谁在跑、机制层有没有真的生效、
# 喂进去的启动词是什么"是最常问的三个问题，靠回忆答不准。
$stampFull = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$stampCompact = Get-Date -Format 'yyyyMMdd-HHmmss'
$dayFile = Get-Date -Format 'yyyy-MM-dd'
# 下面用的是双引号 here-string：` 和 $ 都会被 PowerShell 解释，而启动词里两样都有
# （硬规则里满是 `path` 与 $ 变量），必须先转义，否则快照会被悄悄改写。
$promptForLog = $prompt.Replace('`', '``').Replace('$', '`$')
$goalForLog = $goal.Replace('`', '``').Replace('$', '`$')

$mechanismOn = (Test-Path -LiteralPath (Join-Path $ProjectRoot '.claude\settings.json')) -and `
               (Test-Path -LiteralPath (Join-Path $ProjectRoot '.claude\hooks\guard-bash.mjs'))
$wrapperOn = [bool]$env:HARNESS_BIN
$shellKind = if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'CLAUDE.md')) { 'Claude Code 规则文件已就位' } else { '未发现项目规则文件（按引擎适配走）' }

# ════════════════════════════════════════════════════════════
# 「本次引擎 + 机制层到底生效没有」—— 按**引擎形态**分别判，不糊弄成一个笼统的绿灯
#   为什么必须分引擎：hooks 是 Claude Code 专属；Codex 的 hooks 要用户把
#   config-hooks.toml 合并进 ~/.codex/config.toml 才存在；DSH/Trae 根本没有 hooks。
#   笼统报「机制层已生效」= 让用户以为有拦截，其实没有 —— 那正是要避免的假绿。
# ════════════════════════════════════════════════════════════
$mechKind = 'none'      # hooks | wrapper-only | wrapper+prompt
$mechText = ''
$mechOk = $false
switch ($engine) {
  'claude-code' {
    $mechKind = 'hooks'
    $mechOk = $mechanismOn
    $mechText = if ($mechanismOn) {
      '✅ hooks 已生效（项目内 .claude\：6 个事件 + statusLine）'
    } else {
      '❌ hooks 未就位（项目内 .claude\settings.json 或 hooks 缺失）'
    }
  }
  'claude-code-desktop' {
    $mechKind = 'hooks'
    $mechOk = $mechanismOn
    $mechText = if ($mechanismOn) {
      '✅ 同一套 hooks 已就位 —— 但**只有在项目目录里开会话才生效**（见下方下一步）'
    } else {
      '❌ hooks 未就位（项目内 .claude\ 缺失）'
    }
  }
  'codex-cli' {
    $mechKind = 'wrapper+prompt'
    # 只做**布尔判定**：~/.codex/config.toml 里有没有 [hooks] 段与 hook-guard。
    # 绝不打印、绝不记录文件内容（该文件可能含密钥）；读不到就当「未确认」。
    $codexHooks = $false
    try {
      $cfg = Join-Path $env:USERPROFILE '.codex\config.toml'
      if (Test-Path -LiteralPath $cfg) {
        $txt = [System.IO.File]::ReadAllText($cfg, [System.Text.Encoding]::UTF8)
        $codexHooks = ($txt -match '(?m)^\s*\[hooks\]') -and ($txt -match 'hook-guard\.mjs')
        $txt = $null
      }
    } catch { $codexHooks = $false }
    $mechOk = $codexHooks
    $mechText = if ($codexHooks) {
      '✅ Codex hooks 已配置（~/.codex/config.toml 里有 [hooks] + hook-guard）；**真会话未实测**'
    } else {
      '⚠️ Codex hooks 未配置 → 本会话的强制手段是「命令包装 + 启动词」；' +
      '要开 hooks：把 自定义\引擎适配\codex\config-hooks.toml 合并进 ~/.codex/config.toml'
    }
  }
  'deepseek-harness' {
    $mechKind = 'wrapper+prompt'
    $mechOk = $false
    $mechText = '⚠️ DSH 无 hooks → 强制手段是「命令包装 + --patch 层 + 启动词」（--patch 层需按 引擎适配\dsh\ 配置）'
  }
  'traecode-cli' {
    $mechKind = 'wrapper+prompt'
    $mechOk = $false
    $mechText = '⚠️ TraeCode CLI 机制层未查明 → 强制手段是「命令包装 + 启动词」'
  }
  'trae-ide' {
    $mechKind = 'prompt'
    $mechOk = $false
    $mechText = '⚠️ 图形端无法注入 hooks → 只靠「.trae\rules\ 规则文件 + 启动词」（模型自觉）'
  }
  default {
    $mechKind = 'none'
    $mechText = '⚠️ 未知引擎 → 机制层状态未知'
  }
}

Write-HarnessLog '01-会话' "session-$dayFile.md" @"

## 启动快照 $stampFull

- 引擎：$engine
- 引擎（人读）：$engineLabel（$engineKind）
- 项目根：$ProjectRoot
- 工作区根：$WorkRoot
- 日志根：$LogRoot
- 机制层（按引擎形态判定，$mechKind）：$mechText
- 命令包装（自定义\bin 前置 PATH）：$(if ($wrapperOn) { '已生效' } else { '未生效' })
- 目标：$goalForLog

启动词（单行，已内联硬规则与上次审计摘要）：

``````text
$promptForLog
``````
"@

Write-HarnessLog '06-引擎' "session-$stampCompact.md" @"
# 本次会话 · 引擎与机制层（$stampFull）

- 引擎：**$engine**（$engineLabel）
- 引擎形态：$engineKind（cli = 可直接启动；desktop = 只能给启动词）
- 机制层：**$mechText**
- 机制层档位：$mechKind（hooks = 引擎事件强制；wrapper+prompt = 命令包装 + 启动词；prompt = 只靠启动词，模型自觉）
- 机制层判据（Claude 系）：项目内 .claude\settings.json 与 hooks\guard-bash.mjs 都在 = $(if ($mechanismOn) { '是' } else { '否' })
- 机制层判据（Codex）：~/.codex/config.toml 里 [hooks] + hook-guard.mjs 都在 = $(if ($mechOk) { '是' } else { '否' })（只做布尔判定，不读、不打印文件内容）
- 命令包装是否生效：$(if ($wrapperOn) { '生效' } else { '未生效' })
- 机制层判据补充：$shellKind
- 项目根：$ProjectRoot
- 日志根：$LogRoot
- 引擎选择来源：$(if ($env:ENGINE) { '环境变量 ENGINE' } else { '本次选择（已落盘，下次回车沿用）' })
- 说明：Codex / DSH / Trae 不用 .claude\ 机制层，它们的强制手段是命令包装 + 启动词（见 自定义\引擎适配\ 与 引擎能力矩阵）。
"@

# ── 「harness 真的起来了」横幅（第 3 段 · 锁定决策 10）──
# 用户看一眼就知道：这次跑的是哪个引擎、机制层有没有真的生效、日志在哪、项目在哪。
# 对齐说明：中文是**双宽**字符，用 "{0,-58}" 补空格会对不齐（PowerShell 按字符数算）。
# 这里自己算显示宽度，保证框是正的 —— 排版歪掉会让人以为脚本出错了。
function Get-DisplayWidth([string]$text) {
  $w = 0
  foreach ($ch in $text.ToCharArray()) {
    $c = [int]$ch
    $wide = ($c -ge 0x1100 -and $c -le 0x115F) -or
            ($c -ge 0x2E80 -and $c -le 0xA4CF) -or
            ($c -ge 0xAC00 -and $c -le 0xD7A3) -or
            ($c -ge 0xF900 -and $c -le 0xFAFF) -or
            ($c -ge 0xFE30 -and $c -le 0xFE6F) -or
            ($c -ge 0xFF00 -and $c -le 0xFF60) -or
            ($c -ge 0xFFE0 -and $c -le 0xFFE6)
    $w += if ($wide) { 2 } else { 1 }
  }
  return $w
}
$boxInner = 58
$line = '─' * ($boxInner + 2)
function Write-BoxLine([string]$text) {
  $pad = $boxInner - (Get-DisplayWidth $text)
  if ($pad -lt 0) { $pad = 0 }
  Write-Host ("│ " + $text + (' ' * $pad) + " │")
}
Write-Host ''
Write-Host "┌$line┐"
Write-BoxLine 'harness 已启动'
Write-BoxLine "本次引擎   $engineLabel [$engine]"
Write-BoxLine "机制层     $(if ($mechOk) { '生效' } else { '未生效/未配置' })（档位 $mechKind）"
Write-BoxLine "命令包装   $(if ($wrapperOn) { '已前置 自定义\bin' } else { '未生效' })"
Write-BoxLine '日志中心   日志\（06-引擎 已记本次会话）'
# 项目路径可能很长（中文路径更宽）——框里只放「…\末两段」，完整路径打在框下面，保证框是正的
$projShort = $ProjectRoot
if ((Get-DisplayWidth "项目       $projShort") -gt $boxInner) {
  $leaf = Split-Path -Leaf $ProjectRoot
  $parent = Split-Path -Leaf (Split-Path -Parent $ProjectRoot)
  $projShort = "…\$parent\$leaf"
}
Write-BoxLine "项目       $projShort"
Write-Host "└$line┘"
Write-Host "机制层详情: $mechText"
Write-Host "项目完整路径: $ProjectRoot"
Write-Host ''

# ── 图形端（没有能 exec 一条 prompt 的 CLI）：把启动词落盘 + 给下一步 ──
function Write-StartupPromptFile {
  param([string]$Text, [string]$Why)
  $hDir = Join-Path $ProjectRoot '.harness'
  $null = New-Item -ItemType Directory -Force -Path $hDir
  $file = Join-Path $hDir 'exec-prompt.md'
  Set-Content -LiteralPath $file -Value $Text -Encoding UTF8
  Write-Host ''
  Write-Host '下一步（三件事，顺序别换）:' -ForegroundColor Yellow
  Write-Host "  1. 打开图形端，**选择/打开这个项目目录**：$ProjectRoot"
  Write-Host '     （Claude Code 用会话 cwd 当项目根、不向上寻找 —— 在别处开会话，hooks 完全不生效）'
  Write-Host "  2. 新开一个会话，把启动词整段粘进去。启动词也在这份文件里：$file"
  Write-Host '  3. 干完活回来跑清理/验收（本窗口的后续命令都能用）。'
  Write-Host "  （$Why）"
}

switch ($engine) {
  'codex-cli' {
    $codexBin = (Get-EngineList -HarnessRootPath $HarnessRoot).available |
      Where-Object { $_.id -eq 'codex-cli' } | Select-Object -First 1
    if ($codexBin -and $codexBin.path) { & $codexBin.path exec $prompt '--sandbox' 'workspace-write' '--skip-git-repo-check' }
    else { & codex exec $prompt '--sandbox' 'workspace-write' '--skip-git-repo-check' }
  }
  'claude-code' {
    $claudeBin = (Get-EngineList -HarnessRootPath $HarnessRoot).available |
      Where-Object { $_.id -eq 'claude-code' } | Select-Object -First 1
    if ($claudeBin -and $claudeBin.path) { & $claudeBin.path '-p' $prompt '--output-format' 'text' '--dangerously-skip-permissions' }
    else { & claude '-p' $prompt '--output-format' 'text' '--dangerously-skip-permissions' }
  }
  'deepseek-harness' {
    $dshBin = (Get-EngineList -HarnessRootPath $HarnessRoot).available |
      Where-Object { $_.id -eq 'deepseek-harness' } | Select-Object -First 1
    if ($dshBin -and $dshBin.path) {
      & $dshBin.path '--profile' 'headless' $prompt
    } else {
      Write-StartupPromptFile -Text $prompt -Why 'DeepSeek Harness 不自动读规则文件，靠启动词注入'
    }
  }
  'traecode-cli' {
    $tcBin = (Get-EngineList -HarnessRootPath $HarnessRoot).available |
      Where-Object { $_.id -eq 'traecode-cli' } | Select-Object -First 1
    if ($tcBin -and $tcBin.path) { & $tcBin.path $prompt }
    else { Write-StartupPromptFile -Text $prompt -Why 'TraeCode CLI 未探到可执行文件' }
  }
  'claude-code-desktop' {
    Write-StartupPromptFile -Text $prompt -Why 'Claude Code 桌面端没有可注入命令行的接口；同一套 hooks 只在项目目录里的会话生效'
  }
  'trae-ide' {
    Write-StartupPromptFile -Text $prompt -Why 'Trae IDE 是图形端；规则靠 .trae\rules\ + 启动词'
  }
  default { Write-Host "引擎 $engine 暂不支持终端自动执行，请用客户端对话框。"; exit 1 }
}
