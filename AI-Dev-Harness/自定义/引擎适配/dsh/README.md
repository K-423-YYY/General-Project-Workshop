# DeepSeek Harness 适配（--patch 叠加层）

> `--patch` 的用法与语义由第 6 批**实测**得出（verified-live：标记行差分 + 对照组）。
> 复现：`node ../../scripts/probe-engines.mjs --engine deepseek-harness --verbose`

> **第 3 段状态（2026-09-12）**：✅ 本机**在机并已复验** —— `%APPDATA%\npm\dsh.cmd`，
> 版本 **0.1.0-rc.6**（由 `../../scripts/lib/engine-detect.mjs` 探测，统一解析器判定）。
> `--patch` 的「标记行差分 + 对照组」本轮**重新跑过一遍**，结论仍是 `verified-live`。
>
> ⚠️ 提醒：在**受限沙箱**里跑探测时 `%APPDATA%\npm` 可能读不到，会把 dsh 探成「没装」——
> 那是沙箱的假象。跑探测 / 自检台请在非沙箱环境（见 `../引擎能力矩阵.md` 第四节）。

---

## 一、`--patch` 是什么

```
dsh --profile <profile> --patch <path> [--patch <path> …] "<任务>"
```

- `--patch <path>`：**额外叠加一层 patch**，可重复，按 argv 顺序叠加。
- 层序（从 dsh 源码 `profile-boot` 核实）：
  **bundle 层 → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 叠加层**
- 所以 `--patch` 是**优先级最高**的一层。
- 相关只读命令：
  - `dsh --profile X --dump-default-config` —— 打印默认组合（**不含**用户层与 `--patch`）
  - `dsh --profile X --dump-config` —— 打印合并后的组合（**含**用户层与 `--patch`）

## 二、patch 文件的格式

顶层必须是 **YAML 数组**。每项是「插入」或「覆盖」：

```yaml
# 插入到根
- insert:
    - id: my-row
      name: '<包名>'
      config: { … }

# 插入到某个 group 行内部
- id: some-group-id
  insert:
    - id: my-child-row
      name: '<包名>'

# 覆盖已有行（整键替换）
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'   # 可选；写了就必须一致
  config:
    maxBytes: 131072
```

**实测到的行为**（每条都有对照组）：

| 情况 | 行为 |
|---|---|
| 顶层不是数组 | **启动时抛错**：`must be a top-level YAML array of loader patch entries` |
| patch 文件不存在 | **抛错**：`failed to read overlay …`（overlay 缺失 = 配置错误，不是「没有这一层」） |
| 目标 `id` 不存在 | **只告警**：`patch: entry "x" not found`，不中断 |
| `name` 与目标不符 | **跳过该条并告警**：`name mismatch for "x" (expected …)` |
| `insert` 的目标不是 group | 告警：`patch insert: entry "x" is not a group` |
| 覆盖一个键 | **整键替换**（`target[key] = value`），**不是深合并**——写 `config` 就得写全 |

> 最后一条最容易踩：想改 `config` 里的一个子字段，也必须把整个 `config` 写出来。

## 三、`patch-overlay.yml` 里有什么

| 条目 | 作用 | 状态 |
|---|---|---|
| 覆盖 `agent-instructions.config.maxBytes` → 131072 | 给 AGENTS.md 注入留足预算 | **已实测可加载** |
| 插入一个「命令包装」插件行 | DSH 侧真正的强制层 | **示例，注释掉**（插件本体是第 7 批的活，本批不发明包名） |

## 四、⚠️ DSH 会自动读 AGENTS.md（本批推翻旧说法）

旧的 `内置/adapters/deepseek-harness.md` 写「DSH 没有自动读 `AGENTS.md` 的机制」。
本批实测：headless 组合里的 `agent-instructions` 行**处于启用状态**
（`config.maxBytes: 65536`），会按「`$DSH_HOME/AGENTS.md` → 项目根 → cwd」逐级加载
`AGENTS.md` / `CLAUDE.md`，以 `<system-reminder>` 块注入第一条请求。

**所以 DSH 的规则入口有两个**：
1. **U1** —— 项目里的 `AGENTS.md`（DSH 自己会读）
2. **U2** —— `run` 脚本注入的启动词（仍然要做：客户端形态、非 harness 入口都靠它）

> 边界：这一条是「默认组合里该行启用 + 该插件自带 README」推出的，**没跑真会话验证**。
> 能力表里标为需要进一步确认。

## 五、本批**没有**做到的事

- 没有写 DSH 的命令拦截插件（那需要发一个插件包，属于第 7 批 U4）。
- 没有在真会话里验证 `--patch` 的**运行时**效果（只验证了「组合树里有这一行」）。
  `--dump-config` 证明的是 patch 被正确应用到了组合，不等于插件在运行时行为正确。
- 没有碰 `~/.dsh/settings.yaml` / `~/.dsh/.credentials.yaml`（探测铁律：可能含 API key）。
- 没有把 `--patch` 接进 `run` 脚本（第 7 批接线）。

> 附注：`dsh --dump-*` 会重写 profile 目录里的 `cordis.yml`——那是 dsh 自身的既有行为
> （该文件固定为空根列表，每次 dump 都会重写），不是本批写入的。
