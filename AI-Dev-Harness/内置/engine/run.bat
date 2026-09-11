@echo off
rem 终端模式入口（可选）。平时推荐直接用客户端对话框。
rem 第 3 段（锁定决策 10）：本入口会先列出**本机可用引擎**（同一份 engine-detect.mjs 判定），
rem   回车沿用上次选择，选择结果落盘到 <harness>\state\engine-choice.json（或 HARNESS_STATE_DIR）。
rem   启动后会打印「本次引擎 + 机制层是否生效」横幅，让你一眼看到 harness 真的起来了。
rem   Windows 的引擎（codex/claude/dsh）都是 *.cmd 垫片，参数必须单行传：
rem   所以 run.ps1 用 build-prompt.mjs --single-line 生成启动词。
chcp 65001 >nul
title harness 启动器 - AI-Dev-Harness
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
exit /b %ERRORLEVEL%
