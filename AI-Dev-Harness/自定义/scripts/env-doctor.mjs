#!/usr/bin/env node
/**
 * env-doctor.mjs —— 环境体检主入口（A11 · L0 第①档）
 * ============================================================
 * 一条命令，替代用户手写 15–20 行长提示词。
 *
 * 它检查什么（对应 02-逐项改动清单.md 的 A11 检查清单）：
 *   1. 模型名含 [1M]        → 压缩阈值被抬到 96.7 万（历史事故根因）→ 警告 + 给修复值
 *   2. autoCompactWindow    → 未设 / 与能力画像不符 → 给建议值
 *   3. hooks 未注册         → 机制轨失效 → 提示
 *   4. 规则模板仍是 8 行旧版 → 协议不会被加载 → 提示升级
 *   5. 上次的 HANDOFF.md    → 有未完成工作 → 摘要内联进启动词
 *   6. 明文 API key         → 安全风险 → 提醒轮换（只报字段名，绝不打印值）
 *   7. 项目内 hooks 与主副本版本不一致 → 可能失效 → 提示同步
 *
 * ★ 边界（决策 4 / 5）：
 *   - 默认**只提示**，不动任何文件。
 *   - `--fix` 必须显式调用，且**只写工作区根/项目级**的 `.claude/settings.json`。
 *   - **绝不写用户级 `~/.claude/settings.json`**；只读侦察，且只报告字段名不报告值。
 *
 * 退出码：0 = 没有需要处理的问题；1 = 有需要处理的问题；2 = 脚本自身出错。
 *
 * 用法：
 *   node env-doctor.mjs                        # 体检 + 打印可粘贴的启动词
 *   node env-doctor.mjs --json                 # 机器可读（供 hooks / policy.mjs 用）
 *   node env-doctor.mjs --goal "做一个待办应用"
 *   node env-doctor.mjs --engine codex-cli
 *   node env-doctor.mjs --fix                  # 显式修复（只写非用户级 settings）
 *
 * 依赖：无（只用 node 内置模块）。
 *
 * 第 2 段（日志中心）：每次体检追加一段到**工作区根** `日志\06-引擎\env-doctor-<日期>.log`
 * （含引擎、模型、压缩上限、严格度、逐项结果）。只追加、写失败只出声，不影响体检本身。
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FILES as LOG_FILES,
  appendSection,
  resolveLogRoot,
  stampCompact,
} from "./lib/log-center.mjs";
import {
  DEFAULT_HARNESS_ROOT,
  DEFAULT_WORK_ROOT,
  TABLE_REL_PATH,
  endpointHost,
  resolveCapability,
  inspectUserSettings,
} from "./lib/model-capability.mjs";
import {
  detectEngine as detectEngineById,
  engineChoiceList,
  stateDir as harnessStateDir,
} from "./lib/engine-detect.mjs";

/** 体检结论落一段到 日志\06-引擎\env-doctor-<日期>.log（含"本次实际引擎"与机制层状态） */
function logEngineCheck(args, info, engineName, det, failures, warnings) {
  try {
    const ICONS = { ok: "✅", info: "ℹ️", warn: "⚠️", fail: "❌" };
    const lines = [
      `- 工作区根：${args.root}`,
      `- 项目目录：${info.projectDir}`,
      `- 引擎：${engineName}${det.via ? `（探测方式：${det.via}）` : ""}`,
      `- 模型：${info.cap.declaredName} · ${info.cap.modelId} · 来源 ${info.cap.source}`,
      `- 压缩上限：autoCompactWindow=${info.cap.capabilities.autoCompactWindow}` +
        `（阈值≈${info.cap.capabilities.compactionThreshold} token）· 严格度=${info.cap.capabilities.hookStrictness}`,
      `- 体检：${info.checks.length} 项（必须处理 ${failures} / 建议处理 ${warnings}）`,
      "",
      ...info.checks.map(
        (c) => `${ICONS[c.level] ?? "·"} [${c.id}] ${c.title}${c.detail ? `\n     ${c.detail}` : ""}`,
      ),
    ];
    appendSection("engine", LOG_FILES.envDoctor(), `开工体检 ${stampCompact()}`, lines.join("\n"), {
      logRoot: resolveLogRoot(),
    });
  } catch {
    /* fail-open */
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUILD_PROMPT = path.join(SCRIPT_DIR, "build-prompt.mjs");

// ────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    engine: "auto", goal: "", root: DEFAULT_WORK_ROOT, project: null,
    harnessRoot: DEFAULT_HARNESS_ROOT, json: false, fix: false, quiet: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    switch (a) {
      case "--engine": case "-e":        o.engine = next(); break;
      case "--goal": case "-g":          o.goal = next(); break;
      case "--root":                     o.root = path.resolve(next()); break;
      case "--project":                  o.project = path.resolve(next()); break;
      case "--harness-root":             o.harnessRoot = path.resolve(next()); break;
      case "--json":                     o.json = true; break;
      case "--fix":                      o.fix = true; break;
      case "--quiet": case "-q":         o.quiet = true; break;
      case "--help": case "-h":          o.help = true; break;
      default: throw new Error(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  // 第 5 批：**在项目目录内跑体检时，项目就是 cwd**。
  // 这是终端模式的主路径（run.ps1 Set-Location 到项目再启动引擎），
  // 不自动识别的话，项目内的 .claude\ 会被整个漏掉（第 2 批实测：父目录 settings 不被继承）。
  if (!o.project) {
    try {
      const cwd = path.resolve(process.cwd());
      const root = path.resolve(o.root);
      if (cwd !== root && cwd.startsWith(root + path.sep)) o.project = cwd;
    } catch { /* 识别失败就当没给 --project，行为与改造前一致 */ }
  }
  return o;
}

const USAGE = `env-doctor.mjs —— 环境体检主入口（默认只提示，不动任何文件）

  node env-doctor.mjs [--goal "<项目目标>"] [--engine <引擎>] [--json]
  node env-doctor.mjs --fix        ← 显式修复（只写非用户级 settings）

选项：
  --goal,   -g <文本>   启动词里的项目目标
  --engine, -e <引擎>   codex-cli | claude-code | deepseek-harness | traecode-cli（默认 auto）
  --root <路径>         工作区根（默认 = AI-Dev-Harness 的上级）
  --project <路径>      项目目录（默认 = 工作区根）
  --harness-root <路径> AI-Dev-Harness 所在目录（测试用）
  --json                输出机器可读 JSON（供 hooks / policy.mjs 消费）
  --fix                 显式修复：合并写入 .claude/settings.json 的 autoCompactWindow
                        （含 .bak 备份；绝不写用户级 ~/.claude/settings.json）
  --quiet, -q           只输出启动词

退出码：0 = 没问题；1 = 有需要处理的问题；2 = 脚本自身出错。`;

// ────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; }
}

function readTextSafe(file) {
  try { return fs.readFileSync(file, "utf8").replace(/^﻿/, ""); } catch { return null; }
}

/**
 * 探测本次会话的引擎。
 * ★ 第 3 段（P2-5）：改走统一解析器（engine-detect.mjs → resolve-command.mjs）。
 *   旧实现自己扫 PATH、且把**空扩展名排第一** —— 与包装器两套规则，
 *   实测后果是「引擎装了却被探成没装」。现在一律以 engine-detect 为准，
 *   并且优先沿用 run.bat 记下来的「上次选择」（锁定决策 10），保证启动时打印的引擎
 *   和体检时认定的引擎是同一个。
 */
function detectEngine() {
  const c = engineChoiceList();
  // 优先级：上次实际启动用的引擎（且现在仍然可用）→ 列表默认项 → null
  const pick = c.lastUsable ?? c.default ?? null;
  if (!pick) return { engine: null, bin: null, via: null, available: c.available.map((d) => d.id) };
  const det = detectEngineById(pick);
  if (!det.installed) return { engine: null, bin: null, via: null, available: c.available.map((d) => d.id) };
  return {
    engine: det.id,
    bin: det.path,
    via: `${det.via}${c.lastUsable === det.id ? "（上次 run 用的引擎）" : "（默认项）"}`,
    kind: det.kind,
    available: c.available.map((d) => d.id),
  };
}

const fmt = (n) => Number(n).toLocaleString("en-US");

// ────────────────────────────────────────────────────────────
// 体检
// ────────────────────────────────────────────────────────────

function runChecks(args) {
  const checks = [];
  const add = (level, id, title, detail, action) => checks.push({ level, id, title, detail, action });
  // level: ok | info | warn | fail

  const projectDir = args.project ?? args.root;
  const userSettings = inspectUserSettings();

  // ---- 0. 当前模型与能力解析 ----
  const modelName = process.env.ANTHROPIC_MODEL
    || userSettings.modelFields[0]?.value
    || "unknown-model";
  const endpointUrl = process.env.ANTHROPIC_BASE_URL || userSettings.baseUrl || "";
  const cap = resolveCapability({
    harnessRoot: args.harnessRoot,
    modelName,
    endpoint: endpointUrl || endpointHost(""),
  });

  // ---- 1. [1M] 陷阱（P2-1：双来源都必须查）----
  // 旧实现只盯环境变量 ANTHROPIC_MODEL：在没有该变量的 shell 里，
  // 它会退化成读 settings.json 的 model 字段，于是**明明有 [1M] 也报绿灯**（实测踩过）。
  // 现在把两个来源都扫一遍：
  //   ① 环境变量 ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL（用户可能在 shell / 启动器里设的）
  //   ② ~/.claude/settings.json 的 model 字段与 env.ANTHROPIC_*MODEL*（inspectUserSettings 只读侦察）
  // 任何一处命中都算命中，并在输出里点名是**哪一处**——否则用户不知道该删哪个。
  const suffixSources = [];
  const envModelKeys = ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
  for (const k of Object.keys(process.env)) {
    if (!/^ANTHROPIC_.*MODEL$/.test(k)) continue;
    if (!envModelKeys.includes(k)) envModelKeys.push(k);
  }
  for (const k of envModelKeys) {
    const v = process.env[k];
    if (v && /\[1m\]/i.test(v)) suffixSources.push(`环境变量 ${k} = ${v}`);
  }
  for (const h of userSettings.suffixHits) suffixSources.push(`~/.claude/settings.json 的 ${h.key} = ${h.value}`);
  // ★ 权威判定交给能力层：它按「声明的模型名」判 hasBannedSuffix，并且已经把窗口压回保守值。
  //   这里额外的价值是：即使模型名解析用的那一个字段恰好不带 [1M]，只要**任一处**带，也要出声。
  const suffixHit = suffixSources.length > 0;

  if (cap.capabilities.hasBannedSuffix || suffixHit) {
    add("fail", "1M", "模型名带 [1M] 后缀 —— 这就是历史事故的根因",
      `模型：${cap.declaredName}\n` +
      `     引擎声明的窗口是 ${fmt(cap.capabilities.declaredWindow)}，压缩阈值会被抬到 ${fmt(cap.capabilities.declaredWindow - 33000)}。\n` +
      `     对第三方模型，[1M] 只做本地记账、不发 beta header，服务端完全不知情 —— 等于"我说我有多大就有多大"。\n` +
      (suffixSources.length ? "     来源：\n" + suffixSources.map((s) => `       · ${s}`).join("\n") : ""),
      `本脚本已按保守值把它压回来：autoCompactWindow = ${fmt(cap.autoCompactWindow)}（阈值 ≈ ${fmt(cap.capabilities.compactionThreshold)}）。\n` +
      `     根治办法（需要你手动做，本工具不碰用户级配置）：把 ~/.claude/settings.json 里\n` +
      `     ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL 的 [1M] 后缀删掉。\n` +
      `     想自动压住：node env-doctor.mjs --fix（只写 ${path.join(projectDir, ".claude", "settings.json")}）`);
  } else {
    add("ok", "1M", "模型名没有 [1M] 后缀（环境变量 + ~/.claude/settings.json 两处都查了）",
      `模型：${cap.declaredName}\n     查过的环境变量：${envModelKeys.join(" / ")}\n` +
      `     settings.json 里扫到 ${userSettings.modelFields.length} 个模型名字段，均无 [1M]`, "");
  }

  // ---- 2. autoCompactWindow ----
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  const projectSettings = readJsonSafe(settingsPath);
  const want = cap.autoCompactWindow;
  const envWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

  if (envWindow) {
    add("info", "acw-env", `环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW = ${envWindow}`,
      "环境变量优先级高于 settings.json。", "");
  }
  if (!projectSettings) {
    add("warn", "acw", "项目级 .claude/settings.json 不存在 → autoCompactWindow 未设置",
      `期望路径：${settingsPath}\n     不设的话，压缩上限就完全由模型名决定 —— 带上 [1M] 就是 96.7 万。`,
      cap.capabilities.bannedOverride
        ? `必须补上 autoCompactWindow = ${fmt(want)}。跑 node env-doctor.mjs --fix 可自动写入（第 2 批还会往里加 hooks）。`
        : `建议写入 autoCompactWindow = ${fmt(want)}。`);
  } else if (Number(projectSettings.autoCompactWindow) === want) {
    add("ok", "acw", `autoCompactWindow 已设为 ${fmt(want)}`,
      `实际压缩阈值 ≈ ${fmt(want - 33000)} token。`, "");
  } else if (Number.isFinite(Number(projectSettings.autoCompactWindow))) {
    const cur = Number(projectSettings.autoCompactWindow);
    add(cur > want ? "warn" : "info", "acw",
      `autoCompactWindow = ${fmt(cur)}，与建议值 ${fmt(want)} 不一致`,
      `当前阈值 ≈ ${fmt(cur - 33000)}；建议阈值 ≈ ${fmt(want - 33000)}。`,
      cur > want ? `建议降到 ${fmt(want)}（更省、更不容易让上下文滚大）。` : "比建议值更保守，可以不动。");
  } else {
    add("warn", "acw", "项目级 settings.json 存在，但没有 autoCompactWindow 键",
      `路径：${settingsPath}`, `建议补上 ${fmt(want)}。`);
  }

  // ---- 3. hooks 未注册 ----
  const hooksKey = readJsonSafe(settingsPath)?.hooks;
  const rootHooksPath = path.join(args.root, ".claude", "settings.json");
  const rootHooks = args.root === projectDir ? hooksKey : readJsonSafe(rootHooksPath)?.hooks;
  const hooksEvents = rootHooks && typeof rootHooks === "object" ? Object.keys(rootHooks) : [];
  if (!hooksEvents.length) {
    add("warn", "hooks", "hooks 未注册 → 机制轨失效（拦截 / 输出整形 / 压缩指令全都不生效）",
      `检查过：${rootHooksPath}${args.root !== projectDir ? ` 和 ${settingsPath}` : ""}`,
      args.root !== projectDir
        ? `项目内机制层没生成。补上：node AI-Dev-Harness\\自定义\\scripts\\scaffold-ext.mjs --project "${projectDir}"（第 5 批 · A13）`
        : "工作区根的 .claude\\settings.json 缺 hooks 键（第 2 批的交付物）。");
  } else {
    add("ok", "hooks", `hooks 已注册 ${hooksEvents.length} 个事件`, hooksEvents.join(", "), "");
  }

  // ---- 4. 规则模板行数 ----
  const tplDir = path.join(args.harnessRoot, "自定义", "项目规则模板");
  const tpls = ["CLAUDE.template.md", "AGENTS.template.md", "trae-project_rules.template.md"]
    .map((n) => ({ n, p: path.join(tplDir, n) }))
    .filter((t) => fs.existsSync(t.p));
  const thin = tpls.filter((t) => (readTextSafe(t.p) ?? "").split("\n").length < 30);
  if (!tpls.length) {
    add("info", "tpl", "没找到项目规则模板", `目录：${tplDir}`, "");
  } else if (thin.length) {
    add("warn", "tpl", `${thin.length}/${tpls.length} 个项目规则模板仍是「只让模型去读协议」的薄版本`,
      thin.map((t) => `· ${t.n}：${(readTextSafe(t.p) ?? "").split("\n").length} 行`).join("\n     "),
      "实测：模型不会去读被引用的文件，所以协议从未被加载。第 4 批会把模板扩到 40 行并内联硬规则。");
  } else {
    add("ok", "tpl", `项目规则模板已是内联版本（${tpls.length} 份）`, "", "");
  }

  // ---- 5. HANDOFF ----
  const handoffCandidates = [
    path.join(projectDir, ".harness", "HANDOFF.md"),
    path.join(args.root, ".harness", "HANDOFF.md"),
  ];
  const handoffPath = handoffCandidates.find((p) => fs.existsSync(p));
  let handoffSummary = "";
  if (handoffPath) {
    handoffSummary = (readTextSafe(handoffPath) ?? "").split("\n").slice(0, 20).join("\n").trim();
    add("info", "handoff", "存在上次的 HANDOFF.md → 有未完成的工作",
      `路径：${handoffPath}`, "已把摘要内联进下面的启动词。");
  } else {
    add("ok", "handoff", "没有遗留的 HANDOFF.md", "", "");
  }

  // ---- 6. 明文密钥 ----
  if (userSettings.secretFields.length) {
    add("warn", "secret", "用户级 settings.json 里存在明文凭据字段",
      `字段名（只报名字，不打印值）：${userSettings.secretFields.join(", ")}\n     文件：${userSettings.file}`,
      "历史记录里这些值曾被发现随进程信息打印过，强烈建议轮换。本工具不读取、不打印、不修改这些值。");
  } else if (!userSettings.exists) {
    add("info", "secret", "没找到用户级 settings.json", userSettings.file, "");
  } else {
    add("ok", "secret", "用户级 settings.json 里没发现明文凭据字段", "", "");
  }

  // ---- 7. hooks 版本一致性（项目副本 vs 主副本）----
  // 第 5 批：这是「项目内 hooks 与主副本版本漂移」的兜底检查（04 文档第 5 批的风险项）。
  // 同步工具是 自定义\scripts\scaffold-ext.mjs（A13）；这里只报告并给出确切命令。
  const masterHooks = path.join(args.root, ".claude", "hooks");
  const projHooks = path.join(projectDir, ".claude", "hooks");
  const syncCmd = `node AI-Dev-Harness\\自定义\\scripts\\scaffold-ext.mjs --project "${projectDir}"`;
  const inProject = args.root !== projectDir;

  if (inProject && fs.existsSync(masterHooks) && fs.existsSync(projHooks)) {
    const drift = compareDirShallow(projHooks, masterHooks);
    if (drift.length) {
      add("warn", "drift", `项目内 hooks 与主副本不一致（${drift.length} 处）`, drift.join("\n     "),
        `可能失效——项目里跑的是旧版 hook。同步：${syncCmd}`);
    } else {
      add("ok", "drift", "项目内 hooks 与主副本逐字节一致", "", "");
    }
  } else if (inProject && fs.existsSync(masterHooks) && !fs.existsSync(projHooks)) {
    add("warn", "drift", "项目内没有 .claude\\hooks → 项目内会话不受机制层保护",
      `主副本：${masterHooks}\n     项目：${projHooks}`,
      `生成：${syncCmd}（第 5 批 · A13）`);
  } else {
    add("info", "drift", "hooks 版本一致性检查已跳过（主副本或项目副本尚不存在）",
      `主副本：${masterHooks}`, "工作区根开会话时不需要一致性检查。");
  }

  return { checks, cap, modelName, endpointUrl, projectDir, settingsPath, handoffSummary, userSettings };
}

/** 浅比较两层目录（hooks/ 下通常是 lib/ + 若干 mjs）。 */
function compareDirShallow(a, b) {
  const drift = [];
  const walk = (dir, prefix = "") => {
    let out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), path.join(prefix, e.name)));
      else if (e.name.endsWith(".mjs") || e.name.endsWith(".js") || e.name.endsWith(".json")) {
        out.push(path.join(prefix, e.name));
      }
    }
    return out;
  };
  let relA = [], relB = [];
  try { relA = walk(a); } catch { /* 忽略 */ }
  try { relB = walk(b); } catch { /* 忽略 */ }
  for (const r of relA) {
    if (!relB.includes(r)) { drift.push(`· 主副本缺 ${r}`); continue; }
    const ha = readTextSafe(path.join(a, r)) ?? "";
    const hb = readTextSafe(path.join(b, r)) ?? "";
    if (ha !== hb) drift.push(`· 内容不同：${r}`);
  }
  for (const r of relB) if (!relA.includes(r)) drift.push(`· 项目副本缺 ${r}`);
  return drift;
}

// ────────────────────────────────────────────────────────────
// 启动词
// ────────────────────────────────────────────────────────────

function buildStartupPrompt(args, info, engineName) {
  const cap = info.cap;
  const c = cap.capabilities;

  // 复用第 0 批的 build-prompt.mjs：硬规则是唯一真源，本脚本只做「补充段」
  let base = "";
  const r = spawnSync(process.execPath, [
    BUILD_PROMPT, "--engine", engineName, "--goal", args.goal || "", "--single-line",
  ], { encoding: "utf8" });
  if (r.status === 0 && r.stdout) {
    base = r.stdout.trim();
  } else {
    base = `(启动词生成失败：${path.join("自定义", "scripts", "build-prompt.mjs")} —— ${(r.stderr ?? "").trim().slice(0, 200)})`;
  }

  const supplement = [
    `【harness 体检补充】`,
    `- 当前模型：${cap.declaredName}（归一化 ${cap.modelId}）`,
    `- 压缩上限：autoCompactWindow = ${c.autoCompactWindow}，实际阈值 ≈ ${c.compactionThreshold} token`,
    `- 能力档位：${c.hookStrictness}（instructionFollowing=${c.instructionFollowing}）`,
    c.hasBannedSuffix ? `- ⚠️ 模型名带 [1M] 后缀，声明窗口 ${c.declaredWindow} 不可信，已按保守值压回` : null,
    `- 上下文纪律：单会话上下文不要超过压缩阈值的 70%；接近就该收尾并开新会话`,
    info.handoffSummary ? `\n【上次交接摘要】\n${info.handoffSummary}` : null,
  ].filter(Boolean).join("\n");

  return { supplement, base, full: `${supplement}\n\n${base}` };
}

// ────────────────────────────────────────────────────────────
// --fix
// ────────────────────────────────────────────────────────────

function applyFix(args, info) {
  const c = info.cap.capabilities;
  const target = path.join(info.projectDir, ".claude", "settings.json");
  const userSettings = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".claude", "settings.json");

  if (path.resolve(target) === path.resolve(userSettings)) {
    return { ok: false, msg: "拒绝执行：目标是用户级 settings.json（决策 4 明确不允许写）。" };
  }

  const existing = readJsonSafe(target);
  const before = existing ? JSON.stringify(existing, null, 2) : null;
  const next = { ...(existing ?? {}) };

  const actions = [];
  if (Number(next.autoCompactWindow) !== c.autoCompactWindow) {
    actions.push(`autoCompactWindow: ${next.autoCompactWindow ?? "(未设)"} → ${c.autoCompactWindow}`);
    next.autoCompactWindow = c.autoCompactWindow;
  }
  // 让文件里的 key 顺序稳定一点，便于日后 diff
  const ordered = { autoCompactWindow: next.autoCompactWindow, ...next };
  if (JSON.stringify(ordered) === JSON.stringify(next) && actions.length === 0) {
    return { ok: true, msg: `无需修改：${target} 已经是 autoCompactWindow = ${c.autoCompactWindow}`, actions: [] };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (before !== null) {
    fs.writeFileSync(`${target}.bak`, before, "utf8");
  }
  fs.writeFileSync(target, JSON.stringify(ordered, null, 2) + "\n", "utf8");

  return {
    ok: true,
    file: target,
    backup: before !== null ? `${target}.bak` : null,
    msg: `已写入 ${target}\n  ` + actions.join("\n  ") +
         (before !== null ? `\n  原文件已备份到 ${target}.bak` : "") +
         `\n  注意：本工具**没有**动用户级 ~/.claude/settings.json（决策 4）。`,
  };
}

// ────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────

const ICON = { ok: "✅", info: "ℹ️ ", warn: "⚠️ ", fail: "❌" };

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + "\n"); return 0; }

  const info = runChecks(args);
  const det = args.engine === "auto" ? detectEngine() : { engine: args.engine, via: "(显式指定)" };
  const engineName = det.engine ?? "claude-code";
  const prompt = buildStartupPrompt(args, info, engineName);
  const fixResult = args.fix ? applyFix(args, info) : null;

  const failures = info.checks.filter((c) => c.level === "fail").length;
  const warnings = info.checks.filter((c) => c.level === "warn").length;

  // 第 2 段（日志中心 · 06-引擎）：无论哪种输出模式，体检结论都留一份档
  logEngineCheck(args, info, engineName, det, failures, warnings);

  if (args.json) {
    process.stdout.write(JSON.stringify({
      engine: engineName,
      engineDetectVia: det.via,
      model: info.cap.declaredName,
      modelId: info.cap.modelId,
      endpoint: info.cap.endpoint,
      capabilitySource: info.cap.source,
      autoCompactWindow: info.cap.capabilities.autoCompactWindow,
      compactionThreshold: info.cap.capabilities.compactionThreshold,
      hookStrictness: info.cap.capabilities.hookStrictness,
      instructionFollowing: info.cap.capabilities.instructionFollowing,
      hasBannedSuffix: info.cap.capabilities.hasBannedSuffix,
      checks: info.checks,
      summary: { fail: failures, warn: warnings, notes: info.cap.notes },
      fix: fixResult,
      startupPrompt: prompt.full,
    }, null, 2) + "\n");
    return failures > 0 ? 1 : 0;
  }

  if (args.quiet) {
    process.stdout.write(prompt.full + "\n");
    return failures > 0 ? 1 : 0;
  }

  const out = [];
  out.push("");
  out.push("═".repeat(70));
  out.push("  harness 环境体检");
  out.push("═".repeat(70));
  out.push(`工作区根   ${args.root}`);
  out.push(`项目目录   ${info.projectDir}`);
  out.push(`引擎       ${engineName}${det.via ? `   （探测方式：${det.via}）` : ""}`);
  out.push(`模型       ${info.cap.declaredName}` +
    (info.cap.capabilities.hasBannedSuffix ? "   ⚠️ 带 [1M] 后缀" : ""));
  out.push(`能力来源   ${info.cap.source}` +
    `   静态表：${path.relative(args.root, path.join(args.harnessRoot, TABLE_REL_PATH)) || TABLE_REL_PATH}`);
  out.push("");
  out.push(`★ 本次会话该用的压缩上限：autoCompactWindow = ${fmt(info.cap.capabilities.autoCompactWindow)}` +
    `（阈值 ≈ ${fmt(info.cap.capabilities.compactionThreshold)} token）`);
  out.push(`  严格度：${info.cap.capabilities.hookStrictness} —— ${info.cap.capabilities.hookStrictnessMeaning}`);
  out.push("");
  out.push("─".repeat(70));
  out.push(`体检结果：${info.checks.length} 项，其中 ${failures} 项必须处理、${warnings} 项建议处理`);
  out.push("─".repeat(70));
  for (const c of info.checks) {
    out.push(`${ICON[c.level]} [${c.id}] ${c.title}`);
    if (c.detail) out.push(`     ${c.detail}`);
    if (c.action) out.push(`     → ${c.action}`);
  }

  if (fixResult) {
    out.push("");
    out.push("─".repeat(70));
    out.push(fixResult.ok ? `✅ --fix ${fixResult.msg}` : `❌ --fix 未执行：${fixResult.msg}`);
  } else if (failures || warnings) {
    out.push("");
    out.push(`（本次只提示，没有改动任何文件。要自动写入压缩上限，显式跑：node env-doctor.mjs --fix）`);
  }

  out.push("");
  out.push("═".repeat(70));
  out.push("  可直接粘贴的启动词（Windows 已压成单行，避免 cmd.exe 在换行处截断）");
  out.push("═".repeat(70));
  out.push(prompt.full);
  out.push("═".repeat(70));
  out.push("提示：probe-model.mjs 可查看/学习模型能力（默认零成本）：");
  out.push("  node probe-model.mjs            # 当前解析结果");
  out.push("  node probe-model.mjs --list     # 全部能力画像");
  out.push(`  node probe-model.mjs --probe    # 只报预估请求数，不联网`);
  out.push("");
  process.stdout.write(out.join("\n") + "\n");

  return failures > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`[env-doctor] 出错：${err.message}\n${err.stack}\n`);
  process.exitCode = 2;
}
