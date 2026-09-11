#!/usr/bin/env node
/**
 * list-skills.mjs —— 技能索引（省 token 的第一道门）
 * ============================================================
 * 为什么要有它：
 *   `自定义\skills\` 下 23 个 SKILL.md 合计约 25 万字符（`hatch-pet` 一个就 86 KB）。
 *   按需调用只需要知道"有哪些技能、各自干什么"，**不需要**把正文全读进来 ——
 *   全量读一遍是 6~8 万 token 级的浪费，而一次项目最多用到 3~5 个技能。
 *   本脚本从各 SKILL.md 的 frontmatter 生成一张**索引表**（约 2 KB），
 *   AI 开局只读这张表就能决定调谁；选中后再读那一个技能正文。
 *
 * 用法：
 *   node list-skills.mjs                 打印索引（人读）
 *   node list-skills.mjs --json          机器读
 *   node list-skills.mjs --update        把索引写回 自定义\skills\README.md 的标记区
 *   node list-skills.mjs --check         校验 README 里的索引与现状一致（漂移退 1）
 *   node list-skills.mjs --max-desc 60   说明列截断长度（默认 46）
 *
 * 退出码：0 正常 / 1 漂移（--check） / 2 用法或环境错误
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\自定义\scripts
const CUSTOM = path.resolve(SCRIPT_DIR, "..");                   // …\自定义
const SKILLS_DIR = path.join(CUSTOM, "skills");
const README = path.join(SKILLS_DIR, "README.md");
const REGION = "skills-index";
const BEGIN = `<!-- ${REGION}:begin -->`;
const END = `<!-- ${REGION}:end -->`;
/** 索引超过这个体积就报警：索引自己变成大文件，等于没省 */
const INDEX_BUDGET_BYTES = 8 * 1024;

/**
 * 体积口径：**与行尾无关**。
 * 为什么必须归一化：本仓库 core.autocrlf=true —— 本地工作区是 LF，而 clone 出来是 CRLF，
 * 直接用文件字节数会让"索引"在克隆里算出来不一样（克隆复验时真的漂移过一次）。
 * 归一到 LF 后，两种检出方式得到同一个数字。
 */
export function contentBytes(text) {
  return Buffer.byteLength(String(text).replace(/\r\n/g, "\n"), "utf8");
}

/**
 * 索引比对口径：同样**与行尾无关**。
 * 本地 README 是 LF、clone 出来是 CRLF（core.autocrlf=true），直接字符串比较会永远报漂移。
 */
export function sameIndex(a, b) {
  const norm = (t) => String(t).replace(/\r\n/g, "\n").trim();
  return norm(a) === norm(b);
}

function parseArgs(argv) {
  const o = { json: false, update: false, check: false, maxDesc: 46 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--update") o.update = true;
    else if (a === "--check") o.check = true;
    else if (a === "--max-desc") o.maxDesc = Number(argv[++i]) || 46;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`未知参数：${a}（--help 看用法）`);
  }
  return o;
}

/** 取 SKILL.md 的 frontmatter（name / description）。没有 frontmatter 也如实返回 null。 */
function readFrontmatter(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const pick = (key) => {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m");
    const hit = re.exec(m[1]);
    return hit ? hit[1].trim().replace(/^["']|["']$/g, "") : null;
  };
  return { name: pick("name"), description: pick("description") };
}

function scan() {
  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const rows = [];
  for (const dir of dirs) {
    const file = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!fs.existsSync(file)) {
      rows.push({ dir, name: dir, description: "(缺 SKILL.md)", bytes: 0, lines: 0, missing: true, noFrontmatter: false });
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    const fm = readFrontmatter(file);
    const normalized = text.replace(/\r\n/g, "\n");
    rows.push({
      dir,
      name: fm?.name ?? dir,
      description: fm?.description ?? "(缺 frontmatter 的 name/description)",
      bytes: contentBytes(text),
      lines: normalized.split("\n").length,
      missing: false,
      noFrontmatter: !fm || !fm.name || !fm.description,
    });
  }
  return rows;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function render(rows, maxDesc) {
  const clip = (s) => {
    const one = String(s).replace(/\|/g, "／").replace(/\s+/g, " ").trim();
    return one.length > maxDesc ? one.slice(0, maxDesc - 1) + "…" : one;
  };
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const out = [];
  out.push(`> 由 \`自定义\\scripts\\list-skills.mjs\` 生成，**不要手改**；改完技能跑 \`--update\`，\`--check\` 验证是否漂移。`);
  out.push("");
  out.push("| 技能 | 干什么（description 摘要） | 体积 |");
  out.push("|---|---|---|");
  for (const r of rows) {
    const flag = r.missing ? " ⚠缺文件" : r.noFrontmatter ? " ⚠缺 frontmatter" : "";
    out.push(`| \`${r.dir}\` | ${clip(r.description)}${flag} | ${kb(r.bytes)} |`);
  }
  out.push("");
  out.push(`（共 ${rows.length} 个技能；正文合计 ${kb(total)} —— **开局只读这张表即可**，选中后再读那一个技能）`);
  return out.join("\n");
}

function readReadme() {
  try { return fs.readFileSync(README, "utf8").replace(/^\uFEFF/, ""); } catch { return null; }
}

function regionInner(text) {
  const bi = text.indexOf(BEGIN);
  const ei = text.indexOf(END);
  if (bi < 0 || ei < 0 || ei < bi) return null;
  return text.slice(bi + BEGIN.length, ei);
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) {
    process.stderr.write(`[list-skills] ${err.message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write("用法：node list-skills.mjs [--json] [--update] [--check] [--max-desc N]\n");
    return 0;
  }
  if (!fs.existsSync(SKILLS_DIR)) {
    process.stderr.write(`[list-skills] 找不到技能目录：${SKILLS_DIR}\n`);
    return 2;
  }

  const rows = scan();
  const body = render(rows, args.maxDesc);
  const indexBytes = Buffer.byteLength(body, "utf8");

  if (args.json) {
    process.stdout.write(JSON.stringify({
      skillsDir: SKILLS_DIR,
      count: rows.length,
      totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
      indexBytes,
      indexBudgetBytes: INDEX_BUDGET_BYTES,
      rows,
    }, null, 2) + "\n");
    return 0;
  }

  if (args.check) {
    const text = readReadme();
    if (text === null) { process.stderr.write(`[list-skills] 读不到 ${README}\n`); return 2; }
    const inner = regionInner(text);
    if (inner === null) { process.stderr.write(`[list-skills] README 里找不到标记区 ${BEGIN} / ${END}\n`); return 2; }
    const same = sameIndex(inner, body);
    process.stdout.write(same
      ? `✅ 技能索引与现状一致（${rows.length} 个技能，索引 ${kb(indexBytes)}）\n`
      : `⚠️  技能索引已漂移 —— 跑 node list-skills.mjs --update 重新生成。\n`);
    return same ? 0 : 1;
  }

  if (args.update) {
    let text = readReadme();
    if (text === null) text = `# skills（即插即用技能库）\n\n${BEGIN}\n${END}\n`;
    if (!text.includes(BEGIN) || !text.includes(END)) {
      process.stderr.write(`[list-skills] README 里找不到标记区，请先手工加上 ${BEGIN} / ${END}\n`);
      return 2;
    }
    const bi = text.indexOf(BEGIN);
    const ei = text.indexOf(END);
    const next = `${text.slice(0, bi + BEGIN.length)}\n${body}\n${text.slice(ei)}`;
    fs.writeFileSync(README, next, "utf8");
    process.stdout.write(`✅ 已更新技能索引（${rows.length} 个技能，索引 ${kb(indexBytes)}）→ ${README}\n`);
    return 0;
  }

  process.stdout.write(body + "\n");
  if (indexBytes > INDEX_BUDGET_BYTES) {
    process.stdout.write(`⚠️  索引 ${kb(indexBytes)} 超过 ${kb(INDEX_BUDGET_BYTES)} 预算 —— 说明截断不够，调小 --max-desc。\n`);
  }
  return 0;
}

process.exitCode = main();

export { scan, render, readFrontmatter, INDEX_BUDGET_BYTES, SKILLS_DIR, README };
