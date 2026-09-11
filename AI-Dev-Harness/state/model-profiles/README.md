# state/model-profiles —— 模型能力画像

本目录由 `自定义/scripts/probe-model.mjs` 自动维护，**用户不需要手动改**。
（本 README 与 `.gitignore` 之外的文件一律不进仓库。）

## 为什么需要它

用户的第一优先级是：**换任何新模型都不要再来一次"上下文涨到 78 万"。**
办法是给每个「端点 + 模型」组合存一份能力画像 —— 第一次是保守值，
之后靠被动学习（零成本）或主动探测（花几分钱，需要用户点头）越用越准，并**永久缓存**。

## 文件名约定

```
<端点主机名>-<模型名>.json
例如：api.deepseek.com-deepseek-v4-flash.json
```

- 模型名里的 `[1M]` 后缀会被剥掉（它是客户端记账用的虚构后缀，不是真实模型名）
- 端点只取主机名，不带路径，避免 `https://` 和 `/anthropic` 污染文件名

## 字段说明

| 字段 | 含义 |
|---|---|
| `model` / `declaredName` | 归一化模型名 / 引擎里写的原始名（可能带 `[1M]`） |
| `endpoint` | 端点主机名 |
| `declaredWindow` | 引擎声明的窗口（含 `[1M]` 时会是 1000000，**不可信**） |
| `measuredWindow` | 主动探测测出来的窗口（`--probe` 才有） |
| `effectiveWindow` | 实际采信的窗口（保守值 / 静态表 / 探测值 ×0.8） |
| `autoCompactWindow` | **最终生效值** —— 写进 `.claude/settings.json` 的那个数 |
| `maxOutputTokens` / `supports*` | 能力位，影响输出整形阈值与会话切分 |
| `instructionFollowing` | 指令遵循度 0–1；`< 0.7` 判严格模式，`>= 0.85` 判标准模式 |
| `hookStrictness` | 由 `instructionFollowing` **推导**（改动分数后重跑 env-doctor 会自动变） |
| `source` | `conservative` / `static` / `passive` / `probe` / `observed` |
| `evidence[]` | 每次学习动作的留痕（日期 + 信号 + 动作），append-only |
| `lastUpdated` | ISO 时间戳 |

## 谁在读写

| 脚本 | 动作 |
|---|---|
| `自定义/scripts/probe-model.mjs` | 读（默认）/ 写（`--record` 被动学习、`--probe` 主动探测） |
| `自定义/scripts/env-doctor.mjs` | 只读，用于体检报告与启动词生成 |
| `自定义/scripts/lib/model-capability.mjs` | 共用的解析与读写实现 |

## 手动干预（一般用不到）

想让某个模型走标准模式：把 `instructionFollowing` 改成 `>= 0.85`，再跑 `node env-doctor.mjs`，
`hookStrictness` 会自动变成 `standard`。

想钉死压缩上限：在画像里加 `"autoCompactWindow": <值>, "autoCompactWindowPinned": true`。
（上限仍受 `模型能力表.json` 的 `hardCeiling` 夹取。）
