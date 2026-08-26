# Skill: SDD 验收标准校验 (SpecKite Style)

> 来源：方案 A 的 speckite（A2 核心代码 §3）落地。由 scripts/spec-check.* 调用。

当执行 spec-check 时：

1. 逐项读取 docs/plan.md 的验收标准与当前实现状态。
2. 判定每项：**通过 / 未通过 / 无法验证**，并给出原因。
3. 将核对报告写入 docs/CHECKPOINTS.md（追加一条记录）。
4. 存在未通过项时，最后一行输出 `SPEC_FAIL` 并说明原因，触发下一轮修复。
5. 全部通过时输出 `SPEC_PASS`。
