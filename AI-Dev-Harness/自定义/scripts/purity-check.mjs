#!/usr/bin/env node
/**
 * purity-check.mjs —— 纯净度自检（交付前的最后一道闸门）
 * ============================================================
 * 为什么要有它（前提 4 + 锁定决策 8）：
 *   开发期允许把机制层（.claude\、.harness\）和脚手架（AGENTS.md / CLAUDE.md / .trae\）
 *   放进项目目录，好让 hooks 真的生效；但**交付出去的项目文件夹必须与 harness 彻底分离**。
 *   "清干净了"这句话必须由脚本给出证据 —— 靠人眼看、靠模型自述都不算。
 *
 * 判据（两类，都要为空才算干净）：
 *   ① 脚手架残留：项目目录里不得再有 .claude\ / .harness\ / .trae\ / AGENTS.md / CLAUDE.md；
 *   ② harness 路径引用：项目内的文本文件不得再引用 harness
 *      （AI-Dev-Harness / .harness\ / HARNESS_ROOT / harness:rules 等特征串）。
 *
 * 用法：
 *   node purity-check.mjs --project "<项目目录>"        # 人读输出
 *   node purity-check.mjs --project "<项目目录>" --json # 机器读（cleanup.ps1 用）
 *   node purity-check.mjs --project "<项目目录>" --quiet # 只输出一行结论
 *
 * 退出码：0 = 干净；1 = 有残留/引用（不算失败，是"必须处理"）；2 = 用法或路径错误。
 *
 * 边界（如实说明）：
 *   · 只扫文本类扩展名、单文件 ≤ 256 KB、最多 3000 个文件 —— 有界扫描，不读依赖与大文件。
 *   · 跳过 .git / node_modules / dist / build / .venv / __pycache__（第三方产物不归本项目管）。
 *   · 二进制文件（图片、压缩包、字体）不扫内容。
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";

const MARKERS = [".claude", ".harness", ".trae", "AGENTS.md", "CLAUDE.md"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target"]);
const REF_PATTERNS = [
  { key: "AI-Dev-Harness", re: /AI-Dev-Harness/ },
  { key: ".harness", re: /\.harness[\\/]/ },
  { key: "HARNESS_ROOT", re: /HARNESS_ROOT/ },
  { key: "HARNESS_STATE_DIR", re: /HARNESS_STATE_DIR/ },
  { key: "HARNESS_LOG_ROOT", re: /HARNESS_LOG_ROOT/ },
  { key: "harness:rules", re: /harness:(rules|ironrules)/ },
  { key: "机制层", re: /(\.claude[\\/](hooks|settings\.json))/ },
];
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".json", ".jsonc", ".json5", ".js", ".mjs", ".cjs", ".jsx",
  ".ts", ".tsx", ".vue", ".svelte", ".py", ".rb", ".go", ".rs", ".java", ".cs", ".php",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env", ".sh", ".bash", ".zsh",
  ".ps1", ".psm1", ".bat", ".cmd", ".html", ".htm", ".css", ".scss", ".less", ".sql", ".gitignore",
]);
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 3000;

function parseArgs(argv) {
  const o = { project: process.cwd(), json: false, quiet: false, maxRefs: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    if (a === "--project" || a === "-p") o.project = next();
    else if (a === "--json") o.json = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--max-refs") o.maxRefs = Number(next()) || 40;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`未知参数：${a}（--help 看用法）`);
  }
  return o;
}

/** 递归收集：残留标记 + 文本候选文件（有界） */
function scan(root) {
  const leftovers = [];
  const candidates = [];
  const stack = [root];
  let truncated = false;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (MARKERS.includes(ent.name)) {
        leftovers.push({ path: abs, kind: ent.isDirectory() ? "目录" : "文件" });
        continue; // 残留本身就是结论，不再往里扫
      }
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase() || (ent.name.startsWith(".git") ? ".gitignore" : "");
      if (!TEXT_EXT.has(ext)) continue;
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      if (size > MAX_BYTES) continue;
      if (candidates.length >= MAX_FILES) {
        truncated = true;
        continue;
      }
      candidates.push(abs);
    }
  }
  return { leftovers, candidates, truncated };
}

/** 在候选文件里找 harness 特征串，返回 [{path,line,key,text}] */
function findRefs(candidates) {
  const refs = [];
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }
    if (!/harness/i.test(text) && !/\.claude[\\/]/.test(text)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const p of REF_PATTERNS) {
        if (p.re.test(lines[i])) {
          refs.push({ path: file, line: i + 1, key: p.key, text: lines[i].trim().slice(0, 200) });
          break;
        }
      }
    }
  }
  return refs;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[purity-check] ${err.message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(
      "用法：node purity-check.mjs [--project <项目目录>] [--json] [--quiet] [--max-refs N]\n" +
        "退出码：0 干净 / 1 有残留或引用 / 2 用法或路径错误\n"
    );
    return 0;
  }

  const root = path.resolve(args.project);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`[purity-check] 项目目录不存在或不是目录：${root}\n`);
    return 2;
  }

  const { leftovers, candidates, truncated } = scan(root);
  const refs = findRefs(candidates);
  const clean = leftovers.length === 0 && refs.length === 0;
  const result = {
    project: root,
    checkedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    clean,
    leftovers,
    refs,
    refsShown: Math.min(refs.length, args.maxRefs),
    scanned: { files: candidates.length, truncated },
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (args.quiet) {
    process.stdout.write(
      clean
        ? "纯净度自检：通过\n"
        : `纯净度自检：未通过（残留 ${leftovers.length} 处、引用 ${refs.length} 处）\n`
    );
  } else {
    const out = [];
    out.push(`纯净度自检：${path.basename(root)}`);
    out.push(`- 项目目录：${root}`);
    out.push(`- 扫描：文本文件 ${candidates.length} 个${truncated ? "（已达上限 3000，可能有遗漏）" : ""}`);
    out.push("");
    if (leftovers.length === 0) {
      out.push("✅ 脚手架残留：无（.claude / .harness / .trae / AGENTS.md / CLAUDE.md）");
    } else {
      out.push(`❌ 脚手架残留：${leftovers.length} 处`);
      for (const l of leftovers) out.push(`   - [${l.kind}] ${l.path}`);
    }
    if (refs.length === 0) {
      out.push("✅ harness 路径引用：无");
    } else {
      out.push(`❌ harness 路径引用：${refs.length} 处（人工确认这些引用是否该保留）`);
      for (const r of refs.slice(0, args.maxRefs)) out.push(`   - ${r.path}:${r.line} [${r.key}] ${r.text}`);
      if (refs.length > args.maxRefs) out.push(`   … 还有 ${refs.length - args.maxRefs} 处未列出`);
    }
    out.push("");
    out.push(clean ? "结论：通过 —— 项目文件夹里没有任何 harness 痕迹。" : "结论：未通过 —— 交付前必须处理上面每一项。");
    process.stdout.write(out.join("\n") + "\n");
  }

  return clean ? 0 : 1;
}

process.exitCode = main();

export { scan, findRefs, MARKERS, REF_PATTERNS };
