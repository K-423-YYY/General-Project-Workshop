# ============================================================
# cleanup.ps1 - 纯净化清理：归档 .harness\，删除项目内脚手架
# 无后台进程。**两段式**（锁定决策 8 + 前提 5.1）：
#
#   第一段 · 只出清单（默认，什么都不删）：
#     .\内置\scripts\cleanup.ps1 -ProjectRoot "..\我的项目"
#     → 打印「将删除 / 将保留」，清单落盘到 日志\05-清理\，退出码 3 = 等你确认
#
#   第二段 · 用户确认后执行：
#     .\内置\scripts\cleanup.ps1 -ProjectRoot "..\我的项目" -Confirm [-Commit]
#     → 归档 .harness\ → 删除脚手架 → 纯净度自检 → 报告落盘到 日志\05-清理\
#
# 为什么默认不删：清理是这个 harness 唯一会删东西的环节。以前"先清单后确认"只写在
# 协议里靠模型自觉，一旦模型直接跑脚本，用户就没机会拦。现在起**没带 -Confirm 就一个文件都不动**。
# ============================================================
[CmdletBinding()]
param(
  [string]$ProjectRoot = '',
  [switch]$Confirm,
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

# ============================================================
# 日志中心（第 2 段 · 05-清理）：把「将删除 / 将保留」清单与清理后的纯净度自检结果落盘。
# 为什么必须落盘：清理是这个 harness 唯一会**删东西**的环节，事后必须能回答
# 「当时删了什么、留了什么、凭什么说它干净了」——靠记忆答不准，也审不了。
# 铁律同其它组件：只追加、写失败只出声、绝不影响清理本身的退出码。
# ============================================================
$env:HARNESS_LOG_ROOT = Join-Path (Split-Path -Parent $HarnessRoot) '日志'
$LogCli = Join-Path $HarnessRoot '自定义\scripts\lib\log-center.mjs'

function Write-HarnessLog {
  param([string]$Category, [string]$File, [string]$Text)
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '日志: 未安装 node，跳过写日志'; return }
  if (-not (Test-Path -LiteralPath $LogCli)) { Write-Host "日志: 缺少 $LogCli，跳过写日志"; return }
  $tmp = Join-Path $env:TEMP ("harness-cleanup-log-{0}.txt" -f ([guid]::NewGuid().ToString('N')))
  try {
    Set-Content -LiteralPath $tmp -Value $Text -Encoding UTF8
    & node $LogCli 'append' '--category' $Category '--file' $File '--from' $tmp | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "日志: 写入 $Category\$File 退出码 $LASTEXITCODE（不影响清理）" }
  } catch {
    Write-Host "日志: 写入失败（不影响清理）：$($_.Exception.Message)"
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

# ---- 清理前的盘点：将删除 / 将保留 ----
$scaffoldRels = @('AGENTS.md', 'CLAUDE.md', '.harness', '.trae', '.claude')
$planDelete = @()
foreach ($rel in $scaffoldRels) {
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot $rel)) { $planDelete += $rel }
}
$planKeep = @()
if (Test-Path -LiteralPath $ProjectRoot) {
  $planKeep = @(Get-ChildItem -LiteralPath $ProjectRoot -Force -ErrorAction SilentlyContinue |
    Where-Object { $scaffoldRels -notcontains $_.Name } | ForEach-Object { $_.Name })
}
if ($planDelete.Count -gt 0) {
  Write-Host ('将删除：' + ($planDelete -join '、'))
} else {
  Write-Host '将删除：（无 —— 项目里已经没有 harness 脚手架，本次大概是重复运行）'
}
Write-Host ('将保留：' + ($planKeep -join '、'))

# ============================================================
# 确认闸门：没拿到 -Confirm 就只出清单，绝不进入下面的归档/删除段。
# 退出码 3 = 「清单已给，等你确认」——调用方（AI）据此判断该去问用户。
# ============================================================
if (-not $Confirm) {
  $plan = @()
  $plan += '# 纯净化清理 · 将删除 / 将保留清单（等你确认）'
  $plan += ''
  $plan += "- 时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  $plan += "- 项目：$ProjectRoot"
  $plan += ''
  $plan += '## 将删除'
  $plan += $(if ($planDelete.Count) { ($planDelete | ForEach-Object { "- $_" }) } else { '- （无 —— 项目里已经没有 harness 脚手架）' })
  $plan += ''
  $plan += '## 将保留'
  $plan += $(if ($planKeep.Count) { ($planKeep | ForEach-Object { "- $_" }) } else { '- （空目录）' })
  $plan += ''
  $plan += '## 归档位置（.harness\ 的内容不删除，归档到这里）'
  $plan += "- $(Join-Path $HarnessRoot ("state\" + $ProjectName + "\harness"))"
  $plan += ''
  $plan += '## 确认后执行'
  $plan += '```powershell'
  $plan += ".\内置\scripts\cleanup.ps1 -ProjectRoot `"$ProjectRoot`" -Confirm"
  $plan += '```'
  Write-HarnessLog '05-清理' ("cleanup-plan-{0}.md" -f (Get-Date -Format 'yyyyMMdd-HHmmss')) (($plan -join "`r`n") + "`r`n")
  Write-Host ''
  Write-Host '已生成清单（日志\05-清理\），**本次什么都没删**。' -ForegroundColor Yellow
  Write-Host '请先向用户出示上面的「将删除 / 将保留」，得到明确同意后再加 -Confirm 重跑。' -ForegroundColor Yellow
  exit 3
}

# ============================================================
# 失败记账：**任何一步失败都要明确报错，并让本脚本以非零退出**。
# 以前失败只打一行 WARN 就继续，甚至归档那行直接抛错中止 ——
# 结果是「清理看起来跑完了，项目里却还留着 harness 脚手架」，交付前的纯净化形同虚设。
# ============================================================
$failedSteps = @()
function Report-Fail {
  param([string]$Step, [string]$Why)
  $script:failedSteps += "$Step —— $Why"
  Write-Host "ERROR $Step 失败：$Why" -ForegroundColor Red
}

# 归档 .harness\ 到 state\<项目名>\harness\
$hDir = Join-Path $ProjectRoot '.harness'
$hDirExisted = Test-Path -LiteralPath $hDir
$archiveOk = $true
if (Test-Path -LiteralPath $hDir) {
  $archive = Join-Path $HarnessRoot ("state\" + $ProjectName + "\harness")
  try {
    $null = New-Item -ItemType Directory -Force -Path $archive
    # 注意这里为什么不能照旧写：
    #   · `Copy-Item -LiteralPath (Join-Path $hDir '*')` —— -LiteralPath **不展开通配符**，
    #     它找的是名字真的叫 `*` 的文件，实测必然报
    #     "Cannot find path '…\.harness\*' because it does not exist."；
    #     而脚本开头是 $ErrorActionPreference='Stop' → 只要项目里有 .harness\（正常开发必然有），
    #     清理会在这一行直接中止：不归档、不删脚手架、不写状态。
    #   · 只改成 `-Path (Join-Path $hDir '*')` 也不够 —— Windows PowerShell 5.1 的通配符
    #     **不返回隐藏项**，而 .harness 里的东西经常带隐藏属性 → 会「看着成功、其实没归档全」。
    # 所以：显式枚举 + -Force（连隐藏项一起带上），再逐项按字面路径复制。
    $items = @(Get-ChildItem -LiteralPath $hDir -Force)
    foreach ($item in $items) {
      Copy-Item -LiteralPath $item.FullName -Destination $archive -Recurse -Force
    }
    # 校验归档数量，防「静默少归档」
    $copied = @(Get-ChildItem -LiteralPath $archive -Force).Count
    if ($copied -lt $items.Count) {
      Report-Fail '归档 .harness' "源目录 $($items.Count) 项，归档目录里只有 $copied 项"
      $archiveOk = $false
    } else {
      Write-Host "OK 归档到 state\$ProjectName\harness（$($items.Count) 项，含隐藏项）"
    }
  } catch {
    Report-Fail '归档 .harness' $_.Exception.Message
    $archiveOk = $false
  }
}

# 删除项目内脚手架
foreach ($rel in @('AGENTS.md','CLAUDE.md','.harness')) {
  $fp = Join-Path $ProjectRoot $rel
  if (-not (Test-Path -LiteralPath $fp)) { continue }
  # 归档没成功就不删 .harness\：里面的运行态数据删了就找不回来了。
  # （宁可留下残留并报错，也不能"清干净了但数据没了"。）
  if ($rel -eq '.harness' -and $hDirExisted -and -not $archiveOk) {
    Report-Fail '删除 .harness' '归档没成功，为免丢数据先保留 .harness\；修好归档原因后重跑本脚本'
    continue
  }
  try {
    Remove-Item -LiteralPath $fp -Recurse -Force
    if (Test-Path -LiteralPath $fp) { Report-Fail "删除 $rel" '删完仍然存在' }
    else { Write-Host "DEL $rel" }
  } catch {
    Report-Fail "删除 $rel" $_.Exception.Message
  }
}
$traeDir = Join-Path $ProjectRoot '.trae'
if (Test-Path -LiteralPath $traeDir) {
  try {
    Remove-Item -LiteralPath $traeDir -Recurse -Force
    if (Test-Path -LiteralPath $traeDir) { Report-Fail '删除 .trae' '删完仍然存在' }
    else { Write-Host 'DEL .trae' }
  } catch {
    Report-Fail '删除 .trae' $_.Exception.Message
  }
}

# 项目内机制层（第 5 批 · A13）：.claude\ 是 scaffold-ext.mjs 生成的，也要一并撤掉，
# 否则「纯净化」后的交付项目里还留着一整套 hooks 与 settings.json。
# 幂等、fail-open：脚本不存在或 node 缺失时静默跳过，绝不影响清理。
$scaffoldExt = Join-Path $HarnessRoot '自定义\scripts\scaffold-ext.mjs'
$claudeDir = Join-Path $ProjectRoot '.claude'
if (Test-Path -LiteralPath $claudeDir) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Report-Fail '撤销 .claude 机制层' '找不到 node，没法调用 scaffold-ext.mjs（装好 node 后重跑本脚本）'
  } elseif (-not (Test-Path -LiteralPath $scaffoldExt)) {
    Report-Fail '撤销 .claude 机制层' "找不到 $scaffoldExt"
  } else {
    try {
      # 注意：不要写 `2>&1 | Out-Null` —— $ErrorActionPreference='Stop' 下 PS 5.1 会把
      # 原生命令的 stderr 当异常抛出。
      & node $scaffoldExt '--project' $ProjectRoot '--remove' '--quiet' | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Report-Fail '撤销 .claude 机制层' "scaffold-ext.mjs --remove 退出码 $LASTEXITCODE"
      } elseif (Test-Path -LiteralPath $claudeDir) {
        Report-Fail '撤销 .claude 机制层' 'scaffold-ext.mjs 报成功，但 .claude\ 还在'
      } else {
        Write-Host 'DEL .claude (机制层)'
      }
    } catch {
      Report-Fail '撤销 .claude 机制层' $_.Exception.Message
    }
  }
}

# 更新状态标记
$state = Join-Path $HarnessRoot ("state\" + $ProjectName + "\status.json")
try {
  $status = @{
    project    = $ProjectName
    status     = $(if ($failedSteps.Count -gt 0) { 'completed-with-errors' } else { 'completed' })
    cleanedAt  = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    failedSteps = @($failedSteps)
  }
  $status | ConvertTo-Json | Set-Content -LiteralPath $state -Encoding UTF8
  Write-Host "OK 状态已标记: $state"
} catch {
  Report-Fail '写状态标记' $_.Exception.Message
}

# 可选：git 提交纯净版
if ($Commit -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Push-Location $ProjectRoot
  try {
    & git add -A 2>$null | Out-Null
    & git commit -m "清理脚手架，交付纯净版" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Report-Fail 'git 提交纯净版' "git commit 退出码 $LASTEXITCODE（没有改动可提交时也会这样）"
    } else {
      Write-Host 'OK 已提交纯净版'
    }
  } finally { Pop-Location }
}

# ============================================================
# 纯净度自检（清理后）：判据与实现都在 自定义\scripts\purity-check.mjs（唯一实现），
# 这里只负责调用 + 落盘。为什么单独成一个脚本：交付前的"干净"必须可复算 ——
# AI 自己顺手扫一遍、cleanup 再扫一遍，两套实现迟早说法不一致。
# 兜底：node 或脚本缺失时退化为内置简易扫描，并如实写明退化（fail-open 但出声）。
# ============================================================
$purityCheck = Join-Path $HarnessRoot '自定义\scripts\purity-check.mjs'
$purityOk = $false
$leftoverMarkers = @()
$refFiles = @()
$purityNote = ''
$purityUsedScript = $false
if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $purityCheck)) {
  try {
    $raw = & node $purityCheck '--project' $ProjectRoot '--json'
    $purityCode = $LASTEXITCODE
    $data = ($raw -join "`n") | ConvertFrom-Json
    $purityOk = [bool]$data.clean
    $leftoverMarkers = @($data.leftovers | ForEach-Object { [string]$_.path })
    $refFiles = @($data.refs | ForEach-Object { "$($_.path):$($_.line) [$($_.key)]" })
    $purityUsedScript = $true
    $purityNote = "purity-check.mjs（退出码 $purityCode：0=干净 1=有残留）"
  } catch {
    $purityNote = "purity-check.mjs 调用失败：$($_.Exception.Message) —— 退化为内置简易扫描"
  }
} else {
  $purityNote = 'node 或 purity-check.mjs 缺失 —— 退化为内置简易扫描'
}
if (-not $purityUsedScript) {
  try {
    $leftoverMarkers = @(Get-ChildItem -LiteralPath $ProjectRoot -Force -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $scaffoldRels -contains $_.Name } | ForEach-Object { $_.FullName })
  } catch { /* 扫描失败由下面的结论如实体现（残留清单为空但结论来自 $purityOk） */ }
  $purityOk = ($leftoverMarkers.Count -eq 0)
}
Write-Host ''
Write-Host "纯净度自检：$(if ($purityOk) { '通过 —— 没有 .claude / .harness / .trae / AGENTS.md / CLAUDE.md，也没有 harness 路径引用' } else { "未通过 —— 残留 $($leftoverMarkers.Count) 处、harness 路径引用 $($refFiles.Count) 处" })"
if ($leftoverMarkers.Count -gt 0) { $leftoverMarkers | ForEach-Object { Write-Host "  残留：$_" } }
Write-Host "纯净度自检：引用 AI-Dev-Harness 路径的文件 $($refFiles.Count) 个（人工确认这些引用是否该保留）"
Write-Host "纯净度自检：实现来源 —— $purityNote"

$report = @()
$report += '# 纯净化清理报告（清理后 · 日志中心 05-清理）'
$report += ''
$report += "- 时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$report += "- 项目：$ProjectRoot"
$report += "- 归档位置：$(Join-Path $HarnessRoot ("state\" + $ProjectName + "\harness"))"
$report += '- 确认方式：用户确认后带 -Confirm 执行（清理前已先出「将删除 / 将保留」清单）'
$report += ''
$report += '## 将删除（清理前盘点）'
$report += $(if ($planDelete.Count) { ($planDelete | ForEach-Object { "- $_" }) } else { '- （无）' })
$report += ''
$report += '## 将保留（清理前盘点）'
$report += $(if ($planKeep.Count) { ($planKeep | ForEach-Object { "- $_" }) } else { '- （空目录）' })
$report += ''
$report += '## 清理结果'
if ($failedSteps.Count -eq 0) {
  $report += '- 所有步骤成功（归档 → 删除脚手架 → 撤销 .claude 机制层 → 写状态标记）'
} else {
  $report += "- 有 $($failedSteps.Count) 项失败："
  $report += ($failedSteps | ForEach-Object { "  - $_" })
}
$report += ''
$report += '## 纯净度自检（清理后）'
$report += "- 结论：$(if ($purityOk) { '通过' } else { "未通过（$($leftoverMarkers.Count) 处残留）" })"
$report += '- 判据一：项目目录内不得再出现 .claude / .harness / .trae / AGENTS.md / CLAUDE.md'
$report += '- 判据二：项目内文本文件不得再引用 harness（AI-Dev-Harness / .harness\ / HARNESS_ROOT / harness:rules 等）'
$report += "- 实现来源：$purityNote"
if ($leftoverMarkers.Count -gt 0) {
  $report += '- 残留清单：'
  $report += ($leftoverMarkers | ForEach-Object { "  - $_" })
}
$report += "- 引用 harness 路径的位置：$($refFiles.Count) 处"
if ($refFiles.Count -gt 0) {
  $report += ($refFiles | Select-Object -First 40 | ForEach-Object { "  - $_" })
}
$report += ''
$report += '> 说明：命令日志、验收原始输出、长输出都在工作区根的 日志\ 下，不随项目交付；'
$report += '> 项目里剩下的运行态已全部删除/归档，复制走项目文件夹不会带任何 harness 痕迹。'
Write-HarnessLog '05-清理' ("cleanup-{0}.md" -f (Get-Date -Format 'yyyyMMdd-HHmmss')) (($report -join "`r`n") + "`r`n")

if ($failedSteps.Count -gt 0) {
  Write-Host ''
  Write-Host "纯净化清理未完成：$($failedSteps.Count) 项失败 ——" -ForegroundColor Red
  foreach ($s in $failedSteps) { Write-Host "  - $s" -ForegroundColor Red }
  Write-Host '项目文件夹现在可能仍有 harness 残留，**不要当作已交付**；修掉上面的原因后重跑本脚本（脚本是幂等的）。' -ForegroundColor Red
  # 用终止错误退出：`-File` 方式运行时进程退出码是非零；被别的脚本 `&` 调用时也会把错误抛给调用方，
  # 不会出现「清理失败但上层以为成功」。
  throw "cleanup.ps1：纯净化清理未完成（$($failedSteps.Count) 项失败，详见上方 ERROR 行）"
}

Write-Host '纯净化清理完成。'
