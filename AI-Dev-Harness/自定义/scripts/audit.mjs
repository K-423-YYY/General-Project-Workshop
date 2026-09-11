#!/usr/bin/env node
/**
 * audit.mjs —— 会话后审计（U3）
 * ============================================================
 * 作用：会话结束后跑一次，检查 AI **实际干了什么**（不是它说自己干了什么）。
 *
 *   1. 是否用了禁用命令（sed -i / cat > 源文件 / python 内联改码 …）
 *   2. 是否改了不该改的文件（AI-Dev-Harness\内置\、.env …）
 *   3. 是否「改一行 → 跑全量」（全量 E2E / CI 次数）
 *   4. 是否留了临时探针文件没清理
 *   5. 上下文水位 / 配额 / 逃生阀使用是否异常
 *   6. 有没有「改了文件但一次测试都没跑」「没有任何独立验收证据」
 *
 * 数据来源：**工作区根** `日志\02-命令\cmd-*.jsonl`（U4 写的命令记录）、git、`.claude\state\`。
 *           （第 2 段：命令日志不再写进项目 —— 项目要交付，不能留 harness 的运行痕迹。）
 * 输出：
 *   ① **日志中心** `日志\07-审计\audit-<时间戳>.md` —— 只追加的历史报告（第 2 段新增）；
 *   ② 项目内 `.harness\audit-latest.md` / `audit-latest.json` —— **运行态**，
 *      下一次启动时由 build-prompt.mjs（U2）注入，形成「审计 → 下次更守规矩」的闭环，
 *      随 cleanup.ps1 一并归档删除（所以它不是"交付物"，只是交接件）。
 *
 * 为什么重要：对**没有机制层**的引擎（Codex / DSH / Trae），这是唯一的「事后追责」手段。
 *
 * 用法：
 *   node audit.mjs                         审计当前目录（项目内跑）
 *   node audit.mjs --project "<项目目录>"    指定项目
 *   node audit.mjs --since 2026-09-11      只看某天及以后的命令日志
 *   node audit.mjs --json                  机器可读结果
 *   node audit.mjs --strict                有 high 级问题时退 1（可挂进 CI / 收尾流程）
 *   node audit.mjs --no-write              只看结果，不写报告文件
 *   node audit.mjs --print                 把最新报告打到 stdout
 *
 * 依赖：无（只用 node 内置模块）。**只读**，不修改任何项目文件。
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FILES as LOG_FILES,
  GLOBS,
  appendLog,
  readCategory,
  resolveLogRoot,
} from "./lib/log-center.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\自定义\scripts
const HARNESS_ROOT = path.resolve(SCRIPT_DIR, "..", "..");       // …\AI-Dev-Harness
const RULES_FILE = path.join(SCRIPT_DIR, "audit-rules.json");

const SEV = { high: 3, medium: 2, low: 1, info: 0 };
const SEV_LABEL = { high: "🔴 高危", medium: "🟠 中", low: "🟡 低", info: "ℹ️ 提示" };
const SEV_NAME = { high: "高", medium: "中", low: "低", info: "提示" };

// ──────────────────────────────────────────────────────────── 工具

function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return dflt; }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function stampFile(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/** 只读地列目录（带深度与忽略目录控制） */
function walk(root, { maxDepth = 4, ignore = [], limit = 4000 } = {}) {
  const out = [];
  const ignoreAbs = ignore.map((p) => p.replace(/\/$/, "").replace(/\\/g, "/"));
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < limit) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (ignoreAbs.some((ig) => rel === ig || rel.startsWith(`${ig}/`) || rel.includes(`/${ig}/`))) continue;
      if (e.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        out.push({ abs: full, rel });
      }
    }
  }
  return out;
}

function git(project, args) {
  try {
    const r = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 15000 });
    if (r.status !== 0) return null;
    return String(r.stdout || "");
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────── 采集

/** 路径比较用：统一成小写 + 正斜杠；能 realpath 就 realpath（大小写/短名/软链都归一） */
function normPath(p) {
  let s = String(p || "");
  try { s = fs.realpathSync.native(s); } catch { /* 路径可能已不存在，用原值 */ }
  return s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 读**工作区根** `日志\02-命令\cmd-*.jsonl`（第 2 段：命令日志已迁出项目）。
 *
 * ★ 必须按 project 过滤：日志中心是**工作区级**的，同一天里可能混着好几个项目的命令记录。
 *   过滤规则：记录里带 project 且与本次审计的项目不同 → 跳过；记录里没有 project（老格式）→ 保留。
 */
async function loadCommandEntries(project, since) {
  const cat = readCategory("command", { filter: GLOBS.command, sinceDay: since, logRoot: resolveLogRoot() });
  const want = normPath(project);
  const entries = [];
  for (const { file, text } of cat.texts) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; /* 坏行跳过 */ }
      if (j.project && normPath(j.project) !== want) continue; // 别的项目的记录
      j.__file = file;
      entries.push(j);
    }
  }
  return { entries, files: cat.files, dir: cat.dir };
}

/**
 * 独立验收证据：数**工作区根** `日志\03-验证\verify-*.log` 里属于本项目的份数。
 * 每份日志头部都写了 `cwd: <项目根>`，按它判定归属（同一台机上多个项目共用这个日志中心）。
 */
async function countVerifyLogs(project, since) {
  const cat = readCategory("verify", { filter: GLOBS.verify, sinceDay: since, logRoot: resolveLogRoot() });
  const want = normPath(project);
  let n = 0;
  for (const { text } of cat.texts) {
    const head = text.slice(0, 2000).replace(/\\/g, "/").toLowerCase();
    if (head.includes(want)) n++;
  }
  return n;
}

function loadHookQuota(project, rules) {
  return readJson(path.join(project, rules.sources.hookQuota), null);
}

function collectGit(project) {
  const diff = git(project, ["diff", "--name-only", "HEAD"]);
  const untracked = git(project, ["ls-files", "--others", "--exclude-standard"]);
  const isRepo = diff !== null;
  const changed = [];
  for (const src of [diff, untracked]) {
    if (!src) continue;
    for (const l of src.split("\n")) {
      const t = l.trim().replace(/\\/g, "/");
      if (t && !changed.includes(t)) changed.push(t);
    }
  }
  const status = git(project, ["status", "--short"]);
  return { isRepo, changed, statusLineCount: status ? status.split("\n").filter(Boolean).length : 0 };
}

// ──────────────────────────────────────────────────────────── 检查

function audit(project, rules, opts, logData) {
  const findings = [];
  const add = (check, severity, title, detail = [], evidence = []) =>
    findings.push({ check, severity, title, detail: [].concat(detail), evidence: [].concat(evidence).slice(0, rules.thresholds.findingLimit ?? 25) });

  const { entries, files } = logData;
  const quota = loadHookQuota(project, rules);
  const g = collectGit(project);

  // ---- 1. 命令记录概况 ----
  const bySession = new Map();
  for (const e of entries) {
    const s = e.session || "(无会话标识)";
    const b = bySession.get(s) ?? { allow: 0, deny: 0, bypass: 0, other: 0, e2e: 0, ci: 0, l1: 0 };
    if (e.decision === "allow") b.allow++;
    else if (e.decision === "deny") b.deny++;
    else if (e.decision === "bypass") b.bypass++;
    else b.other++;
    if (e.rule === "pass" || e.decision === "bypass") {
      const c = String(e.cmd || "");
      if (/\b(playwright)\b/i.test(c)) b.e2e++;
      else if (/\bnpm\s+(?:run\s+)?(?:ci|test)\b/i.test(c)) b.ci++;
      else if (/\b(vitest|jest|mocha|pytest)\b/i.test(c)) b.l1++;
    }
    bySession.set(s, b);
  }

  const usedWrapper = entries.length > 0;
  if (!usedWrapper) {
    add("命令记录", "medium",
      "没有任何命令包装记录 —— U4 这次没有生效",
      [
        "`日志\\02-命令\\cmd-*.jsonl`（工作区根）里没有本项目的记录。可能原因：",
        "① 这次会话不是通过 `run.bat` / `run.ps1` / `run.sh` 启动的（PATH 没有被前置）；",
        "② 在 Trae IDE / 桌面客户端里直接开的对话（不走 harness 启动器）；",
        "③ 本次会话确实一条 shell 命令都没跑；",
        "④ 项目被复制到工作区之外运行（那时日志根推导不到，按设计不写日志）。",
        "→ 前两种情况下，**命令拦截与审计都是失效的**，只有 U2 启动词 + U5 机制层还在。",
      ]);
  }

  // ---- 2. 禁用命令 ----
  const executed = [], attempted = [];
  for (const e of entries) {
    const cmd = String(e.cmd || "");
    if (!cmd) continue;
    for (const r of rules.forbiddenCommands) {
      let hit = false;
      try { hit = new RegExp(r.regExp, "i").test(cmd); } catch { hit = false; }
      if (!hit) continue;
      const line = `[${e.time || e.iso || "?"}] ${cmd}`;
      if (e.decision === "deny") attempted.push({ id: r.id, sev: r.severity, why: r.why, line });
      else executed.push({ id: r.id, sev: r.severity, why: r.why, line });
    }
  }
  if (executed.length) {
    const ids = [...new Set(executed.map((x) => x.id))];
    add("禁用命令", "high",
      `有 ${executed.length} 条禁用命令**真的执行了**（${ids.join("、")}）`,
      [`规则：${executed[0].why}`, "这些命令没有被拦下 —— 检查包装器是否生效（见上一条），或有人用了逃生阀。"],
      executed.map((x) => x.line));
  }
  if (attempted.length) {
    const ids = [...new Set(attempted.map((x) => x.id))];
    // 汇总的严重度取各条里的最高值，但「被拦下」这件事最多算 medium（拦下了就没造成后果）
    const worst = attempted.reduce((a, b) => (SEV[b.sev] > SEV[a] ? b.sev : a), "low");
    add("禁用命令", SEV[worst] > SEV.medium ? "medium" : worst,
      `有 ${attempted.length} 次禁用命令**尝试**被拦下（${ids.join("、")}）`,
      ["被拦下说明机制层在工作；但要看模型有没有换种写法绕过（见下方命令明细）。"],
      attempted.map((x) => x.line));
  }

  // ---- 3. 受保护路径 ----
  const hitProtected = [];
  for (const f of g.changed) {
    for (const r of rules.protectedPaths) {
      let hit = false;
      try { hit = new RegExp(r.regExp, "i").test(f); } catch { hit = false; }
      if (hit) hitProtected.push({ f, sev: r.severity, why: r.why, id: r.regExp });
    }
  }
  if (hitProtected.length) {
    const worst = hitProtected.reduce((a, b) => (SEV[b.sev] > SEV[a.sev] ? b : a));
    add("受保护路径", worst.sev,
      `有 ${hitProtected.length} 个受保护路径下的文件被改动`,
      ["这些路径要么是用户铁律区，要么含密钥；确认是必须的改动再保留。"],
      hitProtected.map((x) => `${x.f}　(${x.why})`));
  }

  // ---- 4. 全量测试次数 ----
  for (const [s, b] of bySession) {
    if (b.e2e > (rules.thresholds.e2ePerSession ?? 2)) {
      add("测试分层", "medium",
        `会话 ${s} 跑了 ${b.e2e} 次全量 E2E（配额 ${rules.thresholds.e2ePerSession} 次）`,
        ["「改一行 → 跑全量」是上次事故里最贵的一项（131 次 / 102 分钟）。",
         "正常形态：改动 → 定向单测（L1，不限次），全量只留到阶段收尾。"]);
    }
    if (b.ci > (rules.thresholds.ciPerSession ?? 3)) {
      add("测试分层", "low", `会话 ${s} 跑了 ${b.ci} 次全量 CI（阈值 ${rules.thresholds.ciPerSession} 次）`);
    }
    if (b.deny > 0) {
      add("机制层", "info", `会话 ${s} 有 ${b.deny} 条命令被拦下（机制层在起作用）`);
    }
  }

  // ---- 5. 逃生阀 ----
  const bypassUses = entries.filter((e) => e.decision === "bypass");
  if (bypassUses.length >= (rules.thresholds.bypassWarn ?? 1)) {
    add("逃生阀", bypassUses.length > 5 ? "medium" : "low",
      `逃生阀被用了 ${bypassUses.length} 次`,
      ["逃生阀是给「确实需要」准备的（`HARNESS_BYPASS=1` 或 `.harness\\bypass` 文件）。",
       "次数多说明规则可能与实际工作方式不匹配 —— 该调规则，而不是天天开逃生阀。"],
      bypassUses.slice(0, 10).map((e) => `[${e.time}] ${e.cmd}　(${e.reason || "?"})`));
  }

  // ---- 6. 临时探针文件 ----
  const ignore = rules.ignorePaths ?? [];
  const filesAll = walk(project, { ignore, maxDepth: 4 });
  const tmpHits = [];
  for (const f of filesAll) {
    const name = path.basename(f.rel);
    for (const pat of rules.tempArtifacts ?? []) {
      if (globToRe(pat).test(name)) tmpHits.push(f.rel);
    }
  }
  if (tmpHits.length) {
    add("临时文件", "low",
      `发现 ${tmpHits.length} 个疑似临时 / 探针文件没有清理`,
      ["上次事故里遗留过 `zz*.spec.ts` 之类的探针文件，后来被当成正式测试跑了。"],
      tmpHits.slice(0, 15));
  }

  // ---- 7. 上下文水位 / 成本 ----
  const ctx = readJson(path.join(project, rules.sources.ctxFile), null);
  if (ctx && typeof ctx.usedPct === "number") {
    if (ctx.usedPct >= 70) {
      add("上下文", "medium",
        `上下文水位 ${ctx.usedPct}% ≥ 70%`,
        ["协议第 11 章：单会话 ≤70%，到线就该写 HANDOFF 并结束会话。",
         "硬撑到自动压缩会丢细节，且压缩后的每一轮都要重读整份摘要 —— 这正是上次 3.49 亿 token 事故的形态。"]);
    } else {
      add("上下文", "info", `上下文水位 ${ctx.usedPct}%（健康）`);
    }
  }

  // ---- 8. 改了东西但没验证 ----
  const tested = [...bySession.values()].reduce((n, b) => n + b.e2e + b.ci + b.l1, 0);
  if (g.changed.length >= (rules.thresholds.editsWithoutAnyTest ?? 3) && tested === 0) {
    add("验证", "medium",
      `改了 ${g.changed.length} 个文件，但命令记录里**一次测试都没跑**`,
      ["改动必须至少跑一次 L1 定向单测（秒级）。没有验证的改动不能算完成。"]);
  }
  const verifyLogs = logData.verifyCount ?? 0;
  if (g.changed.length > 0 && verifyLogs === 0) {
    add("独立验收", "low",
      "没有独立验收证据（`日志\\03-验证\\verify-*.log` 里没有本项目的记录）",
      ["协议第 12.3 章：验收要跑 `.claude\\hooks\\verify-gate.mjs`，原始输出落盘，模型只能引用脚本输出。"]);
  }

  // ---- 9. 命令明细（供人翻查） ----
  if (entries.length) {
    const interesting = entries
      .filter((e) => e.decision !== "allow" || /sed|cat\s*>|python|playwright|npm|npx|sleep/.test(String(e.cmd)))
      .slice(-25);
    if (interesting.length) {
      add("命令明细", "info",
        `最近 ${interesting.length} 条值得看一眼的命令（完整记录见 ${files.join("、") || "命令日志"}）`,
        [],
        interesting.map((e) => `${e.decision.padEnd(7)} [${e.time || "?"}] ${e.cmd}　→ exit=${e.exit ?? "-"}`));
    }
  }

  // ---- 10. git 状态 ----
  if (g.isRepo) {
    add("git", "info", `工作区有 ${g.changed.length} 个未提交改动`);
  } else {
    add("git", "low", "项目目录不是 git 仓库（`git diff` 用不了，改动清单只能靠命令记录）");
  }

  // 排序：严重度高的在前
  findings.sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.check.localeCompare(b.check, "zh"));

  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  return {
    project,
    generatedAt: new Date().toISOString(),
    generatedAtLocal: stamp(),
    since: opts.since || null,
    commandEntries: entries.length,
    commandFiles: files,
    changedFiles: g.changed,
    sessions: [...bySession.entries()].map(([k, v]) => ({ session: k, ...v })),
    hookQuotaSessions: quota?.sessions ? Object.keys(quota.sessions).length : 0,
    counts,
    findings,
  };
}

// ──────────────────────────────────────────────────────────── 报告

function renderMarkdown(res) {
  const L = [];
  const c = res.counts;
  L.push(`# 会话审计报告 · ${res.generatedAtLocal}`);
  L.push("");
  L.push(`- 项目：\`${res.project}\``);
  L.push(`- 数据来源：${res.commandFiles.length ? res.commandFiles.map((f) => `日志/02-命令/${f}`).join("、") : "（无命令日志）"}`);
  L.push(`- 命令记录：${res.commandEntries} 条　·　改动文件：${res.changedFiles.length} 个`);
  L.push(`- 区间：${res.since ? `${res.since} 起` : "全部"}`);
  L.push("");
  L.push("## 结论");
  L.push("");
  L.push(`🔴 高危 **${c.high ?? 0}**　🟠 中 **${c.medium ?? 0}**　🟡 低 **${c.low ?? 0}**　ℹ️ 提示 **${c.info ?? 0}**`);
  L.push("");
  const worst = (c.high ?? 0) > 0 ? "**有高危问题，必须处理后再继续。**"
    : (c.medium ?? 0) > 0 ? "有中等问题，建议看上表逐条处理。"
    : "没有发现高危/中等问题。";
  L.push(worst);
  L.push("");
  L.push("## 逐项");
  L.push("");
  let i = 0;
  for (const f of res.findings) {
    i++;
    L.push(`### ${i}. [${f.check}] ${SEV_LABEL[f.severity]} ${f.title}`);
    for (const d of f.detail) L.push(`- ${d}`);
    if (f.evidence.length) {
      L.push("");
      L.push("```text");
      for (const e of f.evidence) L.push(e);
      L.push("```");
    }
    L.push("");
  }
  if (res.changedFiles.length) {
    L.push("## 本区间改动过的文件");
    L.push("");
    for (const f of res.changedFiles.slice(0, 50)) L.push(`- ${f}`);
    if (res.changedFiles.length > 50) L.push(`- …（共 ${res.changedFiles.length} 个）`);
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push("> 本报告由 `AI-Dev-Harness\\自定义\\scripts\\audit.mjs`（U3）生成，**只读**，不改动任何项目文件。");
  L.push("> 它会在下一次通过 harness 启动会话时，被 `build-prompt.mjs`（U2）摘要注入，形成闭环。");
  L.push("");
  return L.join("\n");
}

/** 给 U2 注入用的紧凑摘要（≤ 15 行） */
function renderInject(res) {
  const c = res.counts;
  const L = [];
  L.push(`[上次会话审计] ${res.generatedAtLocal}`);
  L.push(`高危 ${c.high ?? 0} / 中 ${c.medium ?? 0} / 低 ${c.low ?? 0}；命令记录 ${res.commandEntries} 条；改动 ${res.changedFiles.length} 个文件。`);
  const top = res.findings.filter((f) => SEV[f.severity] >= SEV.medium).slice(0, 4);
  for (const f of top) L.push(`· [${SEV_NAME[f.severity]}] ${f.title}`);
  if (!top.length) L.push("· 没有高危/中等问题。");
  L.push("详细报告：.harness\\audit-latest.md");
  return L.join("\n");
}

// ──────────────────────────────────────────────────────────── CLI

const USAGE = `用法：node audit.mjs [选项]

  （无参数）        审计当前目录（在项目内跑）
  --project <目录>  指定项目目录（默认：当前目录）
  --since <日期>    只看该日期及以后的命令日志（YYYY-MM-DD）
  --json            以 JSON 输出结果（仍会写报告文件）
  --strict          有 high 级问题时退出码 1
  --no-write        只打印，不写报告文件
  --print           把最新报告写到 stdout
  --quiet           不打印控制台摘要
  --help, -h        显示本帮助

规则文件：AI-Dev-Harness\\自定义\\scripts\\audit-rules.json`;

function parseArgs(argv) {
  const o = { project: null, since: null, json: false, strict: false, noWrite: false, print: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    switch (a) {
      case "--project": case "-p": o.project = next(); break;
      case "--since": o.since = next(); break;
      case "--json": o.json = true; break;
      case "--strict": o.strict = true; break;
      case "--no-write": o.noWrite = true; break;
      case "--print": o.print = true; break;
      case "--quiet": o.quiet = true; break;
      case "--help": case "-h": o.help = true; break;
      default:
        if (!a.startsWith("-") && !o.project) o.project = a;
        else throw new Error(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  return o;
}

/**
 * 把完整报告写到**工作区根** `日志\07-审计\`（第 2 段）。
 * ★ 只追加不改写：文件名带时间戳，一次审计一份，历史报告永不覆盖。
 * 日志中心不可用（写不进去）时返回 null —— 审计结果照样在 stdout 与项目 latest 里。
 */
function writeLogCenterReport(md) {
  try {
    const r = appendLog("audit", { file: LOG_FILES.audit(), text: md, logRoot: resolveLogRoot() });
    return r.ok ? r.path : null;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE + "\n"); return 0; }

  const rules = readJson(RULES_FILE, null);
  if (!rules) {
    process.stderr.write(`[audit] 读不到规则文件：${RULES_FILE}\n`);
    return 2;
  }

  const project = path.resolve(opts.project || process.cwd());
  if (!fs.existsSync(project)) {
    process.stderr.write(`[audit] 项目目录不存在：${project}\n`);
    return 2;
  }

  if (opts.print) {
    const latest = path.join(project, ".harness", "audit-latest.md");
    try { process.stdout.write(fs.readFileSync(latest, "utf8")); return 0; }
    catch { process.stderr.write(`[audit] 还没有审计报告：${latest}\n`); return 2; }
  }

  // 第 2 段：命令日志与验收证据都从**工作区根**的日志中心读（项目里已经没有了）
  const logData = {
    ...(await loadCommandEntries(project, opts.since)),
    verifyCount: await countVerifyLogs(project, opts.since),
  };

  const res = audit(project, rules, opts, logData);
  const md = renderMarkdown(res);
  res.injectSummary = renderInject(res);

  if (!opts.noWrite) {
    // ① 日志中心：只追加的历史报告（07-审计）
    res.logCenterReport = await writeLogCenterReport(md);

    // ② 项目内：latest（运行态，供下一次启动由 build-prompt.mjs 注入；随清理归档删除）
    const dir = path.join(project, ".harness");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `audit-${stampFile()}.md`), md, "utf8");
      fs.writeFileSync(path.join(dir, "audit-latest.md"), md, "utf8");
      fs.writeFileSync(path.join(dir, "audit-latest.json"), JSON.stringify({ ...res, markdown: undefined }, null, 2), "utf8");
    } catch (err) {
      process.stderr.write(`[audit] 报告写盘失败（不影响审计结果）：${err.message}\n`);
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (!opts.quiet) {
    const c = res.counts;
    process.stdout.write(`[audit] ${res.project}\n`);
    process.stdout.write(`  命令记录 ${res.commandEntries} 条 · 改动文件 ${res.changedFiles.length} 个\n`);
    process.stdout.write(`  🔴 ${c.high ?? 0}　🟠 ${c.medium ?? 0}　🟡 ${c.low ?? 0}　ℹ️ ${c.info ?? 0}\n`);
    for (const f of res.findings.filter((x) => SEV[x.severity] >= SEV.medium)) {
      process.stdout.write(`  ${SEV_LABEL[f.severity]} [${f.check}] ${f.title}\n`);
    }
    if (!opts.noWrite) {
      process.stdout.write(`  报告：.harness\\audit-latest.md（运行态，供下次启动注入）\n`);
      process.stdout.write(
        res.logCenterReport
          ? `  历史留档：${res.logCenterReport}\n`
          : "  历史留档：没写成（日志中心不可用？）—— 结果仍在上面的 stdout 与项目 .harness\\ 里\n",
      );
    }
  }

  if (opts.strict && (res.counts.high ?? 0) > 0) return 1;
  return 0;
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  // ★ main 是 async（要读日志中心），这里必须等它 —— 直接把 Promise 赋给 exitCode 会变成退出码 0。
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`[audit] 出错：${err.stack || err.message}\n`);
      process.exitCode = 2;
    });
}

export { audit, renderMarkdown, renderInject, RULES_FILE };
