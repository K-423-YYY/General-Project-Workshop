/**
 * learn.mjs —— 自主学习三根线的「上报端」（第 3 段 · 锁定决策 6）
 * ============================================================
 * 三根线（全部零额度：不发任何模型请求）：
 *   ① statusLine 报出 `context_window_size`  → 记录模型**真实窗口**（context-size）
 *   ② 会话出错中断（API 报超长之类的特征） → **下调 25%**（prompt-too-long）
 *   ③ 会话正常收尾（且轮次够）             → **上调 10%**（session-ok，带上限保护）
 *
 * 为什么上报端要单独一个文件：三根线分散在 statusline.mjs / on-stop.mjs 两处，
 * 但「怎么找到 harness、怎么调 probe-model、怎么防重复上报、失败怎么出声」只有一份实现。
 *
 * ★ 三条硬约束（与 harness 其它部分一致）：
 *   1. **绝不写项目目录**：画像与状态都写 <harness>\state\（或 HARNESS_STATE_DIR）。
 *      项目是要交付的，不能被 harness 的运行痕迹污染。
 *   2. **fail-open 但必须出声**：报不上去只往 stderr 写一行，绝不改变 hook 的决定、
 *      绝不把会话卡住（画像学不到只是不够准，不是事故）。
 *   3. **不阻塞**：只有真的该上报时才 spawn（典型一次会话 1–2 次），不每次渲染都起进程。
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { harnessStateDirFor } from "./policy.mjs";

/**
 * 找 harness 根目录。顺序：
 *   ① 环境变量 HARNESS_ROOT（run.bat / hooks 环境里最权威）
 *   ② 从 root 向上逐级找含 `自定义\scripts\probe-model.mjs` 的 AI-Dev-Harness
 *   ③ root 直接就是工作区根（root\AI-Dev-Harness\...）
 * 找不到返回 null —— 调用方必须优雅跳过（项目被复制到工作区之外是正常场景）。
 */
export function findHarnessRoot(root) {
  const probeRel = path.join("自定义", "scripts", "probe-model.mjs");
  const ok = (dir) => {
    try { return fs.existsSync(path.join(dir, probeRel)); } catch { return false; }
  };
  const env = String(process.env.HARNESS_ROOT || "").trim();
  if (env) {
    const abs = path.resolve(env);
    if (ok(abs)) return abs;
    if (ok(path.join(abs, "AI-Dev-Harness"))) return path.join(abs, "AI-Dev-Harness");
  }
  let cur = null;
  try { cur = path.resolve(String(root ?? process.cwd())); } catch { cur = null; }
  while (cur) {
    const cand = path.join(cur, "AI-Dev-Harness");
    if (ok(cand)) return cand;
    if (ok(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** 「连续 N 轮」的 N —— 从模型能力表读（表不在就用 30，与 policy 的默认值一致）。 */
export function learnTurnsThreshold(harnessRoot) {
  const fallback = 30;
  if (!harnessRoot) return fallback;
  try {
    const t = JSON.parse(
      fs.readFileSync(path.join(harnessRoot, "自定义", "模型能力表.json"), "utf8").replace(/^\uFEFF/, ""),
    );
    const n = Number(t?.passiveLearning?.sessionOkTurns);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 上报去重：同一个 key 只报一次。
 * ★ 落点是 **harness 的 state 目录**（HARNESS_STATE_DIR 可重定向），不是项目目录 ——
 *   自主学习的全部痕迹都属于 harness，交付出去的项目里不能有它。
 */
function alreadyReported(root, key) {
  try {
    const f = path.join(harnessStateDirFor(root), "learn-report.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
    return j && j.keys && j.keys[key] === true;
  } catch {
    return false;
  }
}

function markReported(root, key) {
  try {
    const dir = harnessStateDirFor(root);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "learn-report.json");
    let j = {};
    try { j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")) ?? {}; } catch { j = {}; }
    j.keys = j.keys && typeof j.keys === "object" ? j.keys : {};
    j.keys[key] = true;
    // 只留最近 50 个 key，别让它自己长成负担
    const ks = Object.keys(j.keys);
    if (ks.length > 50) for (const k of ks.slice(0, ks.length - 50)) delete j.keys[k];
    j.updatedAt = new Date().toISOString();
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", "utf8");
  } catch {
    /* 记不上就下次重报，不是错误 */
  }
}

/**
 * 上报一个学习信号。
 *
 * @param {object} o
 * @param {string} o.root       项目根（hook 的 cwd）
 * @param {string} o.signal     context-size | prompt-too-long | session-ok
 * @param {string} [o.model]    模型名（画像按它归档）
 * @param {string} [o.endpoint] 端点（画像按它归档）
 * @param {number} [o.turns]    session-ok 用的轮次
 * @param {number} [o.window]   context-size 用的窗口大小
 * @param {string} [o.onceKey]  去重键（同一会话同一信号只报一次）
 * @returns {{ok:boolean, skipped?:string, action?:string, error?:string}}
 */
export function reportSignal(o = {}) {
  const root = o.root ?? process.cwd();
  const onceKey = o.onceKey ? String(o.onceKey) : null;
  if (onceKey && alreadyReported(root, onceKey)) return { ok: true, skipped: "已上报过（去重）" };

  const harnessRoot = findHarnessRoot(root);
  if (!harnessRoot) return { ok: false, skipped: "找不到 AI-Dev-Harness（项目可能已被复制到工作区之外）" };

  const cli = path.join(harnessRoot, "自定义", "scripts", "probe-model.mjs");
  const args = [cli, "--record", String(o.signal), "--harness-root", harnessRoot];
  if (o.model) args.push("--model", String(o.model));
  if (o.endpoint) args.push("--endpoint", String(o.endpoint));
  if (Number.isFinite(Number(o.turns))) args.push("--turns", String(Number(o.turns)));
  if (Number.isFinite(Number(o.window)) && Number(o.window) > 0) args.push("--window", String(Number(o.window)));

  let r;
  try {
    r = spawnSync(process.execPath, args, {
      cwd: harnessRoot,
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    process.stderr.write(`[harness] ⚠️ 自主学习：上报 ${o.signal} 失败（不影响会话）：${err?.message ?? err}\n`);
    return { ok: false, error: String(err?.message ?? err) };
  }
  if (r.error || r.status !== 0) {
    const why = r.error ? `${r.error.code || r.error.name}: ${r.error.message}` : `exit=${r.status}`;
    // fail-loud：学不到就明确说出来（这是「出声」，不是「卡住」）
    process.stderr.write(`[harness] ⚠️ 自主学习：上报 ${o.signal} 失败（不影响会话）：${why}\n`);
    return { ok: false, error: why };
  }

  if (onceKey) markReported(root, onceKey);
  const action = /动作：(.+)/.exec(r.stdout ?? "")?.[1] ?? "";
  return { ok: true, action, stdout: r.stdout ?? "" };
}

/** statusLine 用的上下文窗口上报：窗口变了才报（同一模型同一窗口只报一次）。 */
export function reportContextSize({ root, model, endpoint, windowSize, sessionId }) {
  const w = Number(windowSize);
  if (!Number.isFinite(w) || w <= 0) return { ok: false, skipped: "引擎没给 context_window_size" };
  const key = `context-size:${model || "unknown"}:${w}`;
  return reportSignal({ root, signal: "context-size", model, endpoint, window: w, onceKey: key });
}

/**
 * 「会话出错中断」的特征串（prompt-too-long）。
 * 为什么用文本特征而不是等某个专用字段：引擎在 API 报错时**不一定**给出结构化字段，
 * 但错误文本一定会出现在 last_assistant_message / 工具错误里。宁可少判，不可错调 ——
 * 所以特征串写得很具体（真报超长时的原文形态）。
 */
const TOO_LONG_RE =
  /prompt is too long|prompt too long|too many tokens|context (?:length|window) exceeded|maximum context length|exceeds? the (?:maximum )?context|input (?:is )?too long|400[^\n]{0,80}(?:too long|token)/i;

export function looksLikePromptTooLong(text) {
  return TOO_LONG_RE.test(String(text ?? ""));
}

export { TOO_LONG_RE };
