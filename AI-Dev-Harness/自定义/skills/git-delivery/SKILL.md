---
name: git-delivery
description: 交付阶段的 git 与远程同步：本地初始化/提交/验证由 AI 做，GitHub 只告知步骤与命令、不代推（用户明确要求才代做）。
---

# Git Delivery（只告知，不代推 · 锁定决策 5）

## 适用场景
步骤 8-9 集成与交付；以及用户说「想把这个项目传到 GitHub / 备份到远程」的任何时刻。

## 铁律
- **本地动作**（`git init` / `add` / `commit` / `status` / `log`）AI 自己做。
- **远端动作**（新建仓库、`git remote add`、`git push`、改可见性）**默认不由 AI 执行** ——
  只输出一份用户可直接复制执行的「步骤 + 命令」，由用户自己跑。
- **唯一例外**：用户**明确**说「你帮我推 / 你代做」时才代做；执行前先确认地址与公开/私有，执行后把原始输出给用户看。
- 不擅自编造仓库地址、仓库名、可见性；缺信息就问，不猜。
- 不提交密钥 / `.env` / 日志 / 运行态 / 依赖与构建产物。

## 执行步骤

### A. 本地（AI 做，做完给用户看 `git status --short`）
1. `git init -b main`（已是仓库则跳过）
2. 写 `.gitignore`：依赖、构建产物、运行态、日志、密钥、OS 垃圾
3. `git status --short` 看清单，只提交计划内文件
4. `git add -A` → `git commit -m "<说明>"`
5. `git log --oneline -1` + `git status --short` 确认干净

### B. 远端（只告知：把下面这段原文交给用户）
```powershell
# 1) 在 GitHub 网页新建空仓库（不要勾 README / .gitignore），复制仓库地址
# 2) 关联远程（<URL> 用你复制的地址；已有 origin 就用第二行改地址）
git remote add origin <URL>
git remote set-url origin <URL>
git remote -v          # 预期：push / fetch 两行，地址正确
# 3) 推送
git push -u origin main    # 预期：末尾出现 "branch 'main' set up to track 'origin/main'"
# 4) 自证（可选）
git ls-remote origin       # 预期：打印远程 HEAD 与 refs/heads/main
git rev-parse HEAD ; git log --oneline -1
```
> 要私有仓库就在新建页面勾 **Private**，要公开勾 **Public** —— 这一步在网页上做，AI 不代操作。

### C. 用户执行之后
- 让用户回报结果（贴输出或说「成功了」）；
- 有报错：读报错原文 → 查下表 → 给下一条命令。不擅自改远端状态。

## 问题与解决方案
| 问题 | 典型报错 | 下一步 | 谁做 |
|---|---|---|---|
| 凭据失效 | `Authentication failed` / `could not read Username` | `gh auth login` 或重设 credential helper，再重试 push | 用户 |
| 网络/代理不通 | `Failed to connect to github.com` | 关代理重试；或设 `http.proxy` 指向本机端口 | 用户 |
| 仓库不存在/名冲突 | `Repository not found` | 换名新建，或复用已有仓库后 `git remote set-url` | 用户 |
| 远程已有提交 | `rejected ... fetch first` | `git pull --rebase origin main` 后重试（**不许 force push**） | 用户（AI 给命令） |
| 推错了东西 | 已上传 | 说清怎么在网页删除；AI 不擅自 `push --force` | 用户 |

## 禁止行为
- 禁止在用户未明确要求时执行 `git push` / 建仓库 / 改可见性；
- 禁止提交临时文件、日志、token、`.env`；
- 禁止 `git push --force`（用户要求也先说明风险）；
- 禁止把「我给过命令」说成「已同步成功」。

## 成功判定
- 本地：无未提交改动；`git log` 语义清晰、可单独回滚。
- 远端：**以用户执行后的回报为准**（AI 不代跑）；AI 交付的步骤里命令齐全、地址来自用户原文。
