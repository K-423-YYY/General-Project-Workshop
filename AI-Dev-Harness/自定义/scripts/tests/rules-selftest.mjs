/**
 * rules-selftest.mjs —— 铁律「五处逐字一致」+ 交付流程文案的自检台（第 4 段）
 * ============================================================
 * 守什么：
 *   ① 规则源.md → 8 份生成物必须同源（gen-rules.mjs --check 退出 0）；
 *   ② 铁律正文必须**逐字**出现在五处消费方：
 *      AGENTS.md 第五节 / 对话协议.md §8 / 对话协议.md §10 /
 *      项目说明\03-使用说明.md 第四节 / 三个项目规则模板（+ 启动词模板）；
 *   ③ 铁律必须覆盖 00-总方案.md 第六节点名的每一条（机制层清单、只动两处、
 *      "先确认这是修 harness，不是做项目"、纯净度自检、GitHub 只告知、四条老条款、更新完即锁定）；
 *   ④ 交付流程文案：GitHub 只告知 / 清理两段式（清单 → 确认 → 执行 → 纯净度自检）。
 * 只读检查，不改任何文件、不写任何日志。
 *
 * 跑法：node AI-Dev-Harness/自定义/scripts/tests/rules-selftest.mjs
 * ============================================================
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // …\自定义\scripts\tests
const SCRIPTS = path.resolve(HERE, "..");                    // …\自定义\scripts
const CUSTOM = path.resolve(SCRIPTS, "..");                  // …\自定义
const HARNESS = path.resolve(CUSTOM, "..");                  // …\AI-Dev-Harness
const ROOT = path.resolve(HARNESS, "..");                    // …\General-Project-Workshop

const SOURCE = path.join(CUSTOM, "规则源.md");
const GEN_RULES = path.join(SCRIPTS, "gen-rules.mjs");
const PROTOCOL = path.join(CUSTOM, "对话协议.md");
const AGENTS = path.join(ROOT, "AGENTS.md");
const USAGE = path.join(ROOT, "项目说明", "03-使用说明.md");
const TPL_DIR = path.join(CUSTOM, "项目规则模板");

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(`${name}${detail ? ` —— ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function skipped(name, why) { skip += 1; console.log(`  ○ ${name}（跳过：${why}）`); }
function section(t) { console.log(`\n${t}`); }

const norm = (s) => String(s).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
const read = (file) => norm(fs.readFileSync(file, "utf8"));

/** 取标记区之间的内容（不含标记行本身） */
function region(file, name) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const b = `<!-- ${name}:begin -->`;
  const e = `<!-- ${name}:end -->`;
  const bi = text.indexOf(b);
  const ei = text.indexOf(e);
  if (bi < 0 || ei < 0 || ei < bi) return null;
  return norm(text.slice(bi + b.length, ei));
}

/** 取规则源里的某个 #block 正文 */
function block(name) {
  const text = fs.readFileSync(SOURCE, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const head = new RegExp(`^<!--\\s*#block\\s+${name}\\s*-->\\s*$`, "m");
  const m = head.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const endRel = rest.search(/^<!--\s*#end\s*-->\s*$/m);
  if (endRel < 0) return null;
  return norm(rest.slice(0, endRel));
}

console.log("铁律一致性 + 交付流程文案 自检台（第 4 段）");

// ───────────────────────────────────────────── ① 规则源同源
section("① 规则源 → 8 份生成物：同源");
const gen = spawnSync(process.execPath, [GEN_RULES, "--check", "--quiet"], { encoding: "utf8" });
check("gen-rules.mjs --check 退出 0（8 份生成物与规则源同源）", gen.status === 0, `status=${gen.status} ${(gen.stdout || "").trim()} ${(gen.stderr || "").trim()}`);

// ───────────────────────────────────────────── ② 铁律正文
section("② 铁律正文（唯一真源：规则源.md 的 #block 铁律正文）");
const iron = block("铁律正文");
check("规则源.md 里能取到「铁律正文」块", typeof iron === "string" && iron.length > 200, `length=${iron ? iron.length : "null"}`);

// ───────────────────────────────────────────── ③ 五处逐字一致
section("③ 五处（共 8 个落点）逐字一致");
const places = [
  ["AGENTS.md 第五节（region harness:ironrules）", region(AGENTS, "harness:ironrules")],
  ["对话协议.md §8（region harness:ironrules）", region(PROTOCOL, "harness:ironrules")],
  ["对话协议.md §10（region harness:rules，内含铁律）", region(PROTOCOL, "harness:rules")],
  ["项目说明\\03-使用说明.md 第四节（region harness:ironrules）", region(USAGE, "harness:ironrules")],
  ["项目规则模板\\AGENTS.template.md", read(path.join(TPL_DIR, "AGENTS.template.md"))],
  ["项目规则模板\\CLAUDE.template.md", read(path.join(TPL_DIR, "CLAUDE.template.md"))],
  ["项目规则模板\\trae-project_rules.template.md", read(path.join(TPL_DIR, "trae-project_rules.template.md"))],
  ["prompt-模板\\硬规则.md（启动词注入）", read(path.join(CUSTOM, "prompt-模板", "硬规则.md"))],
];
const extracted = [];
for (const [label, text] of places) {
  if (text === null) { check(`${label}：存在铁律正文`, false, "找不到标记区或文件"); continue; }
  const hit = text.includes(iron);
  check(`${label}：含铁律正文（逐字）`, hit, hit ? "" : `长度 ${text.length}，未匹配`);
  if (hit) extracted.push([label, text]);
}
check("落点数 = 8（AGENTS / 协议 §8 / 协议 §10 / 项目说明 03 / 三模板 / 启动词模板）", places.length === 8);

// ───────────────────────────────────────────── ④ 要点覆盖
section("④ 铁律要点覆盖（00-总方案.md 第六节逐条）");
const must = [
  ["只动两处", ["只动两处", "`我的项目\\`", "AI-Dev-Harness\\state\\"]],
  ["机制层清单 .claude\\", ["`.claude\\`"]],
  ["机制层清单 bin / scripts", ["自定义\\bin\\", "自定义\\scripts\\"]],
  ["机制层清单 规则源 + 两个能力表", ["规则源.md", "模型能力表.json", "引擎能力表.json"]],
  ["机制层清单 引擎适配 / prompt-模板 / 日志", ["引擎适配\\", "prompt-模板\\", "日志\\"]],
  ["内置区仍不可动 + 例外口径", ["内置\\`", "修 harness，不是做项目"]],
  ["交付前纯净度自检", ["purity-check.mjs", "纯净度自检"]],
  ["清理先清单后确认", ["将删除 / 将保留", "-Confirm"]],
  ["GitHub 只告知不代推", ["GitHub 只告知", "只输出步骤与命令"]],
  ["保留：相对路径", ["相对路径"]],
  ["保留：无后台常驻", ["后台常驻进程"]],
  ["保留：全程中文", ["全程中文"]],
  ["保留：用户只说话不输命令", ["用户只说话"]],
  ["更新完即锁定", ["更新完即锁定"]],
];
for (const [label, kws] of must) {
  const missing = kws.filter((k) => !iron.includes(k));
  check(`铁律含：「${label}」`, missing.length === 0, missing.length ? `缺：${missing.join(" / ")}` : "");
}

// ───────────────────────────────────────────── ⑤ 交付流程文案
section("⑤ 交付流程文案（GitHub 只告知 / 清理两段式）");
const protocol = read(PROTOCOL);
const usage = read(USAGE);
const readme = read(path.join(ROOT, "README.md"));
const gitSkill = read(path.join(CUSTOM, "skills", "git-delivery", "SKILL.md"));
const cleanupSkill = read(path.join(CUSTOM, "skills", "cleanup-and-final", "SKILL.md"));
const cleanupPs1 = fs.readFileSync(path.join(HARNESS, "内置", "scripts", "cleanup.ps1"), "utf8");

check("对话协议 §5.3 写明「不代推」+ 唯一例外", /不代(用户)?推送|只告知/.test(protocol) && /唯一例外/.test(protocol));
check("git-delivery SKILL 写明「只告知，不代推」", /只告知/.test(gitSkill) && /不代推/.test(gitSkill));
check("项目说明 03 写明只告知（AI 只给步骤与命令）", /只告知|不代推/.test(usage));
check("README 阶段 4 写明只告知，且不再写「索要仓库地址等信息后推送」", /只告知/.test(readme) && !/索要仓库地址等信息后推送/.test(readme));
check("cleanup-and-final SKILL 写明清单 → 确认 → 执行 → 纯净度自检", /将删除 \/ 将保留/.test(cleanupSkill) && /-Confirm/.test(cleanupSkill) && /purity-check\.mjs/.test(cleanupSkill));
check("cleanup.ps1 默认不删（没 -Confirm 就 exit 3）", /-not \$Confirm/.test(cleanupPs1) && /exit 3/.test(cleanupPs1));
check("cleanup.ps1 调用 purity-check.mjs（唯一实现）", /purity-check\.mjs/.test(cleanupPs1));

// ───────────────────────────────────────────── 收尾
console.log(`\n${"─".repeat(64)}`);
console.log(`自检结果：${pass} 项通过、${fail} 项失败、${skip} 项跳过`);
if (failures.length) { console.log("失败项："); for (const f of failures) console.log(`  · ${f}`); }
process.exit(fail ? 1 : 0);
