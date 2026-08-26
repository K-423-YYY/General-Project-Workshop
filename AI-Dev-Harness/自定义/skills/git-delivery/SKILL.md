---
name: git-delivery
description: 完成 git 初始化、提交、远程仓库创建、推送和远程验证。
---

# Git Delivery

## 适用场景
步骤 8-9：集成与交付。

## 必须遵守规则
1. 只提交计划内文件。
2. 推送前先验证本地状态。
3. 推送失败按模板第一方案处理，仍失败则移交用户手动执行。

## 执行步骤
1. 初始化 git：
   ```powershell
   git init -b main
   ```
2. 创建 .gitignore，排除运行状态目录、临时目录、依赖目录、构建产物、敏感文件。
3. 检查未跟踪文件：
   ```powershell
   git status
   ```
4. 提交：
   ```powershell
   git add -A
   git commit -m "项目提交说明"
   ```
5. 创建远程仓库（API 或浏览器）。
6. 配置远程：
   ```powershell
   git remote add origin https://github.com/用户名/仓库名.git
   ```
7. 推送：
   ```powershell
   git push -u origin main
   ```
8. 远程验证：
   ```powershell
   git ls-remote origin
   git log --oneline -1
   git rev-parse HEAD
   ```

## 验证方式
- 本地与远程提交 SHA 一致。
- 远程文件清单正确。
- 如自动化环境无法访问远程，请用户浏览器确认。

## 问题与解决方案
| 问题 | 第一方案 | 备用方案 | 是否需要手动 |
|---|---|---|---|
| 网络代理失败 | 清代理后重试 | 换代理/镜像 | 否 |
| 推送网络不稳定 | 重试推送 | 用户手动推送 | 是 |
| 仓库名冲突 | 换名并提示用户 | 复用已有仓库 | 是 |
| 凭据不可用 | 提示用户检查登录 | 用户重新登录/生成 token | 是 |
| 空仓库 API 上传失败 | 先创建初始文件再上传 | 手动推送 | 否 |

## 禁止行为
- 禁止提交临时文件、日志、token。
- 禁止推送未验证内容。
- 禁止在用户未确认前公开发布。

## 成功判定
- 本地无未提交改动。
- 远程仓库可访问且内容正确。
- 提交 SHA 与本地一致。
