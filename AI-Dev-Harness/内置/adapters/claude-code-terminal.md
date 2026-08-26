# Claude Code 终端

## 形态
Claude Code CLI，在终端里运行（中文提示词）。

## 用法（可选终端模式）
```powershell
.\AI-Dev-Harness\内置\engine\run.bat "我想做一个记笔记的小程序"
```
脚本会自动调用 `claude -p`，注入中文提示词与对话协议，并指向同级 `我的项目` 文件夹。

## 终端命令说明（底层）
```bash
claude -p "<中文任务>" --output-format text --dangerously-skip-permissions
```
CLI 会读取工作目录下的 `CLAUDE.md` / `AGENTS.md`，因此规则同样生效。

## 注意
- 终端模式为可选；平时优先用客户端对话框。
- 不使用后台进程。
