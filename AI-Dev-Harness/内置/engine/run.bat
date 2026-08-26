@echo off
rem 终端模式入口（可选）。平时推荐直接用客户端对话框。
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
exit /b %ERRORLEVEL%
