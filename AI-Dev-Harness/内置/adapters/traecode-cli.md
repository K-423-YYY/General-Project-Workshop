# TraeCode CLI（终端）

## 形态
运行在本地终端里的编码 Agent（TraeCode CLI），自然语言指令执行开发任务，支持插件、技能、MCP。

## 规则自动加载
- 项目规则：`项目根\.trae\rules\`（TraeCode CLI 会读取）。
- 个人规则：`~/.trae-cn/rules`（国内版）/ `~/.trae/rules`（国际版）。
- 因此阶段生成的 `.trae\rules\project_rules.md` 会被自动读取。

## 使用步骤（终端，可选）
```powershell
.\AI-Dev-Harness\内置\engine\run.bat "我想做一个记笔记的小程序"
```
脚本检测到 TraeCode CLI 时，会用中文提示词调用它，并指向同级 `我的项目` 文件夹。

## 注意
- 终端模式为可选；平时优先用客户端对话框。
- 不使用后台进程。
