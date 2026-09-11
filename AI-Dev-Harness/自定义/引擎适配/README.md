# 引擎适配（F11 · 第 6 批）

> 本目录是**引擎专属机制层（U5）的落地配置**。
> 探测结果与置信度见 `../引擎能力表.json`（由 `../scripts/probe-engines.mjs` 生成）。

> **第 3 段（2026-09-12）新增**：人读版**引擎能力矩阵**见 [`引擎能力矩阵.md`](引擎能力矩阵.md)
> —— 一张表看清「换引擎之后机制层还剩几成强制力」。

---

## 一、这一批查明了什么

| 引擎 | 机制层 | 置信度 | 配置文件 |
|---|---|---|---|
| **Claude Code** | hooks | **verified-live**（第 2/3 批真会话实测） | `.claude/settings.json` |
| **Claude Code（桌面端）** | 同一套 hooks | **配置同源**；生效条件更严：**只有在项目目录里开会话才生效** | 同左（见 `claude-code/README.md`） |
| **Codex CLI** | hooks | **config-verified**（本批差分探测；第 3 段用 0.153.4 复验「片段合法」通过） | `~/.codex/config.toml` 的 `[hooks]` 段 |
| **DeepSeek Harness** | 插件 / patch 层 | **verified-live**（本批 `--patch` 标记行差分实测） | `~/.dsh/cordis.patch.yml` |
| **TraeCode CLI** | **未查明**（CLI 未安装） | 未查明 | 未查明 |
| **Trae IDE** | 无机制层（图形端） | 只能 `.trae/rules/` + 启动词 | `.trae/rules/` |

**探测铁律**：绝不读用户配置文件（可能含 API key）；只用只读命令；靠报错信息推断字段。
本批所有结论都可以用 `node ../scripts/probe-engines.mjs` 复现，**0 次模型请求**。

---

## 二、两个必须记住的结论

### 1. Codex 的 hooks 格式（本批新查明）

```toml
[hooks]
PreToolUse = [
  { matcher = 'Bash', hooks = [ { type = 'command', command = '…', timeout = 10 } ] },
]
```

- **事件名有 12 个**（逐个差分验证过）：
  `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PreCompact` / `PostCompact` /
  `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `SubagentStart` / `SubagentStop` /
  `Stop` / `Interrupt`
- **处理器类型有 4 种**（引擎自己报出来的合法取值）：
  `command` / `mcp_tool` / `prompt` / `agent`
- **`command` 型的字段**：`command`（字符串）、`commandWindows`（字符串）、
  `timeout`（u64 秒）、`async`（布尔）、`statusMessage`（字符串）、`additionalContextLimit`（usize）
- **有 trust 持久化**：首次启用 hooks 时 Codex 会要求一次信任确认；
  `--dangerously-bypass-hook-trust` 可跳过（仅供已知来源的自动化）。
  trust 状态字段：`enabled`、`trusted_hash`。

> ⚠️ 与 Claude Code 的差异：Codex 的 `prompt` / `agent` 型处理器**会调用模型做判断**——
> 按原则 1（机制优先于提示词），**一律不用**，只用 `command` 型确定性脚本。

### 2. ⚠️ DSH 其实**会**自动读 `AGENTS.md`（推翻了旧适配器文档）

`内置/adapters/deepseek-harness.md` 写的是「DeepSeek Harness 没有自动读 `AGENTS.md` 的机制」。
**本批实测表明这句话对 dsh 0.1.0-rc.6 不成立**：

`dsh --profile headless --dump-default-config` 里有一行

```yaml
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
```

它处于**启用**状态，行为是：按「`$DSH_HOME/AGENTS.md` → 项目根 → cwd」逐级加载
`AGENTS.md` / `CLAUDE.md`（以及 `AGENTS.local.md` / `CLAUDE.local.md` 覆盖层），
以 `<system-reminder>` 块注入第一条请求。

**这对方案的影响（好消息）**：
DSH 不再只靠 U2 启动词注入——它也能吃到 **U1 规则单一来源**生成的 `AGENTS.md`。
U2 从「唯一入口」降级为「兜底 + 强化」，但**仍然要做**（用户的 DSH 客户端形态、非 harness 入口另说）。

**边界（如实说）**：这一条是从「默认组合里该行启用 + 该插件自带文档」推出的，
**没有**跑真会话验证过（那要花钱）。能力表里归为需进一步确认的一项。

---

## 三、怎么用

| 引擎 | 做什么 | 命令 |
|---|---|---|
| Codex | 把 `codex/config-hooks.toml` 的 `[hooks]` 段并进 `~/.codex/config.toml` | 见 `codex/README.md` |
| Claude Code（终端/桌面端） | 什么都不用做：`run.bat` 会自动把 `.claude\` 机制层同步进项目 | 见 `claude-code/README.md` |
| DSH | 用 `--patch` 叠加 `dsh/patch-overlay.yml` | 见 `dsh/README.md` |
| TraeCode | **暂无**（未查明） | 见 `traecode/README.md` |
| Trae IDE | 只能靠 `.trae/rules/` + 启动词（图形端没有可注入的机制层） | 见 `引擎能力矩阵.md` |

> **第 3 段补**：`run.bat` 启动时会列出**本机可用引擎**（判定只有一份实现：
> `../scripts/lib/engine-detect.mjs`），回车沿用上次选择，选择结果落在
> `AI-Dev-Harness\state\engine-choice.json`（或 `HARNESS_STATE_DIR`）。
> 启动后打印「本次引擎 + 机制层是否生效」横幅 —— 用户一眼就能看出 harness 有没有真的起来。

> **本批只做到「探明 + 备好配置片段」，没有自动接线。**
> 让适配层自动生效属于第 7 批（U4 命令包装 / 启动接线）的范围——
> 因为对 Codex 是写用户级 `~/.codex/config.toml`（超出 harness 边界，必须用户自己点头），
> 对 DSH 是给 `run` 脚本加 `--patch` 参数。
