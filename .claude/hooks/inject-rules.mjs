/**
 * inject-rules.mjs —— 会话开始时把硬规则灌进上下文
 * 第 3 批 · 上下文治理 · 交付物 A8
 *
 * 事件：SessionStart
 *
 * 为什么必须「注入」而不是「让模型去读文件」：
 *   实测证据 —— `对话协议.md` 在三次会话的非模型输出记录里命中 **0 次**。
 *   模板只有 8 行、只写了「请读 ..\AI-Dev-Harness\自定义\对话协议.md」，模型没读，就再也没读过。
 *   结论：凡是「靠模型自觉去读」的规则，等于没写。这里直接在会话第一帧把它塞进去。
 *
 * 输出方式：**纯 stdout 文本**。
 *   SessionStart / PreCompact 这类「不产出决定」的事件，Claude Code 把 stdout 当作要追加进上下文的文本；
 *   只有需要做决定时（如 Stop 的 block）才用 JSON。这与 03 文档 § 6 里 PreCompact 的写法一致。
 *
 * 为什么 compact 来源要精简：压缩刚结束时上下文正紧张，再灌 30 行会把刚腾出来的空间又吃掉。
 *   压缩时 compact-instructions.mjs 已经要求「原样保留 HANDOFF 全文」，所以这里不必重复。
 */

import {
  readEvent,
  projectRoot,
  harnessPaths,
  readTextFile,
  readCtx,
  readJsonFile,
  clip,
} from "./lib/policy.mjs";
import { FILES as LOG_FILES, appendLog, stampCompact } from "./lib/log-center.mjs";

/**
 * 注入快照落到**工作区根**的 日志\01-会话\injection-<日期>.md（第 2 段从项目内 .harness\logs\ 迁出）。
 * 为什么必须留：模型行为出问题时，第一个要问的是"到底给它注入了什么" —— 没有这份快照就只能猜。
 * ★ 只追加不改写；写失败由日志中心内部 fail-open（只出声），注入本身不受影响。
 */
function snapshot(root, source, body) {
  try {
    const text =
      `\n\n## ${stampCompact()} 注入快照（source=${source}）\n\n` +
      `项目：\`${root}\`\n\n` +
      "```text\n" +
      String(body ?? "").replace(/\s*$/, "") +
      "\n```\n";
    appendLog("session", { file: LOG_FILES.injection(), text });
  } catch {
    /* 留档失败不影响注入 */
  }
}

const HANDOFF_LINES = 20;   // 方案指定：只注入 HANDOFF 前 20 行
const MAX_CHARS = 8000;     // additionalContext 同量级；纯 stdout 也保持克制

const RULES = `[harness] 本次会话的硬规则（由 .claude/hooks/inject-rules.mjs 在 SessionStart 注入，不是建议，是机制）：

0. 开工先跑体检：\`node AI-Dev-Harness/自定义/scripts/env-doctor.mjs\`（在项目目录内用 \`node ../AI-Dev-Harness/自定义/scripts/env-doctor.mjs\`）。
   它给出模型窗口、hooks 状态、上次交接与启动词。不要跳过，也不要等用户提醒；不要自动加 --fix。
1. 改代码只用 Edit / Write。禁止 sed -i、perl -i、cat > 源文件、python 内联改码。
   —— 这不是偏好问题：这些写法在 Windows 上会静默失配（退出码 0 但文件没变），
      本项目的 hook 会直接拦下，拦下了就照它给的替代方案做，不要换种写法绕过。
2. 测试分层：改动 → 定向单测（npx vitest run <对应测试文件>，秒级）；
   任务边界 → 全量单测 + 类型检查；阶段收尾 → 全量 E2E（配额 2 次/会话，失败不计数）。
   禁止「改一行 → 跑 playwright」。
3. 失败先看 stderr / 日志，再改。禁止「猜 → 改 → 重跑」。
4. 长输出命令重定向到文件，只读回摘要。
5. 改前先读完整文件；同一文件不要反复改（第 8 次起会收到警告）。
6. 探索类任务（"找找哪里用到了 X"）交给 Explore 子代理，别把整库读进主上下文。
7. 上下文用到 70% 就该结束会话并写 HANDOFF —— 不要硬撑到压缩开始丢细节。
8. 需要独立验收时跑 .claude/hooks/verify-gate.mjs，引用脚本的原始输出，不要自述"已全部通过"。`;

async function main() {
  const ev = await readEvent();
  const root = projectRoot(ev);
  const source = String(ev?.source ?? "startup");

  // 压缩刚结束：只补规则，不重复灌 HANDOFF（压缩指令已经要求保留它了）
  if (source === "compact") {
    const compactBody = `${RULES}\n\n（本会话由压缩恢复，HANDOFF 已在压缩摘要里保留，不再重复注入。）\n`;
    process.stdout.write(compactBody);
    snapshot(root, source, compactBody);
    return;
  }

  const { handoff, journal } = harnessPaths(root);
  const handoffText = readTextFile(handoff);
  const handoffHead = handoffText
    ? handoffText.split(/\r?\n/).slice(0, HANDOFF_LINES).join("\n").trim()
    : null;

  const ctx = readCtx(root);
  const envLine =
    ctx && ctx.model
      ? `当前模型 ${ctx.model}，压缩上限 ${ctx.windowSize ?? "?"}（阈值会比它再低约 3.3 万 token）。`
      : "（还没有 .claude/state/ctx.json，说明 statusLine 尚未渲染；压缩上限见 .claude/settings.json。）";

  const parts = [RULES, "", envLine];

  if (handoffHead) {
    parts.push(
      "",
      "上次会话的交接摘要（.harness/HANDOFF.md 前 20 行，全文可直接 Read）：",
      "----------",
      handoffHead,
      "----------",
      "接续上一会话时：先确认「下一步」，再动手。不要凭记忆重建上下文。",
    );
  } else {
    parts.push(
      "",
      "没有找到 .harness/HANDOFF.md —— 这可能是全新项目。",
      "开始前先跑：node AI-Dev-Harness/自定义/scripts/env-doctor.mjs（见上面第 0 条）",
    );
  }

  // JOURNAL 只给最后几行，够判断"上一步做到哪"即可
  const jt = readTextFile(journal);
  if (jt) {
    const tail = jt.split(/\r?\n/).filter(Boolean).slice(-3);
    if (tail.length) parts.push("", "最近几笔会话记录（.harness/JOURNAL.md 末尾）：", ...tail);
  }

  const body = clip(parts.join("\n"), MAX_CHARS);
  process.stdout.write(body);

  // 同时留一份可检索副本，便于排查「到底注入了什么」
  snapshot(root, source, body);
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
