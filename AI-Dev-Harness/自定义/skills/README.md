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
- AI 开工前会自动扫描本目录下所有 `SKILL.md` 并按需调用。

## 冲突检测
新增/改动技能时，AI 会运行 `skill-audit` 技能检测冲突（同名、职责重叠、规则冲突、调用顺序冲突）。发现冲突会通过中文对话问你怎么处理（删除 / 优化 / 保留两者），决定后记入 `冲突记录.md`。

## 现有技能
- 通用流程：project-workflow、task-planning、task-execution、skeleton-building、local-verification、exception-handling、git-delivery、cleanup-and-final、plan-and-requirements、automation-setup
- 开发技能：frontend-design、backend-api、webapp-testing、spec
- 其他：hatch-pet、skill-audit、documents、pdf、presentations、spreadsheets、browser、computer-use、template-creator
