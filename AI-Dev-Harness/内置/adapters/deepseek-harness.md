# DeepSeek Harness（客户端 + 终端，全中文）

## 形态
DeepSeek Harness 的客户端对话框，或 DSH CLI（终端）。无论终端还是客户端，全程中文对话。

## 规则加载
- DeepSeek Harness 没有自动读 `AGENTS.md` 的机制，请粘贴 `AI-Dev-Harness\开始项目.md` 的内容，让 AI 自己去读 `自定义\对话协议.md`。
- 终端模式：`dsh --profile headless "<中文任务>"` 真实执行；失败时回落桥接（把执行指令写入 `.harness\exec-prompt.md` 交给 DSH 中的 AI）。

## 使用步骤（客户端）
1. 打开 DeepSeek Harness 对话。
2. 粘贴 `AI-Dev-Harness\开始项目.md` 的内容，再描述你的项目。
3. 全程中文对话。

## 使用步骤（终端，可选）
```powershell
.\AI-Dev-Harness\内置\engine\run.bat "我想做一个记笔记的小程序"
```

## 注意
- 全中文对话，不用命令。
- 不使用后台进程。
