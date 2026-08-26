---
name: automation-setup
description: 安装并配置自动化长任务脚本（codex-autoresearch），确保长任务可循环执行、中断恢复。
---

# Automation Setup

## 适用场景
项目开始阶段，步骤 2。

## 必须遵守规则
1. 配置前先备份原配置文件。
2. 以当前 CLI 实际支持的参数为准。
3. 配置完成后必须用小任务验证。

## 执行步骤
1. 全局安装：
   ```powershell
   npm install -g codex-autoresearch
   ```
2. 确认版本：
   ```powershell
   codex-autoresearch --version
   ```
3. 配置 CODEX_BIN 指向原生 codex 可执行文件：
   ```powershell
   [Environment]::SetEnvironmentVariable("CODEX_BIN", "原生codex.exe完整路径", "User")
   ```
4. 查看当前 CLI 参数：
   ```powershell
   codex exec --help
   ```
5. 如当前 CLI 不支持 --full-auto：
   ```powershell
   [Environment]::SetEnvironmentVariable("USE_FULL_AUTO", "0", "User")
   ```
6. 在 ~/.codex/config.toml 添加：
   ```toml
   sandbox_mode = "workspace-write"
   ```
7. 小任务验证：
   ```powershell
   codex-autoresearch --no-full-auto --skip-git-repo-check --no-stream run "只回复 OK"
   ```
   确认输出 status: completed。

## 验证方式
- codex-autoresearch --version 可正常输出。
- 小任务返回 completed。
- 脚本可在目标目录运行。

## 问题与解决方案
| 问题 | 第一方案 | 备用方案 | 是否需要手动 |
|---|---|---|---|
| spawn EPERM | 设置 CODEX_BIN 指向原生可执行文件 | 重建全局链接 | 否 |
| 子进程只读沙箱 | 配置 sandbox_mode=workspace-write | 在普通终端运行 | 否 |
| CLI 参数变化 | 以 --help 为准 | 提示用户确认 | 否 |
| npm 脚本被阻止 | 使用 npm.cmd | 询问用户修改执行策略 | 否 |
| 子进程无网络/凭据 | 停止脚本，提示用户 | 用户手动执行 | 是 |

## 禁止行为
- 禁止使用旧版参数硬编码。
- 禁止修改配置前不备份。
- 禁止未验证就进入下一步。

## 成功判定
- 脚本已安装。
- 配置已完成。
- 小任务验证通过。
