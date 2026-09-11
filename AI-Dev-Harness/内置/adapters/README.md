# adapters（软件适配说明）

本目录说明 8 个软件形态如何接入本通用工作区。所有软件统一遵守 `..\自定义\对话协议.md`。

- codex-client.md          Codex 客户端（桌面对话框）
- claude-code-client.md    Claude Code 客户端
- claude-code-terminal.md  Claude Code 终端
- deepseek-harness.md      DeepSeek Harness（客户端 + 终端，全中文）
- trae-ide-cn.md           Trae IDE 国内版
- trae-ide-intl.md         Trae IDE 国际版
- trae-work.md             TraeWork 桌面版
- traecode-cli.md          TraeCode CLI（终端）

> 本目录属于「内置区」，用户无需修改。

---

## 统一补充（第 4 段后的行为，8 个形态都适用）

1. **规则入口**：客户端形态优先让 AI 自动读 `AGENTS.md`；读不到就粘贴 `..\开始项目.md` 的内容。
2. **终端形态**：跑 `..\engine\run.bat "项目目标"` —— 它会先列出可用引擎（回车沿用上次选择），
   启动时打印「本次引擎 + 机制层是否生效」，再注入启动词。引擎能力与生效条件见 `..\..\自定义\引擎适配\引擎能力矩阵.md`。
3. **机制层只在特定条件生效**：Claude Code（终端/桌面）靠 `.claude\` 的 hooks，桌面端**只有在项目目录里开会话**才拿到；
   Codex 靠用户级 `~/.codex/config.toml` 的 `[hooks]` 段（需手动合并，harness 不碰用户级配置）；
   DSH 靠 `--patch` 叠加层；Trae 系列只有 `.trae\rules\` + 启动词。**没装机制层的引擎 = 只剩启动词这一道防线。**
4. **交付流程（8 个形态一致）**：清理先出「将删除 / 将保留」清单、用户确认后才执行，清完跑纯净度自检；
   GitHub 只给步骤与命令、不代推。铁律见根 `AGENTS.md` 第五节。
