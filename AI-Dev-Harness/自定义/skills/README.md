# skills（即插即用技能库）

## 怎么加技能
把**一个文件夹**（里面必须有一个 `SKILL.md`）直接复制到本目录即可，**无需登记**。
例如：
```
自定义\skills\
└── my-new-skill\
    └── SKILL.md
```

## 规范
- 文件夹名建议英文（如 `my-new-skill`），`SKILL.md` 里写清：
  - name / description
  - 适用场景
  - 必须遵守规则
  - 执行步骤
  - 验证方式
  - 禁止行为
  - 成功判定
  - AI 开工时**只读各 `SKILL.md` 的 `name` + `description`**（或直接跑 `自定义\scripts\list-skills.mjs` 看索引），
    选中后再读**那一个**技能正文 —— **不要把所有 `SKILL.md` 全读进来**（23 个正文合计约 246 KB）。

## 冲突检测
新增/改动技能时，AI 会运行 `skill-audit` 技能检测冲突（同名、职责重叠、规则冲突、调用顺序冲突）。发现冲突会通过中文对话问你怎么处理（删除 / 优化 / 保留两者），决定后记入 `冲突记录.md`。

## 「已有方案文档」时用哪几个技能
用户手上已经有方案 / 计划文档时，按这个顺序调用（别重复造方案）：
`plan-and-requirements`（只读核对：冲突 / 缺失 / 模糊 / 不可行）→ `task-planning`（按已有计划拆任务）→
`skeleton-building`（只建计划内文件）→ `task-execution`（严格按计划执行）→ `local-verification` → `git-delivery` → `cleanup-and-final`。

> 本目录属于「可改区」；但注意：**技能文件可改，机制层不可改**（`.claude\`、`自定义\bin\`、`自定义\scripts\`、
> `规则源.md`、两个能力表、`引擎适配\`、`prompt-模板\`、`日志\`、`内置\`；铁律见 `AGENTS.md` 第五节）。

## 现有技能（索引）

> ⚠️ **扫技能只读摘要，不要把正文全读进来**：23 个 `SKILL.md` 合计约 25 万字符（6~8 万 token），
> 而一次项目最多用到 3~5 个。开局只读下面这张索引表（约 2 KB），选中后再读**那一个**技能正文；
> 超大技能（如 `hatch-pet`）按需读它的 `references\`，不要整篇吞。
> 打开索引的正式命令：`node AI-Dev-Harness\自定义\scripts\list-skills.mjs`

<!-- skills-index:begin -->
> 由 `自定义\scripts\list-skills.mjs` 生成，**不要手改**；改完技能跑 `--update`，`--check` 验证是否漂移。

| 技能 | 干什么（description 摘要） | 体积 |
|---|---|---|
| `automation-setup` | 安装并配置自动化长任务脚本（codex-autoresearch），确保长任务可循环执行、… | 2.0 KB |
| `backend-api` | 后端 API 设计规范，覆盖 RESTful 路由、状态码、参数校验、错误处理、鉴权、文档… | 2.8 KB |
| `browser` | Control the in-app Browser for opening, navig… | 12.8 KB |
| `cleanup-and-final` | 交付前清理：先出「将删除/将保留」清单等用户确认，再执行清理，最后跑纯净度自检并输出最终说… | 3.3 KB |
| `computer-use` | Control Windows apps from ChatGPT | 1.4 KB |
| `documents` | Create, edit, redline, and comment on `.docx`… | 41.2 KB |
| `exception-handling` | 处理项目执行中的异常，执行停止原则和手动移交原则。 | 1.4 KB |
| `frontend-design` | Guidance for distinctive, intentional visual … | 8.1 KB |
| `git-delivery` | 交付阶段的 git 与远程同步：本地初始化/提交/验证由 AI 做，GitHub 只告知步… | 3.6 KB |
| `hatch-pet` | Create, repair, validate, visually QA, and pa… | 83.5 KB |
| `local-verification` | 执行本地验证，按 L1/L2/L3 分层跑测试（改动→定向单测；任务边界→全量单测+类型检… | 4.2 KB |
| `pdf` | Read, create, inspect, render, and verify PDF… | 6.9 KB |
| `plan-and-requirements` | 读取并检查项目计划书、需求、理念，只读检查项目现状，发现异常时提示用户。 | 1.3 KB |
| `presentations` | Read, create or edit PowerPoint or Google Sli… | 16.9 KB |
| `project-workflow` | 万能项目开发流程总控 skill，负责按模板编排完整项目流程并强制遵守执行标准。 | 3.0 KB |
| `skeleton-building` | 按计划搭建项目骨架，只创建计划内目录和文件。 | 1.1 KB |
| `skill-audit` | 技能体检与冲突检测：扫描技能库，检测同名 / 职责重叠 / 规则冲突 / 调用顺序冲突，并… | 1.5 KB |
| `spec` | SDD 规范驱动开发（SpecKite 风格）：把需求变成精简规范、再按验收标准逐项核对；… | 3.3 KB |
| `spreadsheets` | Create, edit, analyze, and verify standalone … | 17.5 KB |
| `task-execution` | 严格按项目计划书执行主任务，遵守改码方式与测试分层硬规则，长任务中断时恢复，发现偏离计划时… | 4.1 KB |
| `task-planning` | 按项目计划书拆分任务，定义优先级和验收标准，发现偏差时提示用户。 | 1.4 KB |
| `template-creator` | Create or update a reusable personal Codex ar… | 18.6 KB |
| `webapp-testing` | Toolkit for interacting with and testing loca… | 3.8 KB |

（共 23 个技能；正文合计 243.7 KB —— **开局只读这张表即可**，选中后再读那一个技能）
<!-- skills-index:end -->
