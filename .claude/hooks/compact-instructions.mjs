/**
 * compact-instructions.mjs —— 压缩时保住关键信息（G9 的压缩侧）
 * 第 3 批 · 上下文治理 · 交付物 A6
 *
 * 事件：PreCompact
 *
 * ★ 铁律 8：**绝对不要用 exit 2 阻止压缩** —— 那会报 "Conversation too long" 并直接中断会话。
 *   正确做法是 exit 0 + stdout：stdout 会被当作**自定义压缩指令**追加给压缩器。
 *
 * 为什么需要它：
 *   压缩摘要是自动生成的，它不知道什么信息是「丢了就致命」的 ——
 *   比如 HANDOFF 里的当前任务、三条禁止事项、当前压缩上限。
 *   本脚本把这份「必须原样保留」的清单显式喂给压缩器。
 *
 * fail-open：任何异常都 exit 0 且不输出，等于不干预压缩（回落默认行为）。
 */

import {
  readEvent,
  projectRoot,
  readCtx,
  readTextFile,
  harnessPaths,
  clip,
} from "./lib/policy.mjs";

const MAX_KEEP_CHARS = 4000;

async function main() {
  const ev = await readEvent();

  const root = projectRoot(ev);
  const { handoff } = harnessPaths(root);

  // HANDOFF 全文优先保留，但别把压缩指令本身撑爆
  const handoffText = readTextFile(handoff, 64 * 1024);
  const handoffBlock = handoffText
    ? clip(handoffText.trim(), MAX_KEEP_CHARS)
    : "（本会话还没有生成 .harness/HANDOFF.md）";

  const ctx = readCtx(root);
  const model = ctx?.model || process.env.HARNESS_MODEL || "未知（见 .claude/state/ctx.json）";
  const windowSize = ctx?.windowSize ?? "?";
  const usedPct = ctx?.usedPct ?? "?";

  const trigger = ev?.trigger ? String(ev.trigger) : "auto";
  const userInstr =
    typeof ev?.custom_instructions === "string" && ev.custom_instructions.trim()
      ? `\n本次压缩由用户附加的要求（优先级最高，冲突时以它为准）：\n${clip(ev.custom_instructions.trim(), 1000)}\n`
      : "";

  const text = `[harness] 压缩时必须原样保留以下内容，禁止概括、禁止省略、禁止改写：

1. 当前任务编号、任务原文、以及**尚未通过验收的项**（这部分丢了下一次会话会重复劳动）。
2. 三条禁止事项（全文照抄）：
   - 不得用 sed -i / perl -i / cat > / python 内联改码，改代码只用 Edit / Write
   - 不得直接跑全量 playwright，改动后先跑定向单测
   - 不得改动 Safety Kernel / 内置区里未获授权的文件
3. 已经踩过的坑与关键决策（结论要留，推导过程可丢）。
4. 环境事实：当前模型 ${model}，压缩上限 ${windowSize}，当前水位 ${usedPct}%。
5. 被拦截过、且已改用替代方案的记录（避免压缩后又退回旧写法）。

可以丢弃：已完成任务的中间调试日志、成功命令的刷屏输出、重复读同一文件的全文、探索类子代理的原始检索过程。

下面是 .harness/HANDOFF.md 的当前全文，请整段保留（不要压缩成一句话）：
---------- HANDOFF.md 开始 ----------
${handoffBlock}
---------- HANDOFF.md 结束 ----------
${userInstr}
（压缩触发方式：${trigger}）`;

  process.stdout.write(text);
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
