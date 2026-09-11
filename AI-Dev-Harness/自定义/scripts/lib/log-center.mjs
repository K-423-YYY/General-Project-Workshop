#!/usr/bin/env node
/**
 * log-center.mjs —— 日志中心在 **harness 侧**的入口（入口 + 命令行）
 * ============================================================
 * 真正的实现只有一份：`<工作区根>\.claude\hooks\lib\log-center.mjs`
 * （原因见那个文件的头部说明：`.claude\hooks\` 会被 scaffold-ext.mjs 整体同步进项目，
 *  项目内会话的 hooks 需要直接静态 import 到它）。
 *
 * 本文件做三件事：
 *   1. 把主实现的导出**原样转出去**（`export *`）—— harness 侧脚本可以直接
 *      `import { FILES, appendJsonl, appendSection, readCategory, GLOBS } from "./lib/log-center.mjs"`，
 *      既不用写第二份实现，也不可能出现"两边文件名漂移"。
 *   2. 覆盖 `resolveLogRoot()`：harness 侧不靠"从 cwd 向上找"，而是**从自己的位置**推导
 *      （`<AI-Dev-Harness 的上一级>\日志`）—— 这样无论会话在哪个目录里跑，
 *      harness 脚本写日志的位置都确定。环境变量 HARNESS_LOG_ROOT 优先级最高。
 *      调用方要把结果显式传下去：`appendJsonl(cat, file, rec, { logRoot: resolveLogRoot() })`。
 *   3. 给 PowerShell / bash 调用方（`内置\engine\run.ps1`、`run.sh`、`内置\scripts\cleanup.ps1`）
 *      一个命令行：`node log-center.mjs append --category 04-拦截 --file x.jsonl --text '…'`。
 *
 * ★ 谁能承受"哪个文件坏掉"（第 2 段特意分开的两条路）：
 *   · `.claude\hooks\*`      → **静态 import 主实现**：机制层最不能出问题，路径最短最稳；
 *   · harness 工具脚本        → 静态 import 本文件：坏了会立刻报错，且 selftest-ext 先发现文件缺失；
 *   · 命令包装器 `_log.mjs`   → **动态 import + try/catch**：它在每条命令的必经之路上，
 *                              日志中心的任何问题都绝不允许把它带崩（fail-open 的第一优先）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_LIB_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\自定义\scripts\lib
export const HARNESS_ROOT = path.resolve(SCRIPT_LIB_DIR, "..", "..", ".."); // …\AI-Dev-Harness
export const WORK_ROOT = path.resolve(HARNESS_ROOT, ".."); // …\工作区根

const LOG_DIR_NAME = "日志";
const IMPL_REL = path.join("..", "..", "..", "..", ".claude", "hooks", "lib", "log-center.mjs");
export const IMPL_PATH = path.resolve(SCRIPT_LIB_DIR, IMPL_REL); // …\工作区根\.claude\hooks\lib\log-center.mjs

function speak(msg) {
  try {
    process.stderr.write(`[harness] ⚠️ 日志中心：${msg}\n`);
  } catch {
    /* ignore */
  }
}

// ── 主实现原样转出（唯一实现仍在 .claude\hooks\lib\log-center.mjs）
export * from "../../../../.claude/hooks/lib/log-center.mjs";
import * as IMPL from "../../../../.claude/hooks/lib/log-center.mjs";

/**
 * harness 侧能同步确定的日志根。
 * 与主实现的区别：主实现从 **cwd** 推导（会话在项目里跑）；这里从 **harness 自己的位置**推导
 * （工具脚本可能在任意 cwd 下被调用）。两者都会先看 HARNESS_LOG_ROOT，所以启动器一设就统一。
 */
export function resolveLogRoot({ env = process.env, workRoot = WORK_ROOT } = {}) {
  const explicit = env && env.HARNESS_LOG_ROOT;
  if (explicit && String(explicit).trim()) {
    try {
      return path.resolve(String(explicit).trim());
    } catch {
      /* 值非法 → 落到推导 */
    }
  }
  return path.join(workRoot, LOG_DIR_NAME);
}

/**
 * 供 `_log.mjs`（命令包装器）用的容错探针：拿不到主实现就返回 null，调用方跳过写日志。
 * 这里的 try/catch 覆盖不到"本文件顶部的静态 import 失败"（那种情况本模块根本加载不了），
 * 所以 `_log.mjs` 用的是 **动态 import 本文件 + try/catch** —— 两层加起来才真正做到 fail-open。
 */
export async function loadLogCenter() {
  try {
    return IMPL;
  } catch {
    speak(`主实现 ${IMPL_PATH} 不可用 —— 本次不写日志。`);
    return null;
  }
}

/** 布局自检要用：主实现文件是否存在 */
export function implExists() {
  try {
    return fs.existsSync(IMPL_PATH);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────── CLI

const USAGE = `用法：node log-center.mjs <命令> [选项]

  root                                    打印解析到的日志根
  doctor                                  打印解析结果 + 可写性（可写→退出码 0）
  init                                    建出 日志\\ 与 8 个分类子目录（幂等）
  append --category <键|目录名> [--file <文件名>] [--text <文本>|--from <文件>]
                                          追加一段日志（写失败只出声，退出码仍 0）

分类键：session command verify block cleanup engine audit model
分类目录名：01-会话 02-命令 03-验证 04-拦截 05-清理 06-引擎 07-审计 08-模型

环境变量：HARNESS_LOG_ROOT  指定日志根（启动器会设；不设则用 <AI-Dev-Harness 上一级>\\日志）`;

function parseArgs(argv) {
  const o = { cmd: argv[0] || "", category: null, file: null, text: null, from: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    if (a === "--category" || a === "-c") o.category = next();
    else if (a === "--file" || a === "-f") o.file = next();
    else if (a === "--text" || a === "-t") o.text = next();
    else if (a === "--from") o.from = next();
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[harness] ${err.message}\n${USAGE}\n`);
    return 2;
  }

  if (!o.cmd || o.cmd === "--help" || o.cmd === "-h" || o.cmd === "help") {
    process.stdout.write(`${USAGE}\n`);
    return o.cmd ? 0 : 2;
  }

  const root = resolveLogRoot();

  if (o.cmd === "root") {
    process.stdout.write(`${root}\n`);
    return 0;
  }

  if (o.cmd === "doctor") {
    const implOk = implExists();
    const w = implOk ? IMPL.probeWritable(root) : { writable: false, error: `主实现缺失：${IMPL_PATH}` };
    process.stdout.write(
      JSON.stringify(
        {
          logRoot: root,
          来源: process.env.HARNESS_LOG_ROOT ? "HARNESS_LOG_ROOT" : "<AI-Dev-Harness 上一级>\\日志",
          harnessRoot: HARNESS_ROOT,
          主实现: implOk ? "存在" : "缺失",
          可写: w.writable,
          错误: w.error ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    return w.writable ? 0 : 1;
  }

  if (o.cmd === "init") {
    const ok = IMPL.ensureLayout(root);
    process.stdout.write(ok ? `已建日志中心布局：${root}\n` : `建布局失败：${root}\n`);
    return ok ? 0 : 1;
  }

  if (o.cmd === "append") {
    if (!o.category) {
      process.stderr.write(`[harness] append 需要 --category\n${USAGE}\n`);
      return 2;
    }
    let text = o.text;
    if (text === null && o.from) {
      try {
        text = fs.readFileSync(o.from, "utf8");
      } catch (err) {
        speak(`读 --from 失败（${o.from}）：${err?.message || err}`);
        return 0; // fail-open
      }
    }
    if (text === null) {
      try {
        text = fs.readFileSync(0, "utf8"); // stdin
      } catch {
        text = "";
      }
    }
    const r = IMPL.appendLog(o.category, { file: o.file ?? undefined, text: `${text}`, logRoot: root });
    // ★ 无论成败都退 0：日志写不进去绝不能让调用方（清理、启动器）当成失败。
    if (!r.ok) speak(`append 失败：${r.error}`);
    return 0;
  }

  process.stderr.write(`[harness] 未知命令：${o.cmd}\n${USAGE}\n`);
  return 2;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      speak(`自身异常（按 fail-open 处理）：${err?.message || err}`);
      process.exit(0);
    });
}
