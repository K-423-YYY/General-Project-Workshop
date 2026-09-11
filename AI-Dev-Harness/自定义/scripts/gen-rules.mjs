#!/usr/bin/env node
/**
 * gen-rules.mjs —— 规则生成器（U1 · 规则单一来源）
 * ============================================================
 * 作用：把 `自定义\规则源.md`（唯一真源）渲染成 4 份规则文件 + 1 处就地同步：
 *
 *   1. 自定义/项目规则模板/CLAUDE.template.md          （Claude Code）
 *   2. 自定义/项目规则模板/AGENTS.template.md          （Codex / DSH / 根目录入口）
 *   3. 自定义/项目规则模板/trae-project_rules.template.md（Trae 系列）
 *   4. 自定义/prompt-模板/硬规则.md                    （U2 启动词注入用）
 *   5. 自定义/对话协议.md 第 10 章（标记区就地同步）
 *
 * 为什么需要它（第 4 批遗留 3）：
 *   此前「3 份模板 + 协议第 10 章 + 启动词硬规则」共 5 份是**手工同步**的，
 *   只在注释里写了「改这里要同步那几份」——没有任何机制强制。本脚本把同步变成
 *   `gen-rules.mjs` 一条命令，`--check` 可以随时验证有没有漂移。
 *
 * 用法：
 *   node gen-rules.mjs                生成/更新全部生成物
 *   node gen-rules.mjs --check        只检查是否同源（有漂移退 1，齐全退 0）
 *   node gen-rules.mjs --dry-run      预演，不写文件
 *   node gen-rules.mjs --only 硬规则   只处理某一个生成物（按输出路径匹配子串）
 *   node gen-rules.mjs --json         机器可读结果
 *   node gen-rules.mjs --print <out>  把某个生成物的渲染结果打到 stdout
 *
 * 依赖：无（只用 node 内置模块）。任何异常都不改文件、以退 2 结束。
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\自定义\scripts
const HARNESS_ROOT = path.resolve(SCRIPT_DIR, "..", "..");       // …\AI-Dev-Harness
const SOURCE_FILE = path.join(HARNESS_ROOT, "自定义", "规则源.md");

// ──────────────────────────────────────────────────────────── 小工具

/** 归一化：去 BOM、CRLF→LF、去掉尾部空白换行 */
function norm(text) {
  return String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n";
}

function sha(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function readUtf8(file) {
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

// ──────────────────────────────────────────────────────────── 解析 规则源.md

const RE_VARS = /^<!--\s*#vars\s*(.*?)\s*-->$/;
const RE_BLOCK = /^<!--\s*#block\s+(.+?)\s*-->$/;
const RE_OUT = /^<!--\s*#out\s+(.+?)\s*-->$/;
const RE_END = /^<!--\s*#end\s*-->$/;

/** 把 "名字 @a,b  键=值" 拆开。注意标签也可能出现在**第一个**位置（`#vars @默认标签`）。 */
function splitHead(head) {
  const parts = head.split(/\s+/).filter(Boolean);
  const first = parts.shift() ?? "";
  const o = { name: first.startsWith("@") ? "" : first, engine: null, kv: {} };
  if (first.startsWith("@")) parts.unshift(first);
  for (const p of parts) {
    if (p.startsWith("@")) o.engine = p.slice(1).split(",").map((s) => s.trim()).filter(Boolean);
    else if (p.includes("=")) {
      const i = p.indexOf("=");
      o.kv[p.slice(0, i)] = p.slice(i + 1);
    }
  }
  return o;
}

/**
 * 解析规则源。返回 { vars, blocks, outs }
 *   vars   : Map<engine|"", Map<变量名, 值>>
 *   blocks : Map<"块名|引擎" , 正文>   同时有 "块名|" 作默认变体
 *   outs   : [{ kind:"file"|"region", rel, engine, region, body }]
 */
function parseSource(text) {
  const lines = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const vars = new Map();
  const blocks = new Map();
  const outs = [];
  let cur = null; // {type, head, buf[]}
  const errs = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mEnd = line.match(RE_END);
    if (mEnd) {
      if (!cur) { errs.push(`第 ${i + 1} 行：#end 没有对应的开始标记`); continue; }
      finish(cur);
      cur = null;
      continue;
    }
    const mVars = line.match(RE_VARS);
    const mBlock = line.match(RE_BLOCK);
    const mOut = line.match(RE_OUT);
    if (mVars || mBlock || mOut) {
      if (cur) { errs.push(`第 ${i + 1} 行：上一个 ${cur.type} 还没有 #end`); finish(cur); }
      cur = {
        type: mVars ? "vars" : mBlock ? "block" : "out",
        head: splitHead((mVars || mBlock || mOut)[1]),
        line: i + 1,
        buf: [],
      };
      continue;
    }
    if (cur) cur.buf.push(line);
  }
  if (cur) { errs.push(`文件末尾：${cur.type} 还没有 #end`); finish(cur); }

  function finish(c) {
    const body = c.buf.join("\n").replace(/^\n+/, "").replace(/[ \t]+$/, "");
    const eng = c.head.engine ? c.head.engine.join(",") : "";
    if (c.type === "vars") {
      for (const e of c.head.engine ?? [""]) {
        const m = vars.get(e) ?? new Map();
        for (const raw of body.split("\n")) {
          if (!raw.trim() || raw.trim().startsWith("#")) continue;
          const i = raw.indexOf("=");
          if (i < 0) { errs.push(`第 ${c.line} 行的 #vars 里「${raw}」不是 名 = 值`); continue; }
          m.set(raw.slice(0, i).trim(), raw.slice(i + 1).trim());
        }
        vars.set(e, m);
      }
    } else if (c.type === "block") {
      if (!c.head.name) { errs.push(`第 ${c.line} 行：#block 缺块名`); return; }
      const key = `${c.head.name}|${eng}`;
      if (blocks.has(key)) errs.push(`第 ${c.line} 行：块「${key}」重复定义`);
      blocks.set(key, body);
    } else {
      if (!c.head.name) { errs.push(`第 ${c.line} 行：#out 缺路径`); return; }
      outs.push({
        kind: c.head.kv.region ? "region" : "file",
        rel: c.head.name,
        engine: eng || "default",
        region: c.head.kv.region || null,
        line: c.line,
        body,
      });
    }
  }

  return { vars, blocks, outs, errs };
}

// ──────────────────────────────────────────────────────────── 渲染

const VAR_RE = /\{\{var:([^}]+)\}\}/g;
const BLOCK_RE = /\{\{block:([^}]+)\}\}/g;

function makeRenderer(src) {
  const varsFor = (engine) => {
    // 基础层：不带标签的 #vars 与 @default 都是「默认变量」，引擎专属的覆盖它们
    const merged = new Map(src.vars.get("") ?? []);
    for (const [k, v] of src.vars.get("default") ?? []) merged.set(k, v);
    for (const [k, v] of src.vars.get(engine) ?? []) merged.set(k, v);
    return merged;
  };
  const blockFor = (name, engine) => {
    if (src.blocks.has(`${name}|${engine}`)) return { text: src.blocks.get(`${name}|${engine}`), from: engine };
    if (src.blocks.has(`${name}|`)) return { text: src.blocks.get(`${name}|`), from: "default" };
    return null;
  };

  /** 渲染一段文本（递归解析 {{block:}} / {{var:}}） */
  function render(text, engine, depth = 0, trail = []) {
    if (depth > 6) throw new Error(`block 引用层级过深（>6）：${trail.join(" → ")}`);
    const vars = varsFor(engine);
    let out = text.replace(BLOCK_RE, (_, name) => {
      const hit = blockFor(name.trim(), engine);
      if (!hit) throw new Error(`引用了不存在的块「${name.trim()}」（引擎 ${engine}）`);
      return render(hit.text, engine, depth + 1, [...trail, name.trim()]);
    });
    out = out.replace(VAR_RE, (_, name) => {
      const key = name.trim();
      if (!vars.has(key)) throw new Error(`引用了未定义的变量「${key}」（引擎 ${engine}）`);
      return vars.get(key);
    });
    return out;
  }
  return { render, blockFor, varsFor };
}

// ──────────────────────────────────────────────────────────── 生成

const REGION_BEGIN = (r) => `<!-- ${r}:begin -->`;
const REGION_END = (r) => `<!-- ${r}:end -->`;

/** 计算每个生成物的期望内容；region 类型返回 {file, before, after, content} */
function plan(src) {
  const { render } = makeRenderer(src);
  const items = [];
  for (const o of src.outs) {
    const abs = path.resolve(HARNESS_ROOT, o.rel);
    const body = norm(render(o.body, o.engine)).replace(/\n+$/, "\n");
    if (o.kind === "file") {
      items.push({ ...o, abs, expected: body, kindLabel: "文件" });
    } else {
      let existing = "";
      try { existing = readUtf8(abs); } catch { /* 下面按「文件不存在」处理 */ }
      if (!existing) {
        items.push({ ...o, abs, expected: body, error: `标记区同步的目标文件不存在：${abs}`, kindLabel: "标记区" });
        continue;
      }
      const b = REGION_BEGIN(o.region);
      const e = REGION_END(o.region);
      const bi = existing.indexOf(b);
      const ei = existing.indexOf(e);
      if (bi < 0 || ei < 0 || ei < bi) {
        items.push({ ...o, abs, expected: body, error: `目标文件里找不到标记 ${b} / ${e}`, kindLabel: "标记区" });
        continue;
      }
      const before = existing.slice(0, bi + b.length);
      const after = existing.slice(ei);
      const expected = norm(`${before}\n\n${body}${after}`);
      // bodyRendered 单独留着：同一个文件可能有**多个**标记区（如对话协议第 8 章与第 10 章），
      // 逐个写回时必须按"写回时的当前文件内容"重新拼接，否则后一个会覆盖前一个的更新。
      items.push({ ...o, abs, expected, before, after, bodyRendered: body, kindLabel: "标记区" });
    }
  }
  return items;
}

// ──────────────────────────────────────────────────────────── CLI

const USAGE = `用法：node gen-rules.mjs [选项]

  （无参数）        生成/更新全部生成物
  --check          只检查是否与规则源同源；有漂移退 1
  --dry-run        预演，不写文件
  --only <子串>    只处理路径里含该子串的生成物（可多次）
  --json           以 JSON 输出结果
  --print <子串>   把匹配到的生成物的渲染结果打到 stdout（不写文件）
  --list           列出规则源里定义的全部块 / 变量 / 生成物
  --quiet          只输出一行结论
  --help, -h       显示本帮助

规则源：AI-Dev-Harness\\自定义\\规则源.md`;

function parseArgs(argv) {
  const o = { check: false, dryRun: false, only: [], json: false, print: null, list: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    switch (a) {
      case "--check": o.check = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--only": o.only.push(next()); break;
      case "--json": o.json = true; break;
      case "--print": o.print = next(); break;
      case "--list": o.list = true; break;
      case "--quiet": o.quiet = true; break;
      case "--help": case "-h": o.help = true; break;
      default:
        if (!a.startsWith("-") && !o.print) o.print = a;
        else throw new Error(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  return o;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + "\n"); return 0; }

  if (!fs.existsSync(SOURCE_FILE)) {
    process.stderr.write(`[gen-rules] 找不到规则源：${SOURCE_FILE}\n`);
    return 2;
  }
  const src = parseSource(fs.readFileSync(SOURCE_FILE, "utf8"));
  if (src.errs.length) {
    process.stderr.write(`[gen-rules] 规则源解析失败：\n  - ${src.errs.join("\n  - ")}\n`);
    return 2;
  }

  if (args.list) {
    const lines = ["# 变量"];
    for (const [e, m] of src.vars) {
      lines.push(`  @${e || "(默认)"}: ${[...m.entries()].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
    }
    lines.push("# 块");
    for (const [k, v] of src.blocks) lines.push(`  ${k}  (${v.split("\n").length} 行)`);
    lines.push("# 生成物");
    for (const o of src.outs) lines.push(`  [${o.kind}] ${o.rel}  @${o.engine}${o.region ? ` region=${o.region}` : ""}`);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }

  let items;
  try {
    items = plan(src);
  } catch (err) {
    process.stderr.write(`[gen-rules] 渲染失败：${err.message}\n`);
    return 2;
  }

  if (args.only.length) {
    items = items.filter((it) => args.only.some((s) => it.rel.includes(s)));
    if (!items.length) {
      process.stderr.write(`[gen-rules] --only 没有匹配到任何生成物\n`);
      return 2;
    }
  }

  if (args.print) {
    const hit = items.find((it) => it.rel.includes(args.print));
    if (!hit) { process.stderr.write(`[gen-rules] --print 没有匹配到：${args.print}\n`); return 2; }
    process.stdout.write(hit.expected);
    return hit.error ? 2 : 0;
  }

  /** 从整份文本里取出某个标记区之间的内容（不含标记行） */
  const regionInner = (text, region) => {
    const bi = text.indexOf(REGION_BEGIN(region));
    const ei = text.indexOf(REGION_END(region));
    if (bi < 0 || ei < 0 || ei < bi) return null;
    return text.slice(bi + REGION_BEGIN(region).length, ei);
  };

  const results = [];
  for (const it of items) {
    let actual = null;
    try { actual = readUtf8(it.abs); } catch { /* 文件不存在 */ }
    let state;
    if (it.error) state = "error";
    else if (actual === null) state = "missing";
    else if (it.kind === "region") {
      const inner = regionInner(actual, it.region);
      // 比较用 trim()：标记区两侧的换行属于版式，不属于内容
      state = inner !== null && norm(inner).trim() === norm(it.bodyRendered).trim() ? "same" : "drift";
    } else state = actual === it.expected ? "same" : "drift";
    results.push({ ...it, actual, state });
  }

  /** 写回：文件类直接覆盖；标记区按**当前磁盘内容**重新拼接（支持一文件多标记区） */
  const writeOne = (r) => {
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    if (r.kind !== "region") {
      fs.writeFileSync(r.abs, r.expected, "utf8");
      return;
    }
    const cur = readUtf8(r.abs);
    const b = REGION_BEGIN(r.region);
    const ei = cur.indexOf(REGION_END(r.region));
    const bi = cur.indexOf(b);
    if (bi < 0 || ei < 0 || ei < bi) throw new Error(`写回时找不到标记区：${r.abs} / ${r.region}`);
    const next = norm(`${cur.slice(0, bi + b.length)}\n\n${r.bodyRendered}${cur.slice(ei)}`);
    fs.writeFileSync(r.abs, next, "utf8");
  };

  const needed = results.filter((r) => r.state === "drift" || r.state === "missing");
  const errors = results.filter((r) => r.state === "error");

  if (errors.length) {
    for (const e of errors) process.stderr.write(`[gen-rules] 错误：${e.error}\n`);
    return 2;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({
      source: SOURCE_FILE,
      check: args.check,
      dryRun: args.dryRun,
      items: results.map((r) => ({
        rel: r.rel, kind: r.kind, engine: r.engine, state: r.state,
        bytes: Buffer.byteLength(r.expected, "utf8"), sha: sha(r.expected),
      })),
      drifted: needed.length,
      ok: needed.length === 0,
    }, null, 2) + "\n");
    if (args.check) return needed.length ? 1 : 0;
    if (args.dryRun) return 0;
  }

  if (!args.check && !args.dryRun) {
    for (const r of needed) writeOne(r);
  }

  if (!args.json) {
    if (!args.quiet) {
      const mark = { same: "✅ 同源", drift: "✏️  已更新", missing: "🆕 已生成", error: "❌ 错误" };
      process.stdout.write(`规则源：${SOURCE_FILE}\n`);
      for (const r of results) {
        const act = args.check ? (r.state === "same" ? "✅ 同源" : "⚠️  漂移") : mark[r.state];
        process.stdout.write(
          `  ${act.padEnd(10)} ${r.rel.padEnd(46)} ${String(Buffer.byteLength(r.expected, "utf8")).padStart(6)} B  ${sha(r.expected)}\n`
        );
      }
    }
    if (args.check) {
      process.stdout.write(needed.length
        ? `\n⚠️  ${needed.length} 份生成物与规则源不一致 —— 跑 node gen-rules.mjs 同步。\n`
        : `\n✅ 全部 ${results.length} 份生成物与规则源同源。\n`);
    } else if (args.dryRun) {
      process.stdout.write(needed.length ? `\n（预演）将更新 ${needed.length} 份，未写盘。\n` : `\n（预演）无需更新。\n`);
    } else {
      process.stdout.write(needed.length ? `\n✅ 已同步 ${needed.length} 份生成物（共 ${results.length} 份）。\n` : `\n✅ 无需更新，${results.length} 份生成物已同源。\n`);
    }
  }

  if (args.check && needed.length) return 1;
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isMain) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`[gen-rules] 出错：${err.message}\n`);
    process.exitCode = 2;
  }
}

export { parseSource, makeRenderer, plan, SOURCE_FILE, HARNESS_ROOT };
