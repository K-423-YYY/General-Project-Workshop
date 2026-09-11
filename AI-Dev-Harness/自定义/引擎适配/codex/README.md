# Codex CLI 适配（hooks）

> 格式由第 6 批 `probe-engines.mjs` 用 `--strict-config` **差分探测**得出（config-verified）。
> 复现：`node ../../scripts/probe-engines.mjs --engine codex-cli --verbose`

> **第 3 段复验（2026-09-12，codex 0.153.4）**：本机装了 codex；
> `config-hooks.toml`（替换 `<harness>` 后）交给 `codex --strict-config` **被接受**，
> 对照组（不存在的键）按预期报 `unknown configuration field`。
> ⚠️ 但**真会话仍未跑**（要花额度）—— 配置合法 ≠ hooks 在真会话里被调用过。
> 能力表里这两件事分开标：`config-verified` / `真会话未实测`。

---

## 一、配置写在哪

Codex 的 hooks 写在**用户级配置** `~/.codex/config.toml` 的 `[hooks]` 段。

> ⚠️ **这一步需要用户本人点头**：`~/.codex/config.toml` 在 harness 边界之外，
> 而且它是 Codex 自己的配置文件（文件里通常还有模型/提供商设置）。
> 本批**没有**替你改它——`config-hooks.toml` 是给你**手动合并**用的片段。

也可以用 `-c` 在命令行覆盖（不改文件）：

```powershell
codex -c "hooks.PreToolUse=[{ matcher = 'Bash', hooks = [ { type = 'command', command = '…' } ] }]" exec "任务"
```

---

## 二、格式

```toml
[hooks]
PreToolUse = [
  { matcher = 'Bash', hooks = [ { type = 'command', command = 'node "…\hook-guard.mjs"', timeout = 10 } ] },
]
```

- 每个事件的值是**数组**，数组元素是「匹配组」`{ matcher, hooks }`。
- `matcher` 是**字符串**（本批只确认了类型是字符串；它匹配工具名还是命令正则，**未实测**）。
- `hooks` 是**数组**，元素是处理器。处理器是 internally tagged enum：
  `type = 'command' | 'mcp_tool' | 'prompt' | 'agent'`。
- `command` 型可用字段：`command`、`commandWindows`（Windows 专用覆盖）、`timeout`（u64 秒）、
  `async`（bool）、`statusMessage`、`additionalContextLimit`（usize）。

**路径写法**：Windows 路径请用 TOML **单引号字面串**（`'…'`），
或用双引号时把每个反斜杠写成 `\\`——否则 TOML 会把 `\U`、`\自` 之类当成非法转义。

## 三、事件名（12 个，逐个验证过）

```
PreToolUse  PermissionRequest  PostToolUse  PreCompact  PostCompact
SessionStart  SessionEnd  UserPromptSubmit  SubagentStart  SubagentStop
Stop  Interrupt
```

跨引擎对照（本 harness 用到的）：

| 用途 | Claude Code | Codex |
|---|---|---|
| 拦截命令 | `PreToolUse` | `PreToolUse` |
| 注入规则 | `SessionStart` | `SessionStart` |
| 收尾写 HANDOFF | `Stop` | `Stop` |
| 压缩保留指令 | `PreCompact` | `PreCompact` |

## 四、信任（trust）

Codex 要求 hooks **先被信任**才会执行，并且会持久化这个信任
（二进制里的状态字段：`enabled`、`trusted_hash`）。
首次启用时 Codex 会问你一次；跳过开关是 `--dangerously-bypass-hook-trust`。

> **本批没有验证 trust 的落盘位置**——那要看用户配置目录里的状态文件，属于探测铁律禁止的范围。

## 五、`hook-guard.mjs` 的诚实说明

同目录的 `hook-guard.mjs` 是一个**最小**的 PreToolUse 处理器：
它的第一职责是**把 stdin 原样落盘**（协议侦察），其次才做 `sed -i` 拦截。

> ★ 第 3 段（P2-6）改了落盘位置：**不再写进本交付目录**，改写到
> `<harness>\state\codex-probe\stdin.jsonl`（`HARNESS_STATE_DIR` 可重定向）。
> 三个理由：① 交付目录是要分发的东西，不该越用越脏（旧位置会攒出一个只增不减的 jsonl）；
> ② 交付目录可能是只读的（复制/解压后），写不进去会让自检台红一项 —— 那是假失败；
> ③ 状态目录本来就有 `HARNESS_STATE_DIR` 开关，正好支撑「状态写临时目录」的验收。

> ⚠️ **它没有在真实 Codex 会话里跑过**——跑真会话要花钱，本批遵守「零额度」原则没做。
> 协议细节（stdin 的 JSON 形状、退出码语义）是从二进制字符串 + 「PermissionRequest hook
> exited with code 2 but did not write a denial reason to stderr」这条内置错误信息推断的：
> **退出码 2 = 拒绝，stderr = 拒绝理由**（与 Claude Code 同形）。
>
> 所以第一次启用时请先看它落盘的 `stdin.jsonl`（路径见上），确认字段后再依赖它的拦截结论。
> 这正是第 2 批验证 `stop_hook_active` 时用过的同一套办法。

## 六、本批**没有**做到的事

- 没有验证 `matcher` 的匹配语义（工具名？正则？大小写？）。
- 没有用真会话验证 hooks 真的会被调用。
- 没有替你写 `~/.codex/config.toml`。
- 没有验证 `content`/`permissionDecision` 这类返回体字段是否与 Claude Code 一致
  （二进制里出现过 `hookEventNamepermissionDecisionpermissionDecisio…` 的字符串，
  **看起来**同形，但没有实测，所以不写进能力表当结论）。
