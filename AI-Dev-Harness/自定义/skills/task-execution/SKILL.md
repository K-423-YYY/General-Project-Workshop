---
name: task-execution
description: 严格按项目计划书执行主任务，长任务中断时恢复，发现偏离计划时停下询问用户。
---

# Task Execution

## 适用场景
步骤 6：执行主任务。

## 必须遵守规则
1. 严格按计划书执行。
2. 不擅自扩大范围、改变实现方式。
3. 发现需要偏离计划时，先停下询问用户。
4. 长任务中断时优先恢复，不重头开始。

## 执行步骤
1. 创建任务提示文件 prompt.md，包含不可变目标、可变执行步骤、验收标准。
2. 使用自动化脚本执行：
   ```powershell
   codex-autoresearch --no-full-auto --skip-git-repo-check --no-stream run --prompt-file .\prompt.md --frozen-goals-text "..."
   ```
3. 中断后恢复：
   ```powershell
   codex-autoresearch session resume --last
   ```
4. 每轮检查完成状态。
5. 发现异常或偏离计划时，调用 exception-handling。

## 验证方式
- 计划内任务全部完成。
- 每个任务验收标准满足。
- 无计划外改动。

## 问题与解决方案
| 问题 | 第一方案 | 备用方案 | 是否需要手动 |
|---|---|---|---|
| 长任务中断 | session resume --last | 重新创建任务 | 否 |
| 子进程无网络/凭据 | 停止脚本，提示用户 | 用户手动执行 | 是 |
| 需要偏离计划 | 停止并询问用户 | 等待用户决定 | 是 |

## 禁止行为
- 禁止绕过计划自行发挥。
- 禁止在用户未决定前偏离计划。
- 禁止把失败任务标记为完成。

## 成功判定
- 计划内任务全部完成。
- 验收标准全部满足。
- 无计划外改动。
