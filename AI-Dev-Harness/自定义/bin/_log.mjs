#!/usr/bin/env node
/**
 * _log.mjs —— 命令包装器的唯一实现（U4 · 跨引擎强制层）
 * ============================================================
 * `自定义\bin\` 下的 sed / perl / python / sleep / playwright / npx / npm 包装器
 * 都是 3 行垫片，真正干活的是本文件：
 *
 *   1. 判定这条命令是否违规（规则见 judge()，与 .claude/hooks/lib/policy.mjs 同源）
 *   2. 无论放行还是拦截，都记一行到**工作区根** 日志\02-命令\cmd-<日期>.jsonl（供 U3 审计）；
 *      被拦下的再额外记一行到 日志\04-拦截\block-<日期>.jsonl（规则、命令、原因、替代建议）
 *   3. 放行时**找到真实命令并原样执行**，退出码 / 信号原样透传（绝不吞掉用户命令的行为）
 *
 * 为什么要有这一层（方案 09 文档 U4）：
 *   AI 无论用什么引擎、什么工具，**都要通过 shell 执行命令**。hooks 只覆盖 Claude Code，
 *   而 PATH 前置 + 命令包装对**所有引擎**都成立 —— 这是唯一真正跨引擎的强制层。
 *
 * 局限（必须如实知道）：
 *   · 只对**通过 harness 启动**（run.ps1 / run.sh 前置了 PATH）的会话生效；
 *   · 只拦 **shell 命令**，引擎内置的文件编辑工具拦不到（那要靠 U5）；
 *   · 在 Windows 上绕开 PATH 直接调用绝对路径（如 `C:\...\sed.exe -i`）拦不到。
 *
 * 第 1 段修正（P0-1 / P0-2）：
 *   · 解析真实命令改用 `自定义\scripts\lib\resolve-command.mjs`（扩展名优先级 .exe → .cmd → .bat → .com
 *     → 无扩展名；补 MSYS 路径映射）。旧实现把「无扩展名」排第一，于是 Windows 上永远选中
 *     node 安装目录里给 Git Bash 用的 `npm`（`#!/usr/bin/env bash`），再用 `/usr/bin/env` 去 spawn → 必然 ENOENT。
 *   · 无扩展名的脚本优先用**同名 .cmd/.exe 垫片**跑（这正是 cmd.exe 自己的选择顺序），
 *     垫片也没有时才用 shebang 解释器，最后才兜底直接执行。
 *   · **进程没起来（spawn 失败 / 既无退出码也无信号）一律返回 127** ——
 *     旧实现把 `status === null` 当成 0，制造了「命令没跑、退出码 0」的假绿。
 *
 * 铁律：**fail-open**。任何内部异常都必须放行原命令 —— 包装器坏掉绝不能把用户锁死。
 *
 * 第 2 段（日志中心）：
 *   · 日志从项目内 `.harness\logs\` 迁到**工作区根**的 `日志\`（项目是要交付的，不能留运行痕迹）。
 *     启动器 run.ps1 / run.sh 会设 HARNESS_LOG_ROOT；不设时按「AI-Dev-Harness 的上一级\日志」推导。
 *   · 日志写不进去（目录只读、没有工作区根）时只往 stderr 出声，**命令照常执行、退出码不变**。
 *   · HARNESS_WRAP_LOG 保留：自检台用它把日志指向临时文件，从而只断言"包装器真的执行了命令"。
 *
 * 用法（垫片内部使用，人不直接调）：
 *   node _log.mjs --tool sed -- -i 's/a/b/' foo.ts
 *   node _log.mjs --tool playwright -- test
 *
 * 环境变量：
 *   HARNESS_PROJECT     项目根（run.ps1/run.sh 会设；缺省用 cwd）
 *   HARNESS_SESSION_KEY 会话标识（配额按它分桶；缺省用「临时-<日期>」）
 *   HARNESS_BYPASS=1    逃生阀（等价于 .harness\bypass 存在）
 *   HARNESS_SLEEP_LIMIT sleep 上限秒数（默认 30）
 *   HARNESS_ALLOW_SLEEP=1 只放行长 sleep，其余规则不变
 *   HARNESS_NEED_E2E=1  本次放行一次 E2E（相当于「带理由的追加」，决策 3）
 *   HARNESS_WRAP_LOG    覆盖日志路径（自检台用）
 *   HARNESS_NO_WRAP=1   完全停用包装判断（记一行 bypass 后原样执行）
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childExit, resolveCommand, runResolved } from "../scripts/lib/resolve-command.mjs";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\自定义\bin

// ──────────────────────────────────────────────────────────── 策略（与 hooks 同源）

const LIMITS = {
  e2ePerSession: 2,   // 决策 3：全量 E2E 成功次数上限，失败不计数
  ciPerSession: 3,    // 与 policy.mjs 的 LIMITS.ciPerSession 一致
  sleepSeconds: 30,
  cmdMaxChars: 2000,
  logMaxBytes: 8 * 1024 * 1024,
};

const SED_INPLACE_RE = /\bsed\b[^\n]*\s(?:-[A-Za-z]*i[A-Za-z]*\b|--in-place\b)/i;
const PERL_INPLACE_RE = /\bperl\b[^\n]*\s-[A-Za-z]*i[A-Za-z]*\b/i;
const PY_INLINE_RE = /\bpython[0-9.]*\s*(?:-c\b|-\s*<{1,2}|<{1,2}\s*['"]?[A-Za-z_])/i;
const PY_WRITE_RE =
  /open\s*\([^)]*['"][wa]\+?['"]|writeFile|write_text|writelines|\.write\s*\(|to_csv|to_json|\.replace\s*\(|shutil\.(?:copy|move|rmtree)|os\.(?:remove|rename|unlink|makedirs)/i;
const E2E_RE = /\bplaywright\b/i;
const CI_RE = /\bnpm\s+(?:run\s+)?(?:ci|test)\b/i;
const TEST_RUNNER_RE = /\b(vitest|jest|playwright|cypress|mocha|pytest)\b/i;

/**
 * 规则判定。返回：
 *   null                          → 直接放行
 *   { deny, what, why, alt }      → 拦截
 *   { quota, limit, what }        → 放行但记账（limit=null 表示只记账不限次）
 */
function judge(tool, argv, limits) {
  const cmdline = `${tool} ${argv.join(" ")}`.trim();

  switch (tool) {
    case "sed":
      if (SED_INPLACE_RE.test(cmdline)) {
        return deny("sed -i（就地改文件）",
          "内联原地替换在 Windows 下会静默失配（退出码 0 但文件没改），改坏了你还不知道",
          "改用 Edit / Write 工具逐处修改；比较两个版本用 `git diff`");
      }
      return null;

    case "perl":
      if (PERL_INPLACE_RE.test(cmdline)) {
        return deny("perl -i（就地改文件）", "与 sed -i 同理，Windows 下会静默失配",
          "改用 Edit / Write 工具；确实要脚本化处理时，先写成 .harness\\tools\\*.mjs 再 node 运行");
      }
      return null;

    case "python":
    case "python3":
      if (PY_INLINE_RE.test(cmdline) && PY_WRITE_RE.test(cmdline)) {
        return deny("python 内联改码（-c / 管道）",
          "内联改码绕过审阅、失败时静默，且 Windows 下换行与编码极易踩坑",
          "改用 Edit / Write 工具；确实要脚本处理时写成 .harness\\tools\\*.py 文件再 `python 文件.py`（改动可见可复查）");
      }
      return null;

    case "sleep": {
      if (process.env.HARNESS_ALLOW_SLEEP === "1") return null;
      const n = parseSleep(argv);
      if (n !== null && n >= limits.sleepSeconds) {
        return deny(`sleep ${n} 秒`,
          "长时间空等纯属浪费（上次事故里白等了 15.6 分钟）",
          "长任务用后台运行（run_in_background）或改成轮询检查；确需等待就缩到 30 秒以内并说明理由");
      }
      return null;
    }

    case "playwright":
      return { quota: "e2e", limit: limits.e2ePerSession, what: "全量 E2E（playwright）" };

    case "npx":
      if (E2E_RE.test(cmdline)) return { quota: "e2e", limit: limits.e2ePerSession, what: "全量 E2E（npx playwright）" };
      if (CI_RE.test(cmdline)) return { quota: "ci", limit: limits.ciPerSession, what: "全量 CI（npx … test）" };
      if (TEST_RUNNER_RE.test(cmdline)) return { quota: "l1", limit: null, what: "定向单测" };
      return null;

    case "npm":
      if (CI_RE.test(cmdline)) return { quota: "ci", limit: limits.ciPerSession, what: "全量 CI（npm test / npm run ci）" };
      return null;

    default:
      return null;
  }
}

function deny(what, why, alt) {
  return { deny: true, what, why, alt };
}

/** sleep 的参数：支持 30 / 1m / 0.5 */
function parseSleep(argv) {
  const s = argv.join(" ").trim();
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([smhd]?)\s*$/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] || "s").toLowerCase();
  return v * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1);
}

// ──────────────────────────────────────────────────────────── 项目 / 会话 / 逃生阀

function projectDir() {
  const cand = process.env.HARNESS_PROJECT || process.cwd();
  try { return fs.realpathSync.native(cand); } catch { return cand; }
}

function bypassReason() {
  if (process.env.HARNESS_BYPASS === "1") return "环境变量 HARNESS_BYPASS=1";
  if (process.env.HARNESS_NO_WRAP === "1") return "环境变量 HARNESS_NO_WRAP=1";
  const p = path.join(projectDir(), ".harness", "bypass");
  try { if (fs.existsSync(p)) return p; } catch { /* 读不到当没命中 */ }
  return null;
}

function sessionKey() {
  if (process.env.HARNESS_SESSION_KEY) return process.env.HARNESS_SESSION_KEY;
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `adhoc-${day}`;
}

function quotaFile() {
  return path.join(projectDir(), ".harness", "state", "wrap-quota.json");
}

function loadQuota() {
  try {
    const j = JSON.parse(fs.readFileSync(quotaFile(), "utf8"));
    if (j && typeof j === "object" && j.sessions && typeof j.sessions === "object") return j;
  } catch { /* 首次 / 损坏 → 全新状态 */ }
  return { version: 1, sessions: {} };
}

function saveQuota(q) {
  const keys = Object.keys(q.sessions);
  if (keys.length > 20) {
    keys.sort((a, b) => (q.sessions[a]?.updatedAt || 0) - (q.sessions[b]?.updatedAt || 0));
    for (const k of keys.slice(0, keys.length - 20)) delete q.sessions[k];
  }
  const f = quotaFile();
  const tmp = `${f}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(q, null, 2), "utf8");
    fs.renameSync(tmp, f);
  } catch { try { fs.unlinkSync(tmp); } catch { /* 忽略 */ } }
}

function sessionBucket(q, key) {
  q.sessions[key] ??= { startedAt: Date.now() };
  const s = q.sessions[key];
  s.e2e ??= { ok: 0, blocked: 0 };
  s.ci ??= { ok: 0, blocked: 0 };
  s.l1 ??= { ok: 0 };
  s.updatedAt = Date.now();
  return s;
}

// ──────────────────────────────────────────────────────────── 日志（工作区根 日志\）
//
// 第 2 段（日志中心）：命令记录写 日志\02-命令\cmd-<日期>.jsonl；
// 被拦下的再写一行到 日志\04-拦截\block-<日期>.jsonl。
// 项目内 .harness\logs\ 取消（项目要交付，不能留 harness 的运行痕迹）。
//
// HARNESS_WRAP_LOG 仍然保留：自检台靠它把日志指到临时文件，只断言"包装器真的执行了命令"。

// ★ 这里用**动态 import + try/catch**，不用静态 import：
//   包装器在每条命令的必经之路上，日志中心（或其入口文件）任何形式的加载失败
//   都绝不允许把命令本身带崩。拿不到就退化成"只出声、不写日志"，命令照常执行。
const LOG_CENTER_PATH = path.resolve(BIN_DIR, "..", "scripts", "lib", "log-center.mjs");
let LOG = null;
try {
  LOG = await import(pathToFileURL(LOG_CENTER_PATH).href);
} catch (err) {
  try {
    process.stderr.write(
      `[harness] ⚠️ 日志中心不可用（${err?.message || err}）—— 本次只执行命令、不写日志。\n`,
    );
  } catch {
    /* ignore */
  }
  LOG = null;
}
const HARNESS_LOG_ROOT = LOG ? LOG.resolveLogRoot() : null;

/** 本地兜底写法（只给 HARNESS_WRAP_LOG 覆盖用）：追加一行 JSONL，失败静默 */
function writeJsonlLocal(f, rec) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    rotateIfBig(f);
    fs.appendFileSync(f, JSON.stringify(rec) + "\n", "utf8");
  } catch { /* fail-open */ }
}

/**
 * 写一行命令记录。任何失败都绝不影响命令执行。
 * @param {object} rec       记录
 * @param {"command"|"block"} category 写 02-命令 还是 04-拦截（拦截时两处都写）
 */
function writeLog(rec, category = "command") {
  const override = process.env.HARNESS_WRAP_LOG;
  if (override) { writeJsonlLocal(override, rec); return; }
  if (!LOG) return; // loadLogCenter 已经出过声，这里不再重复刷屏
  try {
    const file = category === "block" ? LOG.FILES.block() : LOG.FILES.command();
    LOG.appendJsonl(category, file, rec, { logRoot: HARNESS_LOG_ROOT });
  } catch { /* fail-open */ }
}

function rotateIfBig(f) {
  let big = false;
  try { big = fs.statSync(f).size >= LIMITS.logMaxBytes; } catch { return; }
  if (!big) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  try { fs.renameSync(f, `${f.replace(/\.jsonl$/, "")}.${stamp}.jsonl`); } catch { /* 忽略 */ }
}

// ──────────────────────────────────────────────────────────── 真实命令解析 / 执行
// 解析逻辑全部收进 自定义\scripts\lib\resolve-command.mjs（第 1 段 · P0-1/P0-2 的统一实现）。
// 这里只保留两件事：把「跳过 harness 自己的 bin」传下去；把结果交给执行层。

/** 在 PATH 里找真实命令，**跳过 harness 自己的 bin**（否则会自己调自己 → 无限递归）。找不到返回 null。 */
function resolveReal(tool, explicit) {
  if (explicit) return explicit;
  return resolveCommand(tool, { skipDirs: [BIN_DIR] });
}

/**
 * 执行真实命令（**完全同步**）。
 * 方案链：同目录同名 .cmd/.exe 垫片 → shebang 解释器 → 直接执行（见 resolve-command.mjs）。
 * 只在「进程根本没起来」时才换下一个方案；已经跑起来就绝不重试（避免重复执行有副作用的命令）。
 */
function runChild(real, argv) {
  return runResolved(real, argv);
}

// ──────────────────────────────────────────────────────────── 主流程

function parseArgs(argv) {
  const o = { tool: null, real: null, project: null, session: null, quiet: false, args: [], err: null };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { i++; break; }
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    if (a === "--tool") o.tool = next();
    else if (a === "--real") o.real = next();
    else if (a === "--project") o.project = next();
    else if (a === "--session") o.session = next();
    else if (a === "--quiet") o.quiet = true;
    else { o.err = `未知参数：${a}`; return o; }
  }
  o.args = argv.slice(i);
  return o;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.err || !o.tool) {
    process.stderr.write(`[harness] 包装器参数错误：${o.err || "缺少 --tool"}\n`);
    return 0; // fail-open
  }
  if (o.project) process.env.HARNESS_PROJECT = o.project;
  if (o.session) process.env.HARNESS_SESSION_KEY = o.session;

  const limits = {
    ...LIMITS,
    sleepSeconds: Number(process.env.HARNESS_SLEEP_LIMIT || LIMITS.sleepSeconds) || LIMITS.sleepSeconds,
  };

  const raw = `${o.tool} ${o.args.join(" ")}`.trim();
  const base = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    time: stamp(),
    source: "wrapper:_log.mjs",
    tool: o.tool,
    args: o.args,
    cmd: raw.length > LIMITS.cmdMaxChars ? raw.slice(0, LIMITS.cmdMaxChars) + "…(截断)" : raw,
    cwd: process.cwd(),
    project: projectDir(),
    session: sessionKey(),
    engine: process.env.HARNESS_ENGINE || null,
  };

  // ---- 0. 逃生阀（命中就完全不做策略判断，但**仍然记账**一行，供审计统计逃生阀用了多少次）----
  const byp = bypassReason();
  if (byp) return exec(o, base, { bypass: true, bypassReason: byp });

  // ---- 1. 判定 ----
  let verdict = null;
  try { verdict = judge(o.tool, o.args, limits); } catch { verdict = null; }

  if (verdict && verdict.deny) {
    const rec = {
      ...base,
      decision: "deny",
      rule: o.tool,
      what: verdict.what,
      why: verdict.why,
      alt: verdict.alt,
    };
    writeLog(rec);          // 02-命令：所有命令一律留一条
    writeLog(rec, "block"); // 04-拦截：额外留档（规则 / 命令 / 原因 / 替代建议）
    if (!o.quiet) {
      process.stderr.write(
        `\n[harness] ⛔ 已拦截：${verdict.what}\n` +
        `  为什么：${verdict.why}\n` +
        `  替代做法：${verdict.alt}\n` +
        `  确实需要这一步：建 .harness\\bypass 文件（用完立刻删掉），或设 HARNESS_BYPASS=1\n` +
        `  （本命令没有执行，进程没有跑起来。不要换种写法绕过，按上面的替代做法做。）\n\n`
      );
    }
    return 1;
  }

  // ---- 2. 配额 ----
  let quotaKey = null;
  if (verdict && verdict.quota) {
    quotaKey = verdict.quota;
    const limit = verdict.limit;
    const forced = quotaKey === "e2e" && process.env.HARNESS_NEED_E2E === "1";
    if (limit !== null && limit !== undefined && !forced) {
      const q = loadQuota();
      const s = sessionBucket(q, sessionKey());
      const used = s[quotaKey].ok ?? 0;
      if (used >= limit) {
        s[quotaKey].blocked = (s[quotaKey].blocked ?? 0) + 1;
        s.updatedAt = Date.now();
        saveQuota(q);
        const rec = {
          ...base,
          decision: "deny",
          rule: `${quotaKey}-quota`,
          what: verdict.what,
          why: `本会话已成功跑过 ${used} 次（上限 ${limit} 次；失败的运行不计数）`,
          alt: "先跑定向单测（L1）定位问题；确认要全量验收时设 HARNESS_NEED_E2E=1 再跑一次",
        };
        writeLog(rec);
        writeLog(rec, "block");
        if (!o.quiet) {
          process.stderr.write(
            `\n[harness] ⛔ 已拦截：${verdict.what} 超出配额\n` +
            `  为什么：本会话已成功跑过 ${used} 次（上限 ${limit} 次；失败的运行不计数）\n` +
            `  替代做法：先跑定向单测（L1）定位问题；确认要全量验收时，set HARNESS_NEED_E2E=1 再跑一次\n` +
            `  确实需要这一步：建 .harness\\bypass 文件（用完立刻删掉），或设 HARNESS_BYPASS=1\n` +
            `  （本命令没有执行。不要靠反复重试撞配额。）\n\n`
          );
        }
        return 1;
      }
    }
  }

  return exec(o, base, { quotaKey });
}

/** 找到真实命令并执行；退出码 / 信号原样透传 */
function exec(o, base, { bypass = false, bypassReason: bypReason = null, quotaKey = null } = {}) {
  let real = null;
  try { real = resolveReal(o.tool, o.real); } catch { real = null; }
  if (!real) {
    writeLog({ ...base, decision: "notfound", rule: "resolve", reason: `PATH 里找不到真实命令 ${o.tool}`, exit: 127 });
    if (!o.quiet) {
      process.stderr.write(
        `[harness] 包装器找不到真实命令「${o.tool}」（PATH 里没有），这条命令**没有执行**，按失败处理（退出码 127）。\n`
      );
    }
    return 127;
  }

  const t0 = Date.now();
  let out;
  try { out = runChild(real, o.args); }
  catch (err) {
    writeLog({ ...base, decision: "spawnfail", rule: "spawn", reason: String(err && err.message), real, exit: 127 });
    if (!o.quiet) process.stderr.write(`[harness] 包装器内部异常，已按失败处理（退出码 127）：${err && err.message}\n`);
    return 127;
  }

  const ms = Date.now() - t0;

  // ★ 关键修正（P0-1 第 3 个缺陷）：进程没起来 = 失败，**一律 127**，绝不当成 0。
  //   旧实现写的是 `r.status === null ? (r.signal ? 128 : 0) : r.status` —— spawn 失败时
  //   status 就是 null、signal 也是 null，于是"命令根本没跑"被算成成功。
  if (!out || !out.result) {
    const attempts = (out?.attempts ?? []).map((a) => ({ command: a.command, via: a.via, error: a.error ?? null, status: a.status ?? null }));
    writeLog({
      ...base,
      decision: "spawnfail",
      rule: "spawn",
      reason: out?.failure ?? "没有拿到执行结果",
      real,
      exit: 127,
      ok: false,
      ms,
      attempts,
    });
    if (!o.quiet) {
      process.stderr.write(
        `\n[harness] ⛔ 命令「${o.tool}」没能跑起来（真实命令：${real ?? "未找到"}），已按失败处理（退出码 127）。\n` +
          `  原因：${out?.failure ?? "没有拿到执行结果"}\n` +
          `  试过的方案：${attempts.length ? attempts.map((a) => `${a.via || a.command}（${a.error ?? a.status}）`).join(" / ") : "无"}\n` +
          `  注意：这条命令**没有执行**，所以它的"成功"不能当成依据。\n\n`
      );
    }
    return 127;
  }

  const r = out.result;
  const { exit, reason: exitReason } = childExit(r);
  const ok = exit === 0;

  if (quotaKey) {
    try {
      const q = loadQuota();
      const s = sessionBucket(q, sessionKey());
      if (ok) s[quotaKey].ok = (s[quotaKey].ok ?? 0) + 1;
      s.updatedAt = Date.now();
      saveQuota(q);
    } catch { /* fail-open */ }
  }

  writeLog({
    ...base,
    decision: bypass ? "bypass" : "allow",
    rule: bypass ? "bypass" : "pass",
    reason: bypReason,
    real,
    via: out.plan?.via ?? null,
    exit,
    signal: r.signal ?? null,
    ...(exitReason ? { exitReason } : {}),
    ok,
    ms,
  });

  return exit;
}

process.exitCode = main();
