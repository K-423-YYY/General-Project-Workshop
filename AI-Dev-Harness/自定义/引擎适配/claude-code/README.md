# Claude Code 适配（终端 + 桌面端）

> 两种形态、**同一套 hooks**，但生效条件不同。写清楚是为了避免最常见的假象：
> 「我在桌面端开了会话，以为有拦截，其实机制层根本没加载。」

---

## 一、机制层是什么

| 层 | 位置 | 谁落地 |
|---|---|---|
| 配置 | `<项目>\.claude\settings.json` | `自定义\scripts\scaffold-ext.mjs`（`run.bat` 启动时自动跑） |
| 脚本 | `<项目>\.claude\hooks\*.mjs` + `lib\` | 同上（**从工作区根主副本整体同步**，逐字节一致） |
| 规则 | `<项目>\CLAUDE.md` | `内置\scripts\scaffold.ps1` / `gen-rules.mjs` |

6 个 hook 事件：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PreCompact` / `Stop` / `SessionStart`，
外加 `statusLine`（上下文水位 + 自主学习的数据源）。

---

## 二、关键差异：会话开在哪个目录

**Claude Code 用「会话 cwd」当项目根，不向上寻找 `.claude\settings.json`**（第 2 批实测）。

| 会话开在哪 | hooks | 命令包装 | 启动词 |
|---|---|---|---|
| `<项目目录>` 里（推荐，`run.bat` 就是这么做的） | ✅ 全套生效 | ✅ | ✅ |
| 别处（主目录 / harness 根 / 桌面端默认目录） | ❌ 完全不生效 | 取决于是否经 `run.bat` 启动 | ✅（若粘贴了启动词） |

### 终端（`claude` CLI）

`run.bat` 选 `claude-code` 时会 `cd` 到项目目录再启动，cwd 天然正确，不需要额外动作。

### 桌面端

桌面端没有「用一条命令注入 prompt」的接口，所以 `run.bat` 走引导式三步：

1. 打开桌面端，**选择/打开这个项目目录**（这一步就是让会话 cwd = 项目目录）；
2. 新开会话，把启动词整段粘进去（启动词同时落在 `<项目>\.harness\exec-prompt.md`）；
3. 干完活回到终端跑清理 / 验收。

`run.bat` 的启动横幅会打印：`同一套 hooks 已就位 —— 但只有在项目目录里开会话才生效`。

---

## 三、本机实测状态（2026-09-12）

| 项 | 结论 |
|---|---|
| 终端 CLI 是否在机 | ✅ 在机：`%APPDATA%\npm\claude.cmd`，版本 **2.1.263**（本轮实测） |
| 桌面端是否在机 | ✅ 在机（判据：`%APPDATA%\Claude`；**`~/.claude.json` 不算判据** —— 终端 CLI 也会生成它） |
| 桌面端真会话验证 | ⚠️ **未做**。本次只确认「桌面端装着」+「同一套 `.claude\` 配置」；生效条件来自第 2 批对项目根语义的实测 |

> ⚠️ **一个必须记住的坑（本轮实测踩到）**：在**受限沙箱**里跑探测脚本时，
> `%APPDATA%\npm` 可能读不到（`dir` 报 File Not Found），于是 claude/dsh 被探成「本机没有」——
> 那是**环境的假象，不是机器的事实**。跑引擎探测 / 自检台请在**非沙箱**环境。

> 判据与探测方式统一由 `自定义\scripts\lib\engine-detect.mjs` 给出（P2-5）。
> 复现：`node AI-Dev-Harness\自定义\scripts\lib\engine-detect.mjs --id claude-code-desktop`

---

## 四、怎么自查机制层到底生效没有

```powershell
$H = (Get-Location).Path          # 在 本工作区根目录 下执行本段；路径不写死，换电脑也能用
$P="$H\我的项目\<你的项目>"     # 换成实际项目目录

# 1) 项目内机制层是否就位（settings.json + hooks 都在）
Test-Path "$P\.claude\settings.json"; Test-Path "$P\.claude\hooks\guard-bash.mjs"

# 2) 项目内 hooks 是否与主副本逐字节一致（不一致 = 可能失效）
node "$H\AI-Dev-Harness\自定义\scripts\scaffold-ext.mjs" --project $P --check

# 3) 本次会话的引擎与机制层状态（run.bat 启动的会话都留了一行）
Get-Content "$H\日志\06-引擎\session-*.md" | Select-Object -Last 20
```
