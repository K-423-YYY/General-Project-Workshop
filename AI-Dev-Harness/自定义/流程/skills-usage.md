# universal-skills 使用说明

本说明适用于 `universal-skills/` 内的通用项目开发 skills。这些 skills 严格基于《万能项目开发流程（完整标准模板）》生成。

## 一、整个使用流程及注意事项

### 1. 使用顺序

按以下顺序调用：

1. project-workflow：总控，决定整体流程。
2. plan-and-requirements：读取并检查计划书、需求、理念。
3. automation-setup：安装并配置自动化长任务脚本。
4. task-planning：按计划拆分任务。
5. skeleton-building：按计划搭建项目骨架。
6. local-verification：本地验证。
7. task-execution：执行主任务。
8. exception-handling：遇到异常时使用。
9. git-delivery：git 集成、推送、远程验证。
10. cleanup-and-final：清理、最终说明、用户确认。

### 2. 注意事项

- 优先执行模板中的第一方案，不自由发挥。
- 严格按项目计划书、需求、理念执行。
- 不擅自修改目标、范围、交付物、验收标准。
- 每完成一步做最小验证。
- 发现异常先提示用户，由用户决定方向。
- 办不到或重复几轮仍办不到时，移交用户手动执行，并说明怎么执行。
- 只有“需要用户手动/决策、任务不可行、任务完成”三种情况才停止。
- 涉及账号、权限、敏感信息、公开发布时，必须用户确认。
- 不要在未确认前删除计划内文件。
- 不要提交 token、密码、日志、临时文件。

## 二、可修改、可操作的地方

### 1. 可修改的内容

- 每个 `SKILL.md` 中的执行步骤。
- 每个 `SKILL.md` 中的问题与解决方案表。
- `templates/prompt.md`：自动化脚本任务提示模板。
- `templates/plan-checklist.md`：计划检查清单。
- `templates/gitignore.template`：通用 .gitignore 模板。
- `README.md`：skills 总说明。

### 2. 可操作的对象

- 新增 skill 目录：目录名使用英文，内含 `SKILL.md`。
- 删除不再使用的 skill。
- 调整 skills 的调用顺序。
- 修改每个 skill 中的“必须遵守规则”“禁止行为”“成功判定”。

### 3. 不可随意修改的内容

- 模板文档《万能项目开发流程（完整标准模板）》本身。
- 项目计划书、需求文档、理念文档。
- 如果必须修改，需先向用户说明并等待用户决定。

## 三、如何进行修改操作

### 1. 修改单个 SKILL.md

用任意编辑器打开对应目录下的 `SKILL.md`，修改对应章节即可。

例如修改 `automation-setup/SKILL.md` 中的安装命令：

```markdown
## 执行步骤
1. 全局安装：
   ```powershell
   npm install -g 新包名
   ```
```

保存后重新检查：
- “必须遵守规则”是否仍成立；
- “禁止行为”是否仍成立；
- “成功判定”是否仍可达成。

### 2. 新增一个 skill

1. 在 `universal-skills/` 下创建英文目录，例如 `custom-step/`。
2. 在目录内创建 `SKILL.md`。
3. 按照统一结构填写：
   - name / description
   - 适用场景
   - 必须遵守规则
   - 执行步骤
   - 验证方式
   - 问题与解决方案
   - 禁止行为
   - 成功判定
4. 在 `README.md` 和 `project-workflow/SKILL.md` 中登记新的调用位置。

### 3. 修改模板文件

打开 `templates/` 下的文件，直接编辑后保存。

修改 `prompt.md` 示例：

```markdown
## 目标
- 新目标 1
- 新目标 2
```

修改 `gitignore.template` 示例：

```text
node_modules/
dist/
*.log
```

### 4. 调整调用顺序

打开 `README.md` 和 `project-workflow/SKILL.md`，调整步骤编号和名称，保持两处一致。

### 5. 修改后验证

每次修改后执行以下检查：

```powershell
# 查看文件是否齐全
Get-ChildItem -Recurse .\universal-skills

# 检查关键规则是否保留
Select-String -Path .\universal-skills\*\SKILL.md -Pattern "必须遵守规则","禁止行为","成功判定"
```

如果某个 skill 缺少“禁止行为”或“成功判定”，需要补全后再使用。
