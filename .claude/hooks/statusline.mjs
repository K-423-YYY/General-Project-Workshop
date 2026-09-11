/**
 * statusline.mjs —— 上下文水位可见化（G9 的数据源 · L6 度量）
 * 第 3 批 · 上下文治理 · 交付物 A9
 *
 * 配置位置：settings.json 的 `statusLine` 键（**不是** hooks 键）。
 *
 * ★ 存在的唯一理由：
 *   hook 的 stdin 里**没有任何 token / 上下文数据**；
 *   statusLine 的 stdin 里**有算好的** `context_window.used_percentage`。
 *   所以让 statusLine 把数据写进 .claude/state/ctx.json，别的 hook（on-stop / compact-instructions）
 *   读那个文件 —— 这是让 hooks 感知水位的**唯一**途径。
 *
 * 输出给终端的是**一行**文本，形如：
 *   上下文 42% ▓▓▓▓░░░░░░ │ 5h 18% │ 缓存 91% │ deepseek-v4-flash (win 98K) │ E2E 1/2
 *
 * 三条纪律：
 *   1. 绝不抛异常 —— statusline 崩了会污染整个终端界面，必须永远输出点什么。
 *   2. ctx.json 内容没变就不重写（statusLine 每次渲染都跑）。
 *   3. 字符集可降级：`HARNESS_STATUS_ASCII=1` 时只用 ASCII（老 cmd.exe + GBK 码页兜底）。
 */

import {
  projectRoot,
  loadState,
  sessionState,
  readJsonFile,
  writeJsonAtomic,
  clip,
  ctxFile,
} from "./lib/policy.mjs";
import { FILES as LOG_FILES, appendJsonl } from "./lib/log-center.mjs";
import { reportContextSize } from "./lib/learn.mjs";
import path from "node:path";

/**
 * 水位轨迹写到**工作区根**的 日志\01-会话\context-<日期>.jsonl（第 2 段新增）。
 * 为什么值得留：事后问"这次为什么突然变贵/怎么就开始丢细节了"，看这条时间线就能回答；
 * 而 ctx.json 只有"最新一帧"，会话结束就被下一次覆盖。
 * 频次控制：只在**有意义的字段变化**时写，或距上次记录超过 5 分钟 —— 状态栏每次渲染都跑，不能无限写。
 */
const CTX_TRACE_MIN_GAP_MS = 5 * 60 * 1000;

const ASCII = process.env.HARNESS_STATUS_ASCII === "1";
const FULL = ASCII ? "#" : "█";
const EMPTY = ASCII ? "-" : "░";
const BAR = ASCII ? "|" : "│";

/** 42 -> ▓▓▓▓░░░░░░（10 格） */
function bar(pct, width = 10) {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return FULL.repeat(n) + EMPTY.repeat(width - n);
}

function pctText(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)}%` : "-";
}

/**
 * prompt_cache.hit_ratio 是 **0–1 的比例**，不是百分数。
 * （直接按百分数渲染会把 0.91 显示成「1%」——这正是本批自检台抓到的那个 bug。）
 * 这里按值域消歧：≤ 1 视为比例，> 1 视为已经是百分数，两种都容错。
 */
function ratioText(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function humanWindow(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let ev = null;
  try {
    ev = JSON.parse(raw);
  } catch {
    ev = null;
  }

  const cw = ev?.context_window ?? {};
  const rl = ev?.rate_limits ?? {};
  const pc = ev?.prompt_cache ?? {};

  const usedPct = num(cw.used_percentage);
  const remainPct = num(cw.remaining_percentage);
  const windowSize = num(cw.context_window_size);
  const fiveHour = num(rl.five_hour?.used_percentage);
  const sevenDay = num(rl.seven_day?.used_percentage);
  const cacheHit = num(pc.hit_ratio);
  const model = ev?.model?.display_name || ev?.model?.id || "";

  const root = projectRoot(ev || {});

  // ── 写 ctx.json（水位真相，供其它 hook 读）
  if (root) {
    const state = {
      usedPct,
      remainPct,
      windowSize,
      totalInputTokens: num(cw.total_input_tokens),
      totalOutputTokens: num(cw.total_output_tokens),
      // 压缩阈值 = 窗口 − 33000（03 文档 § 12 的公式），用于状态栏提示还剩多少
      compactThreshold:
        typeof windowSize === "number" ? Math.max(0, windowSize - 33000) : null,
      rate5h: fiveHour,
      rate7d: sevenDay,
      cacheHit,
      model: model || null,
      sessionId: ev?.session_id ?? null,
      cwd: ev?.workspace?.current_dir || ev?.cwd || root,
      ts: Date.now(),
    };
    const file = ctxFile(root);   // 第 3 段：HARNESS_STATE_DIR 会重定向它（默认行为不变）
    const prev = readJsonFile(file);
    // 只在「有意义的字段变了」时重写，避免每次渲染都动磁盘
    const same =
      prev &&
      prev.usedPct === state.usedPct &&
      prev.windowSize === state.windowSize &&
      prev.model === state.model &&
      prev.cacheHit === state.cacheHit &&
      prev.sessionId === state.sessionId &&
      Date.now() - (prev.ts || 0) < 60 * 1000;
    if (!same) writeJsonAtomic(file, state);

    // ── 水位轨迹（日志中心 · 01-会话）：有意义的字段变了，或距上一条 > 5 分钟才写
    const changed =
      !prev ||
      prev.usedPct !== state.usedPct ||
      prev.windowSize !== state.windowSize ||
      prev.model !== state.model;
    if (!same && (changed || Date.now() - (prev?.ts || 0) > CTX_TRACE_MIN_GAP_MS)) {
      appendJsonl("session", LOG_FILES.context(), {
        ts: new Date().toISOString(),
        epochMs: state.ts,
        project: root,
        session: state.sessionId,
        model: state.model,
        usedPct: state.usedPct,
        remainPct: state.remainPct,
        windowSize: state.windowSize,
        compactThreshold: state.compactThreshold,
        cacheHit: state.cacheHit,
        rate5h: state.rate5h,
        rate7d: state.rate7d,
      });
    }

    // ── 自主学习 · 第①根线（第 3 段 · 锁定决策 6）：把引擎报出的**真实窗口**记进模型画像 ──
    // 为什么必须在这里做：hook 的 stdin 里没有窗口数据，只有 statusLine 有
    // context_window.context_window_size —— 而窗口正是「压缩阈值该设多大」的根。
    // 频次控制：同一模型同一窗口只上报一次（learn.mjs 内部去重）；失败只出声，绝不影响状态栏。
    if (changed && typeof windowSize === "number" && windowSize > 0) {
      reportContextSize({
        root,
        model,
        endpoint: process.env.ANTHROPIC_BASE_URL || "",
        windowSize,
        sessionId: state.sessionId,
      });
    }
  }

  // ── 本会话的 E2E 配额（从 quota.json 读，与 guard-bash 的记账同源）
  let quotaText = "";
  try {
    if (root) {
      const st = loadState(root);
      const s = sessionState(ev || {}, st);
      const used = s?.e2e?.ok ?? 0;
      quotaText = ` ${BAR} E2E ${used}/2`;
    }
  } catch {
    /* 配额读不到就不显示 */
  }

  const text = [
    `上下文 ${pctText(usedPct)} ${bar(usedPct ?? 0)}`,
    `5h ${pctText(fiveHour)}`,
    `缓存 ${ratioText(cacheHit)}`,
    model ? `${model}${windowSize ? ` (win ${humanWindow(windowSize)})` : ""}` : null,
  ]
    .filter(Boolean)
    .join(` ${BAR} `);

  process.stdout.write(clip(text + quotaText, 400));
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    // 绝不能因为异常让状态栏变空白
    process.stdout.write("harness: 状态栏脚本异常（见 .claude/hooks/statusline.mjs）");
    process.exit(0);
  });
