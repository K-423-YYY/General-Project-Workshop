#!/usr/bin/env node
/**
 * scaffold-ext.mjs —— 项目脚手架扩展（A13 · 第 5 批 · 决策 6）
 * ============================================================
 * 位置：AI-Dev-Harness\自定义\scripts\scaffold-ext.mjs
 * 在 `内置\scripts\scaffold.ps1` **之后**运行，把机制层补进项目目录。
 *
 * 为什么需要它（一句话）：
 *   终端模式下 `内置\engine\run.ps1` 会 `Set-Location` 到项目目录再启动引擎，
 *   而 Claude Code 用「会话 cwd」当项目根、**不向上寻找 `.claude/settings.json`**
 *   （第 2 批实测结论，见 03-执行记录\进度.md「第 2 批新发现」）——
 *   所以工作区根的机制层在终端模式下完全不生效。本脚本把机制层复制进项目目录，
 *   让「在项目里开的会话」也受同一套 hooks 保护。
 *
 * 它做什么（全部幂等，可重复跑）：
 *   1. 补齐项目内 `.claude\hooks\`（从工作区根的主副本整体同步，含 lib\）
 *   2. 生成 / 合并项目内 `.claude\settings.json`（autoCompactWindow + hooks + statusLine）
 *   3. 建 `.harness\`（logs\ + JOURNAL.md 种子）与 `.claude\state\`（目录即可）
 *   4. 补项目内 `.gitignore`（`.harness\`、`.claude\state\`）
 *   5. 补缺项目规则文件（CLAUDE.md / AGENTS.md / .trae\rules\project_rules.md）
 *
 * ★ 与方案原文的一处偏离（有理由，必须如实报告）：
 *   02 文档 A13 写的是「创建 .harness/{logs, JOURNAL.md, HANDOFF.md, quota.json}」。
 *   本脚本**不预生成 HANDOFF.md**，也不预生成 quota.json：
 *     · HANDOFF.md 一旦存在，`inject-rules.mjs` 会在 SessionStart 注入「上次交接摘要」，
 *       `env-doctor` 也会报「有未完成的工作」—— 一个空占位文件等于对模型撒谎。
 *       它应当由 `on-stop.mjs` 在真有会话结束时生成。
 *     · quota.json 的真实路径是 `.claude/state/quota.json`（policy.mjs 的 stateFile()），
 *       由 hooks 首次运行时按需创建；预生成空壳只会让「本会话跑了几次 E2E」变成假 0。
 *   → 只建目录，不建假文件。
 *
 * 边界（与第 5 批的固定边界一致）：
 *   · 只写 `--project` 指向的项目目录。
 *   · 默认不覆盖「已存在且内容不同」的规则文件与 hook 文件（--force / hooks 除外，见下）。
 *   · 拒绝把项目目录指向工作区根（会自我覆盖）或 `AI-Dev-Harness\` 内部。
 *
 * 退出码：0 = 成功且一致；1 = 有需要处理的问题（--check 发现漂移 / 有跳过项）；2 = 脚本自身出错。
 *
 * 用法：
 *   node scaffold-ext.mjs --project ..\我的项目          # 建 / 同步机制层
 *   node scaffold-ext.mjs --project <项目> --check       # 只检查一致性，不写文件
 *   node scaffold-ext.mjs --project <项目> --dry-run     # 预演，不落盘
 *   node scaffold-ext.mjs --project <项目> --remove      # 撤销机制层（.claude/）
 *   node scaffold-ext.mjs --json                         # 机器可读
 *
 * 依赖：无（只用 node 内置模块）。
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTable, conservativeCap } from "./lib/model-capability.mjs";

// ────────────────────────────────────────────────────────────
// 路径推导（与 内置\scripts\scaffold.ps1 的算法一致，不写死绝对路径）
// ────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\AI-Dev-Harness\自定义\scripts
const HARNESS_ROOT = path.resolve(SCRIPT_DIR, "..", "..");       // …\AI-Dev-Harness
const WORK_ROOT = path.resolve(HARNESS_ROOT, "..");              // …\General-Project-Workshop

const HOOKS_REL = path.join(".claude", "hooks");
const SETTINGS_REL = path.join(".claude", "settings.json");
const STATE_REL = path.join(".claude", "state");
const TPL_DIR_REL = path.join("自定义", "项目规则模板");

/** 规则文件：引擎名 → [模板文件, 项目内目标路径]（与 scaffold.ps1 一一对应） */
const RULE_TARGETS = {
  claude: [["CLAUDE.template.md", "CLAUDE.md"]],
  codex: [["AGENTS.template.md", "AGENTS.md"]],
  dsh: [["AGENTS.template.md", "AGENTS.md"]],           // DSH 不自动读规则文件，这里只做兜底
  trae: [["trae-project_rules.template.md", path.join(".trae", "rules", "project_rules.md")]],
};

const GI_MARK = "# harness 运行时产物（由 scaffold-ext.mjs 生成）";
const GI_LINES = [".harness/", ".claude/state/"];

// ────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    project: null,
    workRoot: WORK_ROOT,
    harnessRoot: HARNESS_ROOT,
    from: null,
    engine: null,
    rulesExplicit: false,
    rules: "all",
    check: false,
    dryRun: false,
    force: false,
    noOverwrite: false,
    remove: false,
    json: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    switch (a) {
      case "--project": case "-p":  o.project = path.resolve(next()); break;
      case "--work-root":           o.workRoot = path.resolve(next()); break;
      case "--harness-root":        o.harnessRoot = path.resolve(next()); break;
      case "--from":                o.from = path.resolve(next()); break;
      case "--engine":              o.engine = String(next()).toLowerCase(); break;
      case "--rules":               o.rules = String(next()).toLowerCase(); o.rulesExplicit = true; break;
      case "--check":               o.check = true; break;
      case "--dry-run":             o.dryRun = true; break;
      case "--force":               o.force = true; break;
      case "--no-overwrite":        o.noOverwrite = true; break;
      case "--remove":              o.remove = true; break;
      case "--json":                o.json = true; break;
      case "--quiet": case "-q":    o.quiet = true; break;
      case "--help": case "-h":     o.help = true; break;
      default: throw new Error(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  if (!["all", "claude", "codex", "dsh", "trae", "none"].includes(o.rules)) {
    throw new Error(`--rules 只能是 all | claude | codex | dsh | trae | none（收到 ${o.rules}）`);
  }
  if (o.engine && !ENGINE_ALIAS[o.engine]) {
    throw new Error(`--engine 只能是 ${Object.keys(ENGINE_ALIAS).join(" | ")}（收到 ${o.engine}）`);
  }
  // --engine 是「按引擎分发」的简写：它同时决定规则文件集合与要不要装 .claude 机制层。
  // 显式给了 --rules 时以 --rules 为准（用户最清楚自己要什么）。
  if (o.engine && !o.rulesExplicit) o.rules = ENGINE_ALIAS[o.engine].rules;
  return o;
}

/**
 * 引擎 → 规则集合 + 是否安装 Claude Code 机制层（第 7 批 · U1/U4 接线）。
 * 机制层（.claude\hooks）是 **Claude Code 专属**的：Codex 用自己的 hooks 配置、
 * DSH 走 --patch 层、Trae 没有 hooks（见 自定义\引擎适配\）。
 * 给它们复制一份用不上的 .claude\ 只会造成误解，所以按引擎分发。
 */
const ENGINE_ALIAS = {
  "claude-code":      { key: "claude-code",      rules: "claude", hooks: true },
  claude:             { key: "claude-code",      rules: "claude", hooks: true },
  "codex-cli":        { key: "codex-cli",        rules: "codex",  hooks: false },
  codex:              { key: "codex-cli",        rules: "codex",  hooks: false },
  "deepseek-harness": { key: "deepseek-harness", rules: "dsh",    hooks: false },
  dsh:                { key: "deepseek-harness", rules: "dsh",    hooks: false },
  "traecode-cli":     { key: "traecode-cli",     rules: "trae",   hooks: false },
  traecode:           { key: "traecode-cli",     rules: "trae",   hooks: false },
  trae:               { key: "traecode-cli",     rules: "trae",   hooks: false },
};

const USAGE = `scaffold-ext.mjs —— 项目脚手架扩展：把机制层（.claude\\）补进项目目录

  node scaffold-ext.mjs [--project <项目目录>] [选项]

选项：
  --project, -p <路径>   目标项目目录（默认 <工作区根>\\我的项目，与 scaffold.ps1 一致）
  --work-root <路径>     工作区根（默认按本脚本位置推导）
  --harness-root <路径>  AI-Dev-Harness 所在目录（默认按本脚本位置推导）
  --from <路径>          hook 主副本目录（默认 <工作区根>\\.claude\\hooks）
  --engine <名字>        按引擎分发（第 7 批）：codex-cli | claude-code | deepseek-harness | traecode-cli
                         （别名 codex / claude / dsh / trae / trae）
                         它同时决定规则文件集合，以及要不要装 .claude\\ 机制层
                         （hooks 是 Claude Code 专属，其它引擎见 自定义\\引擎适配\\）
  --rules <集合>         补哪些项目规则文件：all | claude | codex | dsh | trae | none（默认 all）
                         显式给了 --rules 时以它为准，覆盖 --engine 的推导
  --check                只做一致性检查，不写任何文件（有漂移退 1）
  --dry-run              预演：打印将要做的改动，不落盘
  --force                覆盖「已存在且内容不同」的规则文件
  --no-overwrite         项目内 hook 与主副本不同时只报告，不覆盖（默认覆盖并留 .bak）
  --remove               撤销机制层（删 .claude\\hooks、settings.json、state\\）
  --json                 输出机器可读 JSON
  --quiet, -q            只输出结论
  --help, -h             本帮助

退出码：0 = 成功且一致；1 = 有需要处理的问题；2 = 脚本自身出错。`;

// ────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function readText(file) {
  try { return fs.readFileSync(file, "utf8").replace(/^﻿/, ""); } catch { return null; }
}

function readJson(file) {
  const t = readText(file);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function ensureDir(dir, dryRun) {
  if (dryRun) return true;
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

function stampCompact(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 递归列出目录下的分发文件（相对路径），与 env-doctor 的一致性检查同一口径 */
function walkRel(dir, prefix = "") {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = prefix ? path.join(prefix, e.name) : e.name;
    if (e.isDirectory()) out = out.concat(walkRel(path.join(dir, e.name), rel));
    else if (/\.(mjs|js|json)$/i.test(e.name) && !/\.bak[-.]/i.test(e.name)) out.push(rel);
  }
  return out;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────

function run(args) {
  const acts = [];      // {level, id, text}
  const add = (level, id, text) => acts.push({ level, id, text });

  const workRoot = args.workRoot;
  const projectDir = args.project ?? path.join(workRoot, "我的项目");
  const masterHooks = args.from ?? path.join(workRoot, HOOKS_REL);
  const masterSettings = path.join(workRoot, SETTINGS_REL);
  const projHooks = path.join(projectDir, HOOKS_REL);
  const projSettings = path.join(projectDir, SETTINGS_REL);
  const tplDir = path.join(args.harnessRoot, TPL_DIR_REL);

  // ---- 按引擎分发（第 7 批）：--engine 决定规则集合，也决定要不要装 Claude Code 专属的机制层 ----
  const eng = args.engine ? ENGINE_ALIAS[args.engine] : null;
  const installHooks = !eng || eng.hooks;
  if (eng) {
    add("info", "engine",
      `--engine ${args.engine} → 引擎 ${eng.key}；规则集合 ${args.rules}` +
      (args.rulesExplicit ? "（--rules 显式指定，优先生效）" : "") +
      (installHooks ? "" : "；**不装 .claude\\ 机制层**（hooks 是 Claude Code 专属，其它引擎见 自定义\\引擎适配\\）"));
  }

  // ---- 安全护栏：不许把项目目录指向工作区根 / harness 内部 ----
  const bad = [];
  if (path.resolve(projectDir) === path.resolve(workRoot)) bad.push("项目目录 == 工作区根（会自我覆盖 .claude\\）");
  if (isInside(projectDir, args.harnessRoot) || path.resolve(projectDir) === path.resolve(args.harnessRoot)) {
    bad.push("项目目录在 AI-Dev-Harness\\ 内部（机制层不该建在这里）");
  }
  if (bad.length) return { fatal: bad.join("；"), projectDir, masterHooks };
  if (!exists(projectDir)) {
    if (args.dryRun || args.check) {
      add("warn", "project", `项目目录不存在：${projectDir}（--check/--dry-run 不建目录）`);
    } else {
      ensureDir(projectDir, false);
      add("ok", "project", `已建项目目录：${projectDir}`);
    }
  }

  const missingMaster = !exists(masterHooks);
  if (missingMaster) {
    add("warn", "master", `找不到 hook 主副本：${masterHooks}（工作区根的 .claude\\hooks 尚未生成？）`);
  }

  // ══ --check / --remove 走各自分支 ══
  if (args.remove) return doRemove({ args, add, projectDir, projHooks, projSettings, acts });

  if (args.check) {
    doCheck({ args, add, projectDir, masterHooks, masterSettings, projHooks, projSettings, tplDir, projectDirExists: exists(projectDir) });
    return { acts, projectDir, masterHooks, installHooks, engineKey: eng?.key ?? null };
  }

  // ══ 1. hooks 同步 ══
  const hookStat = { copied: [], updated: [], same: [], kept: [], backed: [] };
  if (!installHooks) {
    add("info", "hooks", "跳过 hook 同步（--engine 指定的是非 Claude Code 引擎）");
  } else if (!missingMaster && exists(projectDir)) {
    syncHooks({ masterHooks, projHooks, args, hookStat });
    if (hookStat.copied.length) add("ok", "hooks", `复制 hook ${hookStat.copied.length} 个 → ${projHooks}`);
    if (hookStat.updated.length) {
      add("ok", "hooks", `同步（覆盖）hook ${hookStat.updated.length} 个：${hookStat.updated.join(", ")}` +
        (hookStat.backed.length ? `\n     （原文件已留 .bak-*：${hookStat.backed.length} 个）` : ""));
    }
    if (hookStat.kept.length) {
      add("warn", "hooks", `保留了内容不同的 hook ${hookStat.kept.length} 个（--no-overwrite）：${hookStat.kept.join(", ")}`);
    }
    if (!hookStat.copied.length && !hookStat.updated.length && !hookStat.kept.length) {
      add("ok", "hooks", `hook 已是主副本的最新版（${hookStat.same.length} 个文件逐一比对相同）`);
    }
  }

  // ══ 2. settings.json（Claude Code 专属）══
  let win = null;
  let settingsStat = null;
  if (installHooks) {
    win = pickWindow(masterSettings, args.harnessRoot);
    settingsStat = writeSettings({ args, projSettings, masterSettings, win, add });
  } else {
    add("info", "settings", "跳过 .claude\\settings.json（非 Claude Code 引擎不读它）");
  }

  // ══ 3. .harness\ 与 .claude\state\ ══
  if (!args.dryRun) {
    // ★ 第 2 段（日志中心）：项目内**不再建** .harness\logs\ ——
    //   命令日志 / 验收原始输出 / 长输出落盘全部写到**工作区根**的 日志\（项目要交付，不能留痕）。
    //   这里只建 .harness\ 本身（HANDOFF / JOURNAL / verify.json 等运行态仍然需要，随清理归档后删除）。
    ensureDir(path.join(projectDir, ".harness"), false);
    if (installHooks) ensureDir(path.join(projectDir, STATE_REL), false);
    const journal = path.join(projectDir, ".harness", "JOURNAL.md");
    if (!exists(journal)) {
      fs.writeFileSync(journal,
        "# 会话流水（由 .claude/hooks/on-stop.mjs 自动追加，不要整篇重写）\n", "utf8");
      add("ok", "harness", `已建 .harness\\ 与 JOURNAL.md 种子` +
        `\n     （HANDOFF.md 故意不预生成：由 on-stop.mjs 在真有会话结束时生成，避免注入假的「上次交接」）`);
    } else {
      add("ok", "harness", "已确保 .harness\\ 与 .claude\\state\\ 存在");
    }
  } else {
    add("info", "harness", "（预演）将建 .harness\\、JOURNAL.md 种子" +
      (installHooks ? "、.claude\\state\\" : ""));
  }

  // ══ 4. .gitignore ══
  const gi = writeGitignore({ args, projectDir, add });

  // ══ 5. 规则文件 ══
  const ruleStat = writeRules({ args, tplDir, projectDir, add });

  // ══ 6. 事后校验：settings 里引用的 hook 是否真的存在 ══
  const verify = installHooks ? verifySettingsRefs(projSettings, projectDir) : { missing: [], checked: 0 };
  if (verify.missing.length) {
    add("fail", "refs", `settings.json 引用了不存在的脚本：${verify.missing.join(", ")}`);
  } else if (verify.checked) {
    add("ok", "refs", `settings.json 引用的 ${verify.checked} 个 hook 脚本都在项目内`);
  }

  return {
    acts, projectDir, masterHooks, projHooks, hookStat, settingsStat, gi, ruleStat, window: win,
    installHooks, engineKey: eng?.key ?? null,
  };
}

// ────────────────────────────────────────────────────────────
// 1. hooks 同步
// ────────────────────────────────────────────────────────────

function syncHooks({ masterHooks, projHooks, args, hookStat }) {
  const rels = walkRel(masterHooks);
  for (const rel of rels) {
    const src = path.join(masterHooks, rel);
    const dst = path.join(projHooks, rel);
    const sTxt = readText(src);
    if (exists(dst)) {
      const dTxt = readText(dst);
      if (sTxt !== null && dTxt !== null && sTxt === dTxt) { hookStat.same.push(rel); continue; }
      if (args.noOverwrite) { hookStat.kept.push(rel); continue; }
      if (!args.dryRun) {
        try { fs.copyFileSync(dst, `${dst}.bak-${stampCompact()}`); hookStat.backed.push(rel); } catch { /* 备份失败不阻塞 */ }
      }
      hookStat.updated.push(rel);
    } else {
      hookStat.copied.push(rel);
    }
    if (!args.dryRun) {
      ensureDir(path.dirname(dst), false);
      fs.copyFileSync(src, dst);              // 字节级复制：与主副本逐字节相同，env-doctor 才判得出一致
    }
  }
  // 主副本已删除、项目里还留着的旧 hook（只报告，不删——可能是用户自己加的）
  const projOnly = walkRel(projHooks).filter((r) => !rels.includes(r));
  if (projOnly.length) {
    hookStat.projOnly = projOnly;
  }
}

// ────────────────────────────────────────────────────────────
// 2. settings.json
// ────────────────────────────────────────────────────────────

/** 压缩上限：优先沿用工作区根已定的值；没有则回落到能力表的保守值 */
function pickWindow(masterSettings, harnessRoot) {
  const m = readJson(masterSettings);
  if (m && Number.isFinite(Number(m.autoCompactWindow))) {
    return { value: Number(m.autoCompactWindow), source: `工作区根 ${path.basename(masterSettings)}` };
  }
  try {
    const table = loadTable(harnessRoot);
    return { value: conservativeCap(table), source: "能力表 conservative 段（工作区根未设）" };
  } catch {
    return { value: 102400, source: "内置兜底值（能力表读不到）" };
  }
}

function writeSettings({ args, projSettings, masterSettings, win, add }) {
  const master = readJson(masterSettings);
  const existing = readJson(projSettings);
  const before = exists(projSettings) ? readText(projSettings) : null;

  const next = { ...(existing ?? {}) };
  const managed = [];
  next.autoCompactWindow = win.value;
  managed.push(`autoCompactWindow = ${win.value}（来源：${win.source}）`);
  if (master?.hooks) { next.hooks = master.hooks; managed.push(`hooks（${Object.keys(master.hooks).length} 个事件）`); }
  else add("warn", "settings", `工作区根 settings.json 里没有 hooks 键 —— 项目内机制层不会生效`);
  if (master?.statusLine) { next.statusLine = master.statusLine; managed.push("statusLine"); }

  const preserved = Object.keys(next).filter((k) => !["autoCompactWindow", "hooks", "statusLine"].includes(k));
  const ordered = { autoCompactWindow: next.autoCompactWindow, ...Object.fromEntries(
    Object.entries(next).filter(([k]) => k !== "autoCompactWindow")) };

  const same = before !== null && JSON.stringify(readJson(projSettings)) === JSON.stringify(ordered);

  if (same) {
    add("ok", "settings", `settings.json 已是目标内容（${managed.join("；")}）`);
    return { changed: false, path: projSettings, managed, preserved, backup: null };
  }

  let backup = null;
  if (args.dryRun) {
    add("info", "settings", `（预演）将写入 ${projSettings}\n     ${managed.join("\n     ")}`);
    return { changed: true, path: projSettings, managed, preserved, backup: null, dryRun: true };
  }

  ensureDir(path.dirname(projSettings), false);
  if (before !== null) {
    backup = `${projSettings}.bak-${stampCompact()}`;
    try { fs.writeFileSync(backup, before, "utf8"); } catch { backup = null; }
  }
  fs.writeFileSync(projSettings, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  add("ok", "settings", `已${existing ? "合并写入" : "生成"} ${projSettings}\n     ${managed.join("\n     ")}` +
    (preserved.length ? `\n     保留原有键：${preserved.join(", ")}` : "") +
    (backup ? `\n     原文件已备份：${path.basename(backup)}` : ""));
  return { changed: true, path: projSettings, managed, preserved, backup };
}

/** 校验 settings 里 args 指向的脚本真的存在（相对路径按会话 cwd 解析 → 项目根） */
function verifySettingsRefs(projSettings, projectDir) {
  const s = readJson(projSettings);
  const refs = [];
  const pushFrom = (list) => {
    for (const item of list ?? []) for (const h of item?.hooks ?? []) for (const a of h?.args ?? []) {
      if (typeof a === "string" && !a.startsWith("-") && /\.(mjs|js|cjs)$/i.test(a)) refs.push(a);
    }
  };
  pushFrom(s?.hooks?.PreToolUse); pushFrom(s?.hooks?.PostToolUse);
  pushFrom(s?.hooks?.PostToolUseFailure); pushFrom(s?.hooks?.PreCompact);
  pushFrom(s?.hooks?.Stop); pushFrom(s?.hooks?.SessionStart);
  if (s?.statusLine?.args) for (const a of s.statusLine.args) {
    if (typeof a === "string" && /\.(mjs|js|cjs)$/i.test(a)) refs.push(a);
  }
  const missing = refs.filter((r) => !exists(path.isAbsolute(r) ? r : path.join(projectDir, r)));
  return { checked: refs.length, missing };
}

// ────────────────────────────────────────────────────────────
// 4. .gitignore
// ────────────────────────────────────────────────────────────

function writeGitignore({ args, projectDir, add }) {
  const gi = path.join(projectDir, ".gitignore");
  const cur = readText(gi);
  if (cur === null) {
    if (args.dryRun) { add("info", "gitignore", "（预演）将新建 .gitignore（含 .harness/、.claude/state/）"); return { created: true }; }
    ensureDir(projectDir, false);
    fs.writeFileSync(gi, `${GI_MARK}\n${GI_LINES.join("\n")}\n`, "utf8");
    add("ok", "gitignore", "已新建项目 .gitignore（含 .harness/、.claude/state/）");
    return { created: true };
  }
  const missing = GI_LINES.filter((l) => !cur.split(/\r?\n/).some((x) => x.trim() === l));
  if (!missing.length) {
    add("ok", "gitignore", "项目 .gitignore 已包含 .harness/ 与 .claude/state/");
    return { created: false, appended: [] };
  }
  if (args.dryRun) { add("info", "gitignore", `（预演）将补 .gitignore：${missing.join(", ")}`); return { created: false, appended: missing }; }
  const block = `${cur.endsWith("\n") ? "" : "\n"}\n${GI_MARK}\n${missing.join("\n")}\n`;
  fs.writeFileSync(gi, cur + block, "utf8");
  add("ok", "gitignore", `已补项目 .gitignore：${missing.join(", ")}`);
  return { created: false, appended: missing };
}

// ────────────────────────────────────────────────────────────
// 5. 项目规则文件
// ────────────────────────────────────────────────────────────

function ruleList(rules) {
  if (rules === "none") return [];
  const names = rules === "all" ? ["claude", "codex", "trae"] : [rules];
  const seen = new Set();
  const out = [];
  for (const n of names) for (const [tpl, dst] of RULE_TARGETS[n] ?? []) {
    const key = `${tpl}→${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tpl, dst });
  }
  return out;
}

function writeRules({ args, tplDir, projectDir, add }) {
  const list = ruleList(args.rules);
  if (!list.length) { add("info", "rules", "--rules none：跳过项目规则文件"); return { written: [], same: [], skipped: [] }; }

  const written = [], same = [], skipped = [];
  for (const { tpl, dst } of list) {
    const src = path.join(tplDir, tpl);
    const target = path.join(projectDir, dst);
    if (!exists(src)) { skipped.push(`${dst}（模板缺失：${tpl}）`); continue; }
    if (exists(target)) {
      if (readText(target) === readText(src)) { same.push(dst); continue; }
      if (!args.force) { skipped.push(`${dst}（已存在且与模板不同；要覆盖加 --force）`); continue; }
    }
    if (args.dryRun) { written.push(dst); continue; }
    ensureDir(path.dirname(target), false);
    fs.copyFileSync(src, target);   // 字节级复制，保持与模板完全一致
    written.push(dst);
  }
  if (written.length) add("ok", "rules", `规则文件已${args.dryRun ? "（预演）" : ""}写入 ${written.length} 份：${written.join(", ")}`);
  if (same.length) add("ok", "rules", `规则文件已是模板内容：${same.join(", ")}`);
  if (skipped.length) add("warn", "rules", `规则文件跳过 ${skipped.length} 份：\n     ${skipped.join("\n     ")}`);
  return { written, same, skipped };
}

// ────────────────────────────────────────────────────────────
// --check
// ────────────────────────────────────────────────────────────

/**
 * 第 2 段（日志中心）：项目内 `.harness\logs\` 已废弃（日志改写到工作区根 日志\）。
 * 这里把它当**残留**报出来 —— 老项目升上来时最容易忘的就是它，
 * 而"交付时项目里还有 .harness\logs"正是纯净度自检要拦的事。
 */
function checkLegacyLogs(projectDir, add) {
  if (exists(path.join(projectDir, ".harness", "logs"))) {
    add("warn", "log-center",
      "项目内还有 .harness\\logs\\（第 2 段已取消这个位置）→ 日志现在写在工作区根的 日志\\；" +
        "这个残留目录随 cleanup.ps1 一并归档删除，交付前必须为空");
  }
}

function compareHooks(projHooks, masterHooks) {
  const drift = [];
  const relA = walkRel(projHooks);
  const relB = walkRel(masterHooks);
  for (const r of relA) {
    if (!relB.includes(r)) { drift.push(`· 主副本没有 ${r}（项目里多出来的）`); continue; }
    if (readText(path.join(projHooks, r)) !== readText(path.join(masterHooks, r))) drift.push(`· 内容不同：${r}`);
  }
  for (const r of relB) if (!relA.includes(r)) drift.push(`· 项目内缺 ${r}`);
  return drift;
}

function doCheck({ args, add, projectDir, masterHooks, masterSettings, projHooks, projSettings, tplDir, projectDirExists }) {
  if (!projectDirExists) { add("fail", "project", `项目目录不存在：${projectDir}`); return; }

  // --engine 指定了非 Claude Code 引擎时，本来就不该有 .claude\，跳过相关检查
  const eng = args.engine ? ENGINE_ALIAS[args.engine] : null;
  const installHooks = !eng || eng.hooks;
  if (!installHooks) {
    add("info", "engine", `--engine ${args.engine}：非 Claude Code 引擎，跳过 .claude\\ 一致性检查`);
    // 规则文件与 .harness\ 仍然要查
    for (const { tpl, dst } of ruleList(args.rules)) {
      const src = path.join(tplDir, tpl);
      const target = path.join(projectDir, dst);
      if (!exists(target)) add("warn", "rules", `缺项目规则文件 ${dst}（跑 scaffold-ext.mjs 补齐）`);
      else if (readText(target) !== readText(src)) add("warn", "rules", `${dst} 与模板不同（跑 scaffold-ext.mjs 同步，或加 --force 覆盖）`);
      else add("ok", "rules", `${dst} 与模板一致`);
    }
    add(exists(path.join(projectDir, ".harness")) ? "ok" : "warn", "harness",
      exists(path.join(projectDir, ".harness"))
        ? ".harness\\ 已存在（只放运行态：HANDOFF / JOURNAL / verify.json；命令日志在 工作区根 日志\\）"
        : "缺 .harness\\（跑 scaffold-ext.mjs 补齐）");
    checkLegacyLogs(projectDir, add);
    return;
  }

  // hooks 一致性
  if (!exists(masterHooks)) {
    add("warn", "drift", `跳过：找不到主副本 ${masterHooks}`);
  } else if (!exists(projHooks)) {
    add("fail", "drift", `项目内没有 .claude\\hooks（机制层未生成）→ 跑 scaffold-ext.mjs 补齐`);
  } else {
    const drift = compareHooks(projHooks, masterHooks);
    if (drift.length) {
      add("fail", "drift", `项目内 hooks 与主副本不一致（${drift.length} 处）：\n     ${drift.join("\n     ")}`);
      add("info", "drift-fix", "同步命令：node AI-Dev-Harness\\自定义\\scripts\\scaffold-ext.mjs --project " + projectDir);
    } else {
      add("ok", "drift", `项目内 hooks 与主副本逐字节一致（${walkRel(projHooks).length} 个文件）`);
    }
  }

  // settings 存在性 + 引用完整性
  if (!exists(projSettings)) {
    add("fail", "settings", `项目内没有 .claude\\settings.json → hooks 不会被加载`);
  } else {
    const v = verifySettingsRefs(projSettings, projectDir);
    if (v.missing.length) add("fail", "refs", `settings.json 引用了不存在的脚本：${v.missing.join(", ")}`);
    else add("ok", "refs", `settings.json 存在，引用的 ${v.checked} 个脚本都在`);

    const rootS = readJson(masterSettings);
    const cur = readJson(projSettings);
    if (rootS && JSON.stringify(rootS.hooks) !== JSON.stringify(cur.hooks)) {
      add("warn", "settings-drift", "项目内 hooks 配置与工作区根不同 → 跑 scaffold-ext.mjs 同步");
    }
  }

  // .harness / .claude\state / .gitignore
  add(exists(path.join(projectDir, ".harness")) ? "ok" : "warn", "harness",
    exists(path.join(projectDir, ".harness")) ? ".harness\\ 已存在" : "缺 .harness\\（跑 scaffold-ext.mjs 补齐）");
  checkLegacyLogs(projectDir, add);
  const gi = readText(path.join(projectDir, ".gitignore"));
  const giMissing = gi === null ? GI_LINES : GI_LINES.filter((l) => !gi.split(/\r?\n/).some((x) => x.trim() === l));
  add(giMissing.length ? "warn" : "ok", "gitignore",
    giMissing.length ? `项目 .gitignore 缺：${giMissing.join(", ")}` : "项目 .gitignore 已含运行时产物规则");
}

// ────────────────────────────────────────────────────────────
// --remove
// ────────────────────────────────────────────────────────────

function doRemove({ args, add, acts, projectDir, projHooks, projSettings }) {
  const targets = [projHooks, path.join(projectDir, STATE_REL)];
  let removed = 0;
  for (const t of targets) {
    if (!exists(t)) continue;
    if (args.dryRun) { add("info", "remove", `（预演）将删除 ${t}`); removed++; continue; }
    try { fs.rmSync(t, { recursive: true, force: true }); removed++; add("ok", "remove", `已删除 ${t}`); }
    catch (err) { add("fail", "remove", `删除失败 ${t}：${err.message}`); }
  }
  // settings.json 及其备份
  for (const f of [projSettings, `${projSettings}.bak`]) {
    if (!exists(f)) continue;
    if (args.dryRun) { add("info", "remove", `（预演）将删除 ${f}`); continue; }
    try { fs.rmSync(f, { force: true }); add("ok", "remove", `已删除 ${f}`); } catch { /* 忽略 */ }
  }
  // 清掉空的 .claude\
  const claudeDir = path.join(projectDir, ".claude");
  if (!args.dryRun && exists(claudeDir)) {
    try { if (!fs.readdirSync(claudeDir).length) { fs.rmdirSync(claudeDir); add("ok", "remove", "已删除空的 .claude\\"); } }
    catch { /* 忽略 */ }
  }
  // 撤掉自己往 .gitignore 里加的运行时产物行。
  // 为什么必须做：交付前要跑纯净度自检（purity-check.mjs），它把「项目里还出现 .harness 字样」判为残留 ——
  // 而 .gitignore 里那两行正是**这个脚本自己写进去的**。不撤掉就会出现「脚手架删干净了、自检却不过」的假残留。
  stripGitignore({ args, projectDir, add });
  add("info", "remove-note",
    "只撤销机制层（.claude\\）。规则文件（CLAUDE.md/AGENTS.md/.trae）与 .harness\\ 属于内置脚本的范围，" +
    "由 内置\\scripts\\cleanup.ps1 负责。");
  return { acts, projectDir, removed };
}

/** 撤掉 scaffold-ext 写进 .gitignore 的那几行（保留用户自己的其它规则） */
function stripGitignore({ args, projectDir, add }) {
  const gi = path.join(projectDir, ".gitignore");
  const cur = readText(gi);
  if (cur === null) return;
  const lines = cur.split(/\r?\n/);
  const kept = lines.filter((l) => {
    const t = l.trim();
    return t !== GI_MARK && !GI_LINES.includes(t);
  });
  // 尾部多余空行收拾干净
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  if (kept.length === lines.length) return; // 没有本脚本写的行
  if (args.dryRun) { add("info", "gitignore", "（预演）将撤掉 .gitignore 里的 .harness/ 与 .claude/state/ 行"); return; }
  try {
    if (kept.length === 0) {
      fs.rmSync(gi, { force: true });
      add("ok", "gitignore", "已删除只剩 harness 行的 .gitignore");
    } else {
      fs.writeFileSync(gi, kept.join("\n") + "\n", "utf8");
      add("ok", "gitignore", "已撤掉 .gitignore 里的 .harness/ 与 .claude/state/ 行（用户自己的规则保留）");
    }
  } catch (err) {
    add("fail", "gitignore", `撤 .gitignore 行失败：${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────

const ICON = { ok: "✅", info: "ℹ️ ", warn: "⚠️ ", fail: "❌" };

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + "\n"); return 0; }

  const res = run(args);
  if (res.fatal) {
    process.stderr.write(`❌ 拒绝执行：${res.fatal}\n`);
    return 2;
  }

  const acts = res.acts ?? [];
  const fails = acts.filter((a) => a.level === "fail").length;
  const warns = acts.filter((a) => a.level === "warn").length;

  if (args.json) {
    process.stdout.write(JSON.stringify({
      mode: args.remove ? "remove" : args.check ? "check" : args.dryRun ? "dry-run" : "apply",
      engine: args.engine ?? null,
      rules: args.rules,
      project: res.projectDir,
      masterHooks: res.masterHooks,
      autoCompactWindow: res.window ?? null,
      hooks: res.hookStat ?? null,
      settings: res.settingsStat ?? null,
      rules: res.ruleStat ?? null,
      actions: acts,
      summary: { fail: fails, warn: warns },
    }, null, 2) + "\n");
    return fails > 0 || warns > 0 ? 1 : 0;
  }

  if (args.quiet) {
    process.stdout.write(
      `scaffold-ext：${fails} 项失败、${warns} 项待处理（项目 ${res.projectDir}）\n`);
    return fails > 0 || warns > 0 ? 1 : 0;
  }

  const out = [];
  out.push("");
  out.push("═".repeat(70));
  out.push(args.check ? "  scaffold-ext · 一致性检查（没有写任何文件）"
    : args.remove ? "  scaffold-ext · 撤销机制层"
    : args.dryRun ? "  scaffold-ext · 预演（没有写任何文件）"
    : "  scaffold-ext · 项目脚手架扩展");
  out.push("═".repeat(70));
  out.push(`项目目录   ${res.projectDir}`);
  if (res.masterHooks) out.push(`hook 主副本 ${res.masterHooks}`);
  if (res.window) out.push(`压缩上限   autoCompactWindow = ${res.window.value}（来源：${res.window.source}）`);
  out.push("");
  for (const a of acts) {
    out.push(`${ICON[a.level]} [${a.id}] ${a.text}`);
  }
  out.push("");
  out.push("─".repeat(70));
  const hookless = res.installHooks === false;
  if (!fails && !warns) {
    out.push(args.check
      ? (hookless ? "✅ 项目规则文件与模板一致（本引擎不用 .claude\\ 机制层）。"
                  : "✅ 项目内机制层与主副本一致。")
      : (hookless
          ? `✅ 完成。项目规则文件已就位（引擎 ${res.engineKey} 不装 .claude\\ 机制层 —— hooks 是 Claude Code 专属，其它引擎看 自定义\\引擎适配\\）。`
          : `✅ 完成。项目内机制层已就位：在 ${res.projectDir} 内启动的会话会加载 .claude\\settings.json。`));
  } else {
    out.push(`${fails ? "❌" : "⚠️ "} ${fails} 项失败、${warns} 项待处理。`);
  }
  if (!args.check && !args.dryRun) {
    out.push("");
    out.push("下一步：");
    if (!hookless) out.push("  · 在项目目录内启动引擎，机制层就会生效（终端模式下 cwd 就是项目目录）");
    out.push("  · 命令包装（U4）由 run.ps1 / run.sh 前置 PATH 生效，任何引擎都适用");
    out.push(`  · 会话后审计：node AI-Dev-Harness\\自定义\\scripts\\audit.mjs --project ${res.projectDir}`);
    out.push(`  · 想核对一致性：node AI-Dev-Harness\\自定义\\scripts\\scaffold-ext.mjs --check --project ${res.projectDir}`);
  }
  out.push("─".repeat(70));
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  return fails > 0 || warns > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`[scaffold-ext] 出错：${err.message}\n${err.stack}\n`);
  process.exitCode = 2;
}
