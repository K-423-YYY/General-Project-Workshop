/**
 * on-stop.mjs —— 会话结束时的上下文治理（G9 的切换侧）
 * 第 3 批 · 上下文治理 · 交付物 A7
 *
 * 事件：Stop
 *
 * 三件事：
 *   1. 落盘 stdin 原始 JSON（★ 待实测项 #2 的取证点，保留在正式实现里，成本近零）
 *   2. 生成 / 更新 .harness/HANDOFF.md 与 JOURNAL.md（脚本产出，模型只读不写）
 *   3. 上下文水位 > 70% 时拒绝结束会话，要求先写 HANDOFF 再开新会话
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 防死循环：这是本批唯一的「高危点」，用了三层，缺一不可 ★★
 * ══════════════════════════════════════════════════════════════════════
 *
 *   第 1 层（方案指定）：`stop_hook_active` 为真 → 立即放行。
 *        含义：本次 Stop 是**我们自己上一次 block 顶出来的**，再拦就是死循环。
 *        字段名已在第 2 批实测确认（见 03-执行记录/进度.md 的待实测项 #2）。
 *
 *   第 2 层（会话内硬上限）：每个 session 最多 block 2 次。
 *        即使第 1 层的字段名将来被版本改掉（比如改成 stopHookActive），
 *        最坏也只是「多拦一次」，绝不会无限循环。
 *
 *   第 3 层（时间冷却）：同一个 session 在 COOLDOWN_MS 内已经 block 过 → 放行。
 *        防的是「模型连续快速重试 Stop」这种最紧凑的循环形态。
 *
 * 为什么值得用三层：死循环会把会话彻底锁死，而代价只是多几行代码。
 * 04 文档第 3 批验收第 5 项专门测这个。
 *
 * 铁律：异常一律 fail-open（exit 0 不输出），绝不因为 hook 崩了让用户无法结束会话。
 */

import {
  readEvent,
  projectRoot,
  bypassReason,
  loadState,
  saveState,
  sessionState,
  sessionCounters,
  readCtx,
  ctxIsFresh,
  harnessPaths,
  stateFileNamed,
  readTextFile,
  writeText,
  appendText,
  readJsonFile,
  writeJsonAtomic,
  clip,
  stamp,
  LIMITS,
} from "./lib/policy.mjs";
import { reportSignal, learnTurnsThreshold, looksLikePromptTooLong, findHarnessRoot } from "./lib/learn.mjs";
import {
  FILES as LOG_FILES,
  appendLog,
  appendSection,
  stampCompact,
} from "./lib/log-center.mjs";

const BLOCK_LIMIT_PER_SESSION = 2;     // 第 2 层
const COOLDOWN_MS = 3 * 60 * 1000;     // 第 3 层
const HANDOFF_WARN_PCT = 70;           // G9 阈值

// ───────────────────────────────────────────── 取证：stdin 原始 JSON

/**
 * ★ 待实测项 #2 的落盘点。
 * 保留在正式实现里（不是临时调试代码）：每次 Stop 追加一行原始 JSON，
 * 将来 Claude Code 升级改了字段名，这里能第一时间看出来。
 *
 * 第 2 段（日志中心）：写进**工作区根**的 `日志\01-会话\stop-stdin-<日期>.jsonl`。
 * 「不超过 8MB」这件事不用再自己算 —— 日志中心到 8MB 会改名轮转，历史不丢。
 */
function dumpStdin(root, raw) {
  try {
    appendLog("session", {
      file: LOG_FILES.stopStdin(),
      text: `${raw.replace(/\s+/g, " ").trim()}\n`,
    });
  } catch {
    /* 取证失败绝不影响主流程 */
  }
}

/**
 * 会话结束摘要 → **工作区根** `日志\01-会话\session-<日期>.md`（只追加，一次会话一段）。
 * 为什么和 HANDOFF 分开写：HANDOFF 是给**下一个会话**读的工作交接（会被重写），
 * 这里是给**人事后复盘**的时间线（永不改写）—— 两者用途不同，混在一起就两边都不好用。
 */
function logSessionEnd(root, sid, ev, s, ctx, blocked) {
  try {
    const c = sessionCounters(s);
    const lines = [
      `- 时间：${stamp()}`,
      `- 会话：\`${sid.slice(0, 8)}\`（项目 ${root}）`,
      `- 模型 / 窗口：${ctx?.model ?? "未知"} / ${ctx?.windowSize ?? "?"}，结束水位 ${ctx?.usedPct ?? "?"}%`,
      `- 文件编辑 ${c.editTotal} 次（${c.edits} 个文件）/ 整文件读取 ${c.reads} 个`,
      `- 全量 E2E 成功 ${c.e2eOk} 次（被配额拦 ${c.e2eBlocked} 次）/ 全量 CI 成功 ${c.ciOk} 次`,
      `- G9（水位超阈值拒绝结束）：${blocked ? "已拦一次，已要求先写 HANDOFF" : "未触发"}`,
      `- 交接文件：.harness\\HANDOFF.md（下一个会话由 inject-rules.mjs 注入前 20 行）`,
    ];
    appendSection("session", LOG_FILES.session(), `会话结束摘要 ${stampCompact()}`, lines.join("\n"));
  } catch {
    /* fail-open */
  }
}

// ───────────────────────────────────────────── 自主学习（第 3 段 · 锁定决策 6）

/**
 * ★ 第②③根线：会话正常收尾 / 出错中断 → 上报给模型画像（零成本、不发请求）。
 *
 * 第②根线 · prompt-too-long：**会话因超长报错中断** → 立即把窗口下调 25%。
 *   判据：载荷或最后一条助手消息里出现「prompt too long / context length exceeded」这类特征串。
 *   为什么宁可少判：「超长报错」是对当前模型最硬的负反馈，误判会让窗口被无谓压小（更保守、但更贵）。
 *   所以特征串写得很具体，只认真的报错原文。
 *
 * 第③根线 · session-ok：**会话正常收尾**，且本会话轮次 ≥ 阈值（默认 30）→ 谨慎上调 10%。
 *   轮次怎么来的：Claude Code 的 Stop 事件**每轮助手回复结束都会触发**（不是只在会话结束），
 *   所以本 hook 每来一次就把 `turns` +1 —— 这是零新增 hook、零成本的轮次计数。
 *   防「一路猛涨」：同一个会话**最多上报一次** session-ok（learn.mjs 的去重键里带会话 id），
 *   再加上 model-capability 的 learnCeiling（夹在保守上限之内）做第二道闸。
 *
 * 只在真的触发时才 spawn probe-model（典型一次会话 0–1 次），不拖慢每次 Stop。
 */
function learnFromStop(root, ev, s, ctx) {
  try {
    const sid = String(ev.session_id ?? ev.sessionId ?? "unknown");
    const model = ctx?.model || process.env.HARNESS_MODEL || "";
    const endpoint = process.env.ANTHROPIC_BASE_URL || "";
    const text = [ev.last_assistant_message, ctx?.lastError, ev.error].filter(Boolean).join("\n");

    // ② 出错中断（超长）—— 优先级最高：先压窗口，再看要不要上调
    if (looksLikePromptTooLong(text)) {
      const r = reportSignal({
        root, signal: "prompt-too-long", model, endpoint,
        onceKey: `ptl:${sid}`,
      });
      if (r.ok && !r.skipped) {
        process.stderr.write(`[harness] 自主学习：检测到会话超长中断 → 已下调窗口 25%（${r.action || "见 日志\\08-模型\\"}）\n`);
      }
      return;
    }

    // ③ 正常收尾：轮次够才上报
    const turns = Number(s?.turns ?? 0);
    const need = learnTurnsThreshold(findHarnessRoot(root)) || 30;
    if (turns >= need) {
      const r = reportSignal({
        root, signal: "session-ok", model, endpoint, turns,
        onceKey: `ok:${sid}`,
      });
      if (r.ok && !r.skipped && /\d/.test(r.action ?? "")) {
        process.stderr.write(`[harness] 自主学习：连续 ${turns} 轮无异常 → 窗口谨慎上调 10%（${r.action}）\n`);
      }
    }
  } catch {
    /* fail-open：学不到不该影响会话结束 */
  }
}

// ───────────────────────────────────────────── HANDOFF 生成

const MANUAL_MARKER = "<!-- harness:manual -->";

/**
 * ★ 必须**整行锚定**地找标记。
 *
 * 初版用的是 `prevText.indexOf(MANUAL_MARKER)` —— 而文件头部那句说明里也写了这个标记
 * （「把内容挪到 `<!-- harness:manual -->` 之后…」），于是 indexOf 命中的是**那一行**，
 * 把「标记之后的全部内容」= 整份生成内容当成了人工补充区，下一次重写又把它整段抄回去。
 * 结果是每结束一次会话文件就翻一倍（实测 397 行里 394 行是这么涨出来的）。
 * 真会话里被模型当场发现，这里改成 ^$ 整行匹配，并顺手加了体量上限兜底。
 */
const MANUAL_RE = /^<!--\s*harness:manual\s*-->\s*$/m;
/** 人工补充区的体量上限：只保留最近的内容，避免它自己变成新的上下文负担 */
const MANUAL_MAX_CHARS = 8000;

/** 从上一条助手消息里提炼「当前任务」——不猜，只做删减 */
function taskFromMessage(msg) {
  const s = String(msg || "").trim();
  if (!s) return null;
  // 去掉代码块（那多半是工具输出粘贴，不是任务陈述）
  const noCode = s.replace(/```[\s\S]*?```/g, "\n（此处省略一段代码块）\n");
  const lines = noCode
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*>|]{1,2}$/.test(l));
  const head = lines.slice(0, 12).join("\n");
  return clip(head || s, 900);
}

/** 保留上一次 HANDOFF 里的人工补充区（脚本不碰模型/用户手写的内容） */
function extractManual(prevText) {
  if (!prevText) return "";
  const m = MANUAL_RE.exec(prevText);
  if (!m) return "";
  let body = prevText.slice(m.index + m[0].length).trim();
  if (body.length > MANUAL_MAX_CHARS) {
    // 只留最近的：超出部分从头部砍掉，并明确标注，避免"内容莫名少了"
    body = `（人工补充区超过 ${MANUAL_MAX_CHARS} 字符，已只保留最近的部分）\n…\n` + body.slice(-MANUAL_MAX_CHARS);
  }
  // 人工区里若还残留标记行（例如用户把整段模板复制下来），清掉，
  // 保证整份文件里**有且只有一行**标记 —— 否则下一轮又会从第一个标记处截断。
  return body.replace(new RegExp(MANUAL_RE.source, "gm"), "").trim();
}

function buildHandoff(root, ev, s, ctx, prevText) {
  const c = sessionCounters(s);
  const sid = String(ev.session_id ?? ev.sessionId ?? "unknown");
  const model = ctx?.model ?? "未知";
  const win = ctx?.windowSize ?? "?";
  const used = ctx?.usedPct ?? "?";
  const task = taskFromMessage(ev.last_assistant_message);
  const manual = extractManual(prevText);

  return `# 交接（自动生成 · ${stamp()}）

> 本文件由 \`.claude/hooks/on-stop.mjs\` 在每次会话结束时自动重写。
> 删除本行或把内容挪到 \`${MANUAL_MARKER}\` 之后，即可让自己写的内容不被覆盖。

## 当前任务
${task ? task : "（本次会话没有可提取的助手消息——可能是空会话或异常退出）"}

## 已完成（本轮）
- 会话 \`${sid.slice(0, 8)}\` 于 ${stamp()} 结束
- 文件编辑 ${c.editTotal} 次（涉及 ${c.edits} 个文件）／整文件读取 ${c.reads} 个
- 全量 E2E：成功 ${c.e2eOk} 次，被配额拦下 ${c.e2eBlocked} 次；全量 CI：成功 ${c.ciOk} 次

## 下一步
- 接着「当前任务」往下做；若上面为空，请在**新会话**里先跑 \`node AI-Dev-Harness/自定义/scripts/env-doctor.mjs\` 重新对齐。
- 未通过验收的项优先于「顺手优化」。

## 关键决策 / 坑
- 硬规则由 \`inject-rules.mjs\` 在每次 SessionStart 注入，不依赖模型自己去读文件。
- 逃生阀：项目根建 \`.harness/bypass\` 文件，或会话带环境变量 \`HARNESS_BYPASS=1\`。
- 被拦截过的写法不要退回：改码用 Edit / Write，不要 sed -i、cat >、python 内联。

## 环境
- 模型 ${model}，压缩上限 ${win}，会话结束水位 ${used}%

---

${MANUAL_MARKER}
${manual ? `${manual}\n` : "（这一行以下的内容脚本不会覆盖，可放心手写。）\n"}`;
}

// ───────────────────────────────────────────── 主流程

async function main() {
  const ev = await readEvent();
  if (!ev) return;
  if (ev.hook_event_name !== "Stop") return;

  const root = projectRoot(ev);
  const { handoff, journal } = harnessPaths(root);

  // 原始 stdin 落盘（待实测项 #2）—— 必须在任何 early-return 之前
  const rawJson = JSON.stringify(ev);
  dumpStdin(root, rawJson);

  const sid = String(ev.session_id ?? ev.sessionId ?? "unknown");

  // ══ 第 1 层：方案指定的字段
  if (ev.stop_hook_active === true) return;

  // 逃生阀
  if (bypassReason(ev)) return;

  // ══ 无论拦不拦，都先把 HANDOFF 写好 —— 下一会话一定读得到
  const st = loadState(root);
  const s = sessionState(ev, st);
  const ctx = readCtx(root);

  // 轮次计数（第 3 段 · 自主学习）：Claude Code 的 Stop 每轮助手回复结束都会触发，
  // 所以这里 +1 就等于「本会话已经进行的轮数」，不需要新增 hook、不需要读 transcript。
  s.turns = Number(s.turns ?? 0) + 1;

  const prev = readTextFile(handoff);
  const nextHandoff = buildHandoff(root, ev, s, ctx, prev);
  writeText(handoff, nextHandoff);
  appendText(journal, `- ${stamp()} 会话 ${sid.slice(0, 8)} 结束（水位 ${ctx?.usedPct ?? "?"}%）\n`);
  saveState(root, st);

  // 自主学习（第②③根线）——与 HANDOFF/G9 无关，独立 fail-open
  learnFromStop(root, ev, s, ctx);

  // ══ G9 的决定先算出来，再统一落日志 —— 一次会话只写一段结束摘要
  const decision = decideStop(root, sid, ctx);
  logSessionEnd(root, sid, ev, s, ctx, !!decision);
  if (decision) process.stdout.write(JSON.stringify(decision));
}

/**
 * G9：水位超阈值就拒绝结束。
 * 返回 block 决定对象，或 null（不拦）。**只做判断与防抖记账**，不输出、不写日志。
 */
function decideStop(root, sid, ctx) {
  if (!ctxIsFresh(ctx)) return null;            // 水位数据太旧 → 不足以做重决定
  const usedPct = Number(ctx?.usedPct);
  if (!Number.isFinite(usedPct) || usedPct <= HANDOFF_WARN_PCT) return null;

  // ══ 第 2 层 + 第 3 层：本地防抖（不依赖 stop_hook_active 的字段名）
  const guardFile = stateFileNamed(root, "stop-guard.json");
  const guard = readJsonFile(guardFile) || {};
  const g = guard[sid] || { blocks: 0, lastAt: 0 };

  if (g.blocks >= BLOCK_LIMIT_PER_SESSION) return null;          // 第 2 层
  if (Date.now() - (g.lastAt || 0) < COOLDOWN_MS) return null;   // 第 3 层

  guard[sid] = { blocks: g.blocks + 1, lastAt: Date.now() };
  // 只保留最近 20 个会话
  const keys = Object.keys(guard);
  if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete guard[k];
  writeJsonAtomic(guardFile, guard);

  const reason = clip(
    `[harness] 先别结束：本会话上下文已用到 ${usedPct}%（阈值 ${HANDOFF_WARN_PCT}%）。\n` +
      `继续下去的代价是——压缩会开始丢细节，模型会开始忘记早期约束（上一次 3.49 亿 token 的事故就是这个形状）。\n` +
      `现在这样做（三步，都在 1 分钟内）：\n` +
      `  1. 我已经把 .harness/HANDOFF.md 更新好了，你读一遍确认「当前任务 / 下一步」写得对，不对就改。\n` +
      `  2. 把还没做完的事写进 HANDOFF 的「下一步」（或 JOURNAL.md 追加一行）。\n` +
      `  3. 然后结束本会话，**开一个新会话继续**——新会话会通过 SessionStart 自动拿到这份 HANDOFF 和硬规则。\n` +
      `如果你判断必须在本会话继续（例如正在等一个长任务的中间结果），就再结束一次，我不会重复拦。\n` +
      `（本会话最多拦 ${BLOCK_LIMIT_PER_SESSION} 次，且 ${COOLDOWN_MS / 60000} 分钟内只拦一次，不会把你锁住。）`,
    LIMITS.maxReasonChars,
  );

  return { decision: "block", reason };
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
