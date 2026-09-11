#!/usr/bin/env node
/**
 * build-prompt.mjs —— 启动词拼装器（U2 启动词注入）
 * ============================================================
 * 作用：给 run.ps1 / run.sh 生成「引擎无关」的启动词。
 *       启动词里**内联** 40 行硬规则，不依赖模型自己去读规则文件。
 *
 * 为什么放在这里（而不是内置/）：
 *   遵守 AGENTS.md 铁律「不要修改 AI-Dev-Harness\内置\」。
 *
 * 为什么这是通用性最强的一招：
 *   $prompt 是 harness 自己拼的字符串，跟引擎完全无关。
 *   Codex / Claude Code / DeepSeek Harness / TraeCode 拿到的都是同一个启动词。
 *   尤其对 DeepSeek Harness —— 它没有自动读取 AGENTS.md 的机制，
 *   本脚本是它**唯一**的规则入口。
 *
 * 用法：
 *   node build-prompt.mjs --engine claude-code --goal "做一个待办应用"
 *   node build-prompt.mjs --engine codex-cli --goal "..." --phase 0
 *   node build-prompt.mjs --engine dsh --goal "..." --out .harness\exec-prompt.md
 *   node build-prompt.mjs --engine claude-code --goal "..." --single-line
 *   node build-prompt.mjs --stats --engine claude-code --goal "x"
 *   node build-prompt.mjs --list-engines
 *
 * --single-line 为什么存在（Windows 关键约束）：
 *   PowerShell 调 `codex` / `claude` / `dsh` 时，实际执行的是 npm 生成的
 *   `*.cmd` 垫片，而垫片用 `%*` 转发参数 —— cmd.exe 会把换行当成命令分隔符，
 *   于是**多行启动词在第一个换行处被截断**，40 条硬规则只剩第一行。
 *   所以 Windows 侧（run.ps1）必须用 --single-line，把启动词压成一行。
 *   bash 侧（run.sh）传参不受此限，可保留多行。
 *
 * 输出：启动词写入 stdout（UTF-8）。错误写 stderr，非零退出。
 * 依赖：无（只用 node 内置模块）。
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // ...\自定义\scripts
const HARNESS_ROOT = path.resolve(SCRIPT_DIR, "..", "..");       // ...\AI-Dev-Harness
const TEMPLATE_DIR = path.join(HARNESS_ROOT, "自定义", "prompt-模板");

const KNOWN_ENGINES = ["codex-cli", "claude-code", "deepseek-harness", "traecode-cli"];

/** 引擎名别名 → 模板文件名 */
const ENGINE_ALIAS = {
  codex: "codex-cli",
  "codex-cli": "codex-cli",
  claude: "claude-code",
  "claude-code": "claude-code",
  dsh: "deepseek-harness",
  "deepseek-harness": "deepseek-harness",
  traecode: "traecode-cli",
  "traecode-cli": "traecode-cli",
};

/** 读模板文件；自动去掉 BOM，统一换行为 \n */
function readTemplate(...segs) {
  const file = path.join(TEMPLATE_DIR, ...segs);
  if (!fs.existsSync(file)) return null;
  return fs
    .readFileSync(file, "utf8")
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "");
}

/**
 * 「上次会话审计」段（U3 → U2 的闭环）。
 * 读审计脚本（audit.mjs）留下的 <项目>\.harness\audit-latest.json，
 * 把高危/中等问题摘要注入启动词 —— 下一次会话一开头就知道上次哪里没守规矩。
 * 只认 7 天内的报告；读不到、过期、格式不对都静默跳过（fail-open，绝不影响启动）。
 */
function auditSection(maxAgeDays = 7) {
  const f = path.resolve(process.cwd(), ".harness", "audit-latest.json");
  let j;
  try {
    j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch {
    return "";
  }
  const ts = Date.parse(j.generatedAt || "");
  if (!Number.isFinite(ts)) return "";
  if (Date.now() - ts > maxAgeDays * 86400 * 1000) return "";

  const c = j.counts || {};
  const bad = (j.findings || [])
    .filter((x) => x.severity === "high" || x.severity === "medium")
    .slice(0, 4);
  const lines = [
    "**上次会话审计**（由 audit.mjs 生成，启动时自动注入）",
    `- 时间：${j.generatedAtLocal || j.generatedAt}　命令记录 ${j.commandEntries ?? "?"} 条　改动文件 ${(j.changedFiles || []).length} 个`,
    `- 高危 ${c.high ?? 0} / 中 ${c.medium ?? 0} / 低 ${c.low ?? 0} / 提示 ${c.info ?? 0}`,
  ];
  if (bad.length) {
    lines.push("- 需要留意的问题：");
    for (const x of bad) {
      lines.push(`  - [${x.severity === "high" ? "高危" : "中"}] ${x.title}`);
    }
  } else {
    lines.push("- 没有高危/中等问题。");
  }
  lines.push(
    "- 完整报告：`.harness\\audit-latest.md`（运行态，供本次注入用）；" +
      "本次会话收尾时再跑一次 `audit.mjs` 刷新它，历史报告按时间戳留在工作区根的 `日志\\07-审计\\`。",
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { engine: "claude-code", goal: "", phase: null, stats: false, out: null, singleLine: false, noAudit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    switch (a) {
      case "--engine": case "-e": out.engine = next(); break;
      case "--goal":   case "-g": out.goal = next(); break;
      case "--phase":  case "-p": out.phase = next(); break;
      case "--out":    case "-o": out.out = next(); break;
      case "--stats":             out.stats = true; break;
      case "--single-line":       out.singleLine = true; break;
      case "--no-audit":          out.noAudit = true; break;
      case "--list-engines":      out.listEngines = true; break;
      case "--help":   case "-h": out.help = true; break;
      default:
        // 容错：允许最后跟一个裸目标字符串
        if (!a.startsWith("-") && !out.goal) out.goal = a;
        else throw new Error(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  return out;
}

const USAGE = `用法：node build-prompt.mjs --engine <引擎> --goal "<用户目标>" [选项]

选项：
  --engine, -e <名>   引擎名：${KNOWN_ENGINES.join(" | ")}（别名：codex / claude / dsh / traecode）
  --goal,   -g <文本> 用户目标（项目要做什么）
  --phase,  -p <n>    从哪个阶段开始（默认 0）
  --out,    -o <路径> 同时把启动词写入文件（UTF-8）
  --single-line       把启动词压成一行（Windows 走 cmd.exe 垫片时必须加，否则会被截断）
  --no-audit          不注入「上次会话审计」摘要（默认会读 <cwd>\\.harness\\audit-latest.json）
  --stats             把统计信息打印到 stderr（硬规则行数等）
  --list-engines      列出已知引擎
  --help,   -h        显示本帮助

说明：未知引擎不会报错——仍会注入完整的 40 行硬规则，只是不带引擎特化段。`;

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { process.stdout.write(USAGE + "\n"); return 0; }
  if (args.listEngines) { process.stdout.write(KNOWN_ENGINES.join("\n") + "\n"); return 0; }

  // ---- 1. 硬规则（核心，必须存在）----
  const rules = readTemplate("硬规则.md");
  if (!rules) {
    process.stderr.write(
      `[build-prompt] 找不到硬规则模板：${path.join(TEMPLATE_DIR, "硬规则.md")}\n` +
      `[build-prompt] 请确认 AI-Dev-Harness\\自定义\\prompt-模板\\ 是否完整。\n`
    );
    return 1;
  }
  const rulesLines = rules.split("\n").length;

  // ---- 2. 引擎特化段（缺失不致命）----
  const engineKey = ENGINE_ALIAS[String(args.engine).toLowerCase()] ?? null;
  let engineSection = "";
  if (engineKey) {
    engineSection = readTemplate("引擎", `${engineKey}.md`) ?? "";
  } else {
    process.stderr.write(
      `[build-prompt] 未识别的引擎「${args.engine}」——仍会注入 ${rulesLines} 行硬规则，但无引擎特化段。\n`
    );
  }

  // ---- 3. 基础骨架 ----
  const skeleton = readTemplate("基础.md");
  if (!skeleton) {
    process.stderr.write(
      `[build-prompt] 找不到骨架模板：${path.join(TEMPLATE_DIR, "基础.md")}\n`
    );
    return 1;
  }

  const goal = args.goal && args.goal.trim()
    ? args.goal.trim()
    : "（用户未提供，请先用中文询问「你想做什么项目？」）";
  const phase = args.phase === null ? 0 : Number(args.phase);
  const phaseLine = Number.isFinite(phase) && phase > 0
    ? `从阶段 ${phase} 开始。`
    : "";

  // ---- 4. 上次会话审计（U3 → U2 闭环；读不到就是空串）----
  const audit = args.noAudit ? "" : auditSection();

  let prompt = skeleton
    .replaceAll("{{硬规则}}", rules)
    .replaceAll("{{目标}}", goal)
    .replaceAll("{{阶段}}", phaseLine)
    .replaceAll("{{引擎补充}}", engineSection)
    .replaceAll("{{审计}}", audit);

  // 清掉占位符被替换成空串后产生的多余空行
  prompt = prompt.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");

  if (args.singleLine) {
    // 压成一行：cmd.exe 的 %* 会在换行处截断，Windows 侧必须走这条路
    prompt = prompt.replace(/[ \t]*\n[ \t]*/g, " ").replace(/ {2,}/g, " ").trim();
  } else {
    prompt += "\n";
  }

  process.stdout.write(prompt);

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, prompt, "utf8");
    process.stderr.write(`[build-prompt] 已写入：${outPath}\n`);
  }

  if (args.stats) {
    process.stderr.write(
      `[build-prompt] 引擎=${engineKey ?? args.engine + "(未知)"}` +
      ` 硬规则=${rulesLines} 行` +
      ` 引擎特化=${engineSection ? "有" : "无"}` +
      ` 启动词总长=${prompt.length} 字符 / ${prompt.split("\n").length - 1} 行\n`
    );
  }

  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`[build-prompt] 出错：${err.message}\n`);
  process.exitCode = 1;
}
