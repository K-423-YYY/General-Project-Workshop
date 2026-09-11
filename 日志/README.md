# 日志中心

> 位置：**工作区根**（`…\General-Project-Workshop\日志\`）。**不在项目文件夹里**；
> **日志内容不进 git**，但本说明文件与 8 个分类目录随仓库走（克隆下来即可用，第一次写日志时自动补齐）。
> 目的：项目交付时必须"干净、可整体复制走"，所以运行日志一律留在 harness 自己这边。
> 规则：**只追加不改写**、按日期分文件、单文件超 8 MB 轮转、写失败绝不影响主流程（fail-open 但终端出声）。
> 第一次写入时会自动把 8 个分类目录建全（幂等）——所以新克隆不需要手工建目录。

## 一、每个子目录记什么

| 目录 | 记什么 | 谁写 | 文件名 |
|---|---|---|---|
| `01-会话\` | 启动词快照、上下文水位、会话结束摘要、SessionStart 注入副本、Stop 事件原始载荷 | `run.ps1` / `run.sh`（启动）、`inject-rules.mjs`、`statusline.mjs`、`on-stop.mjs` | `session-<日期>.md`、`context-<日期>.jsonl`、`injection-<日期>.md`、`stop-stdin-<日期>.jsonl` |
| `02-命令\` | 逐条命令：工具、命令、放行/拦截、退出码、耗时、真实命令、走的哪种垫片；以及 G10 改写命令的**完整原始输出** | `自定义\bin\_log.mjs`、`guard-bash.mjs`（长输出）、`shape-output.mjs` | `cmd-<日期>.jsonl`、`output-<时间戳>-<指纹>.log`、`shape-debug-<日期>.jsonl`（仅 `HARNESS_DEBUG=1`） |
| `03-验证\` | 独立验收的**原始输出**（每次运行一个文件，只落盘、不可改写，模型只能引用不许改写） | `verify-gate.mjs` | `verify-<时间戳>.log` |
| `04-拦截\` | G1–G8（含包装器自己的规则）每次 deny / warn：规则、命令、替代建议 | `guard-bash.mjs`、`guard-tools.mjs`、`_log.mjs` | `block-<日期>.jsonl` |
| `05-清理\` | 每次清理的"将删除 / 将保留"清单 + 清理后的纯净度自检结果 | `内置\scripts\cleanup.ps1` | `cleanup-<时间戳>.md` |
| `06-引擎\` | 引擎探测结果、**本次实际用的引擎**、机制层是否生效；开工体检报告 | `run.ps1` / `run.sh`、`probe-engines.mjs`、`env-doctor.mjs` | `session-<时间戳>.md`、`engine-probe-<日期>.jsonl`、`env-doctor-<日期>.log` |
| `07-审计\` | 会话后审计报告（`audit.mjs` 的完整 Markdown 报告，按时间戳一份，不覆盖） | `audit.mjs` | `audit-<时间戳>.md` |
| `08-模型\` | 自主学习轨迹：每次上调/下调的 before → after 与依据 | `probe-model.mjs --record` | `model-<日期>.jsonl` |

## 二、规则细节（为什么不这样做就会出问题）

1. **只追加，不改写**：所有写入都走 `.claude\hooks\lib\log-center.mjs` 的 `appendLog()`，内部只用 `appendFileSync`。
   需要"latest"这类会覆盖的文件，一律留在项目 `.harness\`（运行态、随清理删除），日志中心不做覆盖写。
2. **按日期分文件**：文件名带 `YYYY-MM-DD` 或 `YYYYMMDD-HHMMSS`，与"哪次会话"一一对应，不用翻大文件。
3. **8 MB 轮转**：单文件到 8 MB 时改名成 `<名字>.<时间戳>.<扩展名>`，历史一个字节不丢。
4. **fail-open**：日志目录只读、磁盘满、路径非法 —— 一律只往 **stderr** 打一行 `[harness] ⚠️ 日志中心：…`，
   **不改退出码、不中断命令、不影响 hooks 的判定**。验证这条：把 `HARNESS_LOG_ROOT` 指向一个不可写路径，再跑一条命令，
   命令照样执行、退出码不变、终端有提示。
5. **日志根怎么定**：① 环境变量 `HARNESS_LOG_ROOT`（启动器 `run.ps1` / `run.sh` 会设）；
   ② 不设时，从当前目录向上找含 `AI-Dev-Harness\` 的目录，取它同级的 `日志\`。
   所以：**通过启动器开会话**、**在项目目录里直接开会话**都会写到这里；
   项目被复制到工作区之外后不再写日志（有意为之：交付项目不该依赖 harness）。

## 三、怎么检索（可直接复制）

```powershell
$L = "C:\Users\29137\Desktop\项目2\AI自动化工具配置\自建\脚本\General-Project-Workshop\日志"

# 1) 今天跑了哪些命令（只看命令与退出码）
Get-Content "$L\02-命令\cmd-$(Get-Date -f yyyy-MM-dd).jsonl" | ConvertFrom-Json |
  Select-Object time, tool, exit, decision, cmd | Format-Table -AutoSize

# 2) 被拦下的命令（规则、原因、命令原文）
Get-Content "$L\04-拦截\block-$(Get-Date -f yyyy-MM-dd).jsonl" | ConvertFrom-Json |
  Select-Object time, rule, decision, what, why, cmd | Format-Table -AutoSize -Wrap

# 3) 上下文水位轨迹（什么时候开始逼近 70%）
Get-Content "$L\01-会话\context-$(Get-Date -f yyyy-MM-dd).jsonl" | ConvertFrom-Json |
  Select-Object ts, usedPct, windowSize, model | Format-Table -AutoSize

# 4) 本次会话的引擎与机制层是否生效
Get-ChildItem "$L\06-引擎" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
  Get-Content

# 5) 全库关键词检索（跨所有分类、所有日期）
rg -n "<关键词>" "$L"

# 6) 独立验收的原始输出（找最近一份）
Get-ChildItem "$L\03-验证" | Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
```

## 四、和"项目内 .harness\logs\" 的关系

**项目内不再有 `.harness\logs\`**（第 2 段取消）：命令日志、验收原始输出、长输出落盘全部搬到了这里。
项目里只保留运行态必需的那几个文件（`HANDOFF.md`、`JOURNAL.md`、`verify.json`、`bypass`、`audit-latest.*`），
它们随 `cleanup.ps1` 归档到 `AI-Dev-Harness\state\<项目名>\harness\` 后删除 —— 交付出去的项目里不留任何 harness 痕迹。
