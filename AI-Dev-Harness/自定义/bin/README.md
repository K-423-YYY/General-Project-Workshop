# `自定义\bin\` —— 命令包装器（U4 · 唯一真正跨引擎的强制层）

> **一句话**：AI 无论用什么引擎、什么模型，改代码都得通过 shell 执行命令。
> 所以把 `bin\` 前置到 PATH，就等于**在所有引擎上都装了一层强制**。

---

## 一、它怎么生效

`内置\engine\run.ps1` / `run.sh` 在启动引擎前做两件事（第 7 批 · U4）：

```powershell
$env:PATH = "<harness>\AI-Dev-Harness\自定义\bin;$env:PATH"
$env:HARNESS_PROJECT = $ProjectRoot      # 日志与配额写到这个目录
$env:HARNESS_SESSION_KEY = "<启动时间>-<进程号>"   # 配额按会话分桶
$env:HARNESS_ENGINE = $engine
```

引擎启动后，它调用的任何 shell 命令都会先命中本目录的同名垫片。

| 入口 | 是否生效 |
|---|---|
| `run.bat` / `run.ps1` / `run.sh` 启动的会话 | ✅ 生效 |
| 自己在终端里前置 PATH 后启动的会话 | ✅ 生效 |
| **Trae IDE / 桌面客户端里直接开对话** | ❌ **不生效**（不走 harness 启动器） |
| 用绝对路径直接调 `C:\...\sed.exe -i` | ❌ 不生效（绕过 PATH） |

---

## 二、文件构成

| 文件 | 作用 |
|---|---|
| `_log.mjs` | **唯一实现**：判定 + 记录 + 原样执行真实命令 |
| `..\scripts\lib\resolve-command.mjs` | **统一命令解析器**（第 1 段新增）：扩展名优先级、PATH/PATHEXT、MSYS 路径映射、shebang 回退、退出码归一。`_log.mjs` 与后续的 `probe-engines` / `env-doctor` 共用它 |
| `<工具>`（无扩展名） | Git Bash / MSYS 垫片（3 行，调 `_log.mjs`） |
| `<工具>.cmd` | cmd.exe 垫片（`cmd` 与 **PowerShell** 都通过它解析，`.PS1` 不在 PATHEXT 里） |
| `<工具>.ps1` | 显式调用（`.\sed.ps1 …`）时可用；PATH 解析不会用到它 |

覆盖的工具：`sed` `perl` `python` `python3` `sleep` `playwright` `npx` `npm`。

### 二·补 · 真实命令怎么解析（第 1 段 · P0-1 / P0-2）

放行之后要找"真正的那个命令"来跑。**这里出过一次致命事故**，所以规则现在写死：

1. **扩展名优先级**：`.exe → .cmd → .bat → .com → 其余 PATHEXT 条目 → 无扩展名（永远最后）`。
   旧实现把「无扩展名」排在第一位，于是在 Windows 上永远选中 node 安装目录里给 Git Bash 用的
   `npm` / `npx`（`#!/usr/bin/env bash` 脚本），再用 `/usr/bin/env` 去 spawn → 必然 ENOENT →
   被算成退出码 0。「命令没跑、却报成功」就是这么来的。
2. **MSYS 路径映射**：PATH 里的 `/usr/bin`、`/mingw64/bin`、`/bin` 会映射到真实安装目录
   （优先 `cygpath -w`，其次从 PATH 反推安装根：`…\Git`、`C:\msys64` 等）。
3. **无扩展名的脚本**优先用**同目录同名 `.exe/.cmd/.bat/.com` 垫片**跑（这正是 cmd.exe 自己的选择顺序）；
   垫片不存在时才用 shebang 解释器（真实 Git/MSYS 的 bash 优先，排除 `C:\Windows\System32\bash.exe`
   这个跑不了 Windows 脚本的 WSL 垫片）；最后才兜底直接执行。
4. **退出码归一**：进程没起来（spawn 失败 / 既无退出码也无信号）**一律 127**，
   找不到命令也是 127；**绝不返回 0**。终端会明确说出原因（fail-open 但必须出声）。
   只在"进程根本没起来"时才换下一个方案；已经跑起来就绝不重试（避免重复执行有副作用的命令）。

**为什么三种形态都要**（本机实测，不是猜的）：

| 调用方 | 实际命中的是 |
|---|---|
| Git Bash（Claude Code 的 Bash 工具走这条） | 无扩展名的 `sed`（bash 优先精确名） |
| `cmd.exe` | `sed.cmd` |
| PowerShell | `sed.cmd`（PATHEXT 里有 `.CMD`，没有 `.PS1`） |

---

## 三、拦什么、放什么

| 工具 | 拦 | 放行（记账） | 放行（不记账） |
|---|---|---|---|
| `sed` | `sed -i` / `--in-place` | — | `sed -n`、管道里的 `sed 's/x/y/'` |
| `perl` | `perl -i` | — | 其它 |
| `python` / `python3` | `-c` / 管道 **且** 内容含 `open(...,'w')`、`writeFile`、`.replace(` 等写操作 | — | `python -c "print(1)"`、`python 文件.py` |
| `sleep` | `sleep N`（N ≥ 30，可用 `HARNESS_SLEEP_LIMIT` 改） | — | `sleep 1` |
| `playwright` / `npx playwright` | 本会话**成功**跑满 2 次之后 | 前 2 次 | — |
| `npm test` / `npm run ci` / `npx … test` | 本会话**成功**跑满 3 次之后 | 前 3 次 | — |
| `npx vitest/jest/mocha/pytest` | 不拦（那是 L1 定向单测） | ✅ 记账 | — |

「成功」= 退出码 0。**失败的运行不计数**（决策 3）。

拦截时的消息固定四段：**拦了什么 / 为什么 / 替代做法 / 怎么解除**——
弱模型看到 deny 会改做法，前提是它知道该怎么做。

---

## 四、逃生阀（不会把人卡死）

| 方式 | 作用范围 |
|---|---|
| 建 `<项目>\.harness\bypass` 文件（用完删掉） | 该项目的所有包装器全部放行 |
| `HARNESS_BYPASS=1` | 当前环境全部放行 |
| `HARNESS_ALLOW_SLEEP=1` | 只放行长 `sleep` |
| `HARNESS_SLEEP_LIMIT=120` | 改 sleep 阈值 |
| `HARNESS_NEED_E2E=1` | 放行一次 E2E（对应决策 3 的「带理由的追加」） |
| `HARNESS_NO_WRAP=1` | 完全停用包装判断（仍记一行日志） |

放行时也会写一行日志（`decision = "bypass"`），审计会统计逃生阀用了多少次。

---

## 五、日志

写到 **工作区根**（不是项目里）的 `日志\02-命令\cmd-<YYYY-MM-DD>.jsonl`，每行一条 JSON。
被拦下的命令**额外**再记一行到 `日志\04-拦截\block-<YYYY-MM-DD>.jsonl`（规则 + 命令 + 原因 + 替代建议）。
第 2 段（日志中心）：项目内 `.harness\logs\` 已取消 —— 项目是要交付的，不能留 harness 的运行痕迹。

```json
{"ts":1789138582309,"time":"20260911-225622","source":"wrapper:_log.mjs","tool":"sed","args":["-i","s/a/b/","x.ts"],
 "cmd":"sed -i s/a/b/ x.ts","cwd":"C:\\...\\我的项目\\foo","project":"C:\\...\\foo",
 "session":"20260911-225622-12345","engine":"claude-code",
 "decision":"deny|allow|bypass|notfound|spawnfail","rule":"sed|e2e-quota|pass|…",
 "real":"C:\\Program Files\\Git\\usr\\bin\\sed.exe","via":"cmd 垫片","exit":0,"ok":true,"ms":53}
```

- `via`（第 1 段新增）：真实命令是**怎么跑起来的** —— `直接执行` / `cmd 垫片` / `shebang:…#!…` / `同名垫片直接执行`。
- `spawnfail`：进程根本没起来（`exit: 127`，附 `attempts` 说明试过哪些方案、各自报什么错）。
- `notfound`：PATH 里找不到真实命令（`exit: 127`）。
- `source`（第 2 段新增）：这条记录是谁写的 —— `wrapper:_log.mjs` / `hook:guard-bash` / `hook:guard-tools`。
- 单文件超过 8 MB 自动轮转成 `cmd-<日期>.<时间戳>.jsonl`（审计按 `cmd-*.jsonl` 通配读取；轮转由日志中心统一做）。
- 配额另存于 `<项目>\.claude\state\quota.json`（按会话分桶，保留最近 20 个会话；`policy.mjs` 的 `stateFile()`）。
- 日志根怎么定：`HARNESS_LOG_ROOT`（启动器会设）→ 否则「含 AI-Dev-Harness\ 的目录」下的 `日志\`。
  写不进去时只往 stderr 出声（`[harness] ⚠️ 日志中心：…`），**命令照常执行、退出码不变**。
- **状态落点（第 3 段）**：设了 `HARNESS_STATE_DIR` 时，`.claude\state\` 下的运行态
  （quota / ctx / stop-guard / 自主学习去重）整体搬到那下面 —— 默认不设，行为与以前完全一样。

<项目> 读的是 `HARNESS_PROJECT`，缺省用当前工作目录。

**审计**：`node AI-Dev-Harness\自定义\scripts\audit.mjs --project <项目>`（U3）。

---

## 六、已知局限（如实说明）

| 局限 | 说明 |
|---|---|
| ⚠️ **Claude Code 的 Bash 工具里拦不住 `sed`** | 该工具开的是 **login shell**，`/etc/profile` 会把 `/usr/bin` 等 MSYS 目录**重新提到 PATH 最前面**（实测：`command -v sed` → `/usr/bin/sed`，我们的目录排在第 10 位）。`bash -l` 又不读 `BASH_ENV`，所以这条路径 U4 赢不了。**这条路径由 U5 的 hooks 兜住**（第 2/5 批已实测拦截 `sed -i`）。<br>U4 实际生效的场合：`cmd.exe`、PowerShell、非登录 `bash -c`、以及**任何不重排 PATH 的引擎 shell**（均已实测拦截）。 |
| 只对**通过 harness 启动**的会话生效 | 在 Trae IDE 里直接开对话不走 `run.bat` |
| 只拦 **shell 命令** | 引擎内置的文件编辑工具（Claude Code 的 Edit/Write）拦不到 —— 那靠 U5 的 hooks |
| **PowerShell 里 `sleep` 拦不到** | PowerShell 把 `sleep` 定义成 `Start-Sleep` 的**别名**，别名优先于 PATH。`sed`/`python` 等没有别名的照常拦（已实测） |
| 绝对路径调用绕不过 | `C:\Program Files\Git\usr\bin\sed.exe -i` 不走 PATH |
| 每次调用多一次 node 启动 | 约 50–100 ms。密集循环里会有感知，但换来的是跨引擎强制 |

---

## 七、`_env.sh` 与 `BASH_ENV`（第 3 段 · P2-3 收敛）

`_env.sh` 的作用是「引擎重置了 PATH 时，把 `自定义\bin` 重新前置回来」，它靠 `BASH_ENV` 被**非登录 bash** 读到。

**第 3 段改了默认值**：启动器**不再无条件**设 `BASH_ENV`。

| 项 | 旧行为 | 现在 |
|---|---|---|
| `BASH_ENV` | 启动即全局设上 | **默认不设**；要开用 `HARNESS_BASH_ENV=1` |
| 影响面 | npm / git / 各类构建脚本内部起的非登录 bash **统统被注入** | 不再波及第三方进程 |
| `_env.sh` 本身 | 直接拼 PATH | **幂等**（已在 PATH 就不重复前置）、目录不存在就不动 PATH、`set -u` 安全、失败不致命 |

为什么可以放心默认关掉：主路径（PATH 前置 + U5 hooks）已经覆盖；
`BASH_ENV` 只对「引擎把 PATH 重置了、又没有 hooks」这种少见组合才起作用，代价却是扰动所有子进程 —— 不对称。
| **Git 的 `/usr/bin` 不在 PATH 上时，`sleep` 这类 unix 工具找不到** | 会**如实返回 127 并出声**（不会假装成功）。正常 Git Bash / Claude Code 会话里 `/usr/bin` 在 PATH 上，映射后可正常找到（`wrappers-selftest` 的 B4/C-sleep 覆盖此项） |
| 判定规则与 hooks **是两份实现** | `_log.mjs` 的 `judge()` 与 `.claude/hooks/lib/policy.mjs` 必须保持一致；自检台里有断言交叉核对两者的判定结论 |

**最重要的一条**：U4 是唯一真正跨引擎的强制层，但覆盖面（仅 shell 命令、仅 harness 启动的会话）有限。
通用方案是「多层叠加」，不是「一招通吃」。
