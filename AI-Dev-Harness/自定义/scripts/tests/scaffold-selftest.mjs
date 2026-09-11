/**
 * scaffold-selftest.mjs —— 第 5 批（项目脚手架扩展）的零成本自检台
 *
 * 做法与第 2 批 hooks-selftest.mjs、第 3 批 context-selftest.mjs 同一路数：
 * 在**临时沙箱工作区**里跑真实的 `scaffold-ext.mjs`，逐项断言它落地了什么。
 * 不启动任何模型、不消耗任何额度、不碰真实项目目录。
 *
 * 覆盖 04-实施批次与验收.md 第 5 批 4 项验收里能离线判定的部分：
 *   ① 跑 scaffold.ps1 + scaffold-ext.mjs 之后 .claude/hooks 与 settings.json 是否正确
 *   ③ env-doctor 能否检测项目内 hooks 与主副本的版本一致性（含「先篡改再修复」的闭环）
 *   ④ 删掉重建，流程可重复
 * 外加：幂等性、护栏、--dry-run / --check / --remove / --no-overwrite 的行为边界。
 *
 * 沙箱结构（真实脚本 + 假工作区根）：
 *   <tmp>/ws/.claude/hooks/**          ← 从真实主副本复制（测试的就是真实那一份）
 *   <tmp>/ws/.claude/settings.json     ← 同上
 *   <tmp>/ws/我的项目/                  ← 目标项目
 * 脚本用 --work-root 指向 ws、--harness-root 指向真实 harness（模板与能力表用真实的那份）。
 *
 * 跑法：node AI-Dev-Harness/自定义/scripts/tests/scaffold-selftest.mjs [--keep]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));       // …\自定义\scripts\tests
const SCRIPTS = path.resolve(HERE, "..");                        // …\自定义\scripts
const HARNESS = path.resolve(SCRIPTS, "..", "..");               // …\AI-Dev-Harness
const ROOT = path.resolve(HARNESS, "..");                        // …\General-Project-Workshop

const SCAFFOLD_EXT = path.join(SCRIPTS, "scaffold-ext.mjs");
const ENV_DOCTOR = path.join(SCRIPTS, "env-doctor.mjs");
const KEEP = process.argv.includes("--keep");

// ───────────────────────────────────────────── 迷你测试台

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` —— ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function section(t) { console.log(`\n${t}`); }

function run(script, argv, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...argv], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// ───────────────────────────────────────────── 沙箱

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (!/\.bak[-.]/i.test(e.name)) fs.copyFileSync(s, d);
  }
}

/** 递归收集相对路径（只看 .mjs/.js/.json，与 env-doctor 同一口径） */
function walkRel(dir, prefix = "") {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = prefix ? path.join(prefix, e.name) : e.name;
    if (e.isDirectory()) out = out.concat(walkRel(path.join(dir, e.name), rel));
    else if (/\.(mjs|js|json)$/i.test(e.name) && !/\.bak[-.]/i.test(e.name)) out.push(rel);
  }
  return out;
}

const read = (f) => { try { return fs.readFileSync(f, "utf8").replace(/^﻿/, ""); } catch { return null; } };
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };

function makeSandbox() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "b5-scaffold-"));
  fs.mkdirSync(path.join(ws, "我的项目"), { recursive: true });
  copyTree(path.join(ROOT, ".claude", "hooks"), path.join(ws, ".claude", "hooks"));
  fs.copyFileSync(path.join(ROOT, ".claude", "settings.json"), path.join(ws, ".claude", "settings.json"));
  return ws;
}

// 开跑前给真实工作区拍一张快照（收尾时逐字节比对，证明本自检台只动了沙箱）
const realClaudeDir = path.join(ROOT, ".claude");
const realHooks = path.join(realClaudeDir, "hooks");
const realClaudeBefore = fs.readdirSync(realClaudeDir).sort().join("|");
const realHooksBefore = new Map(walkRel(realHooks).map((f) => [f, fs.readFileSync(path.join(realHooks, f), "utf8")]));

const ws = makeSandbox();
const proj = path.join(ws, "我的项目");
const masterHooks = path.join(ws, ".claude", "hooks");
const projHooks = path.join(proj, ".claude", "hooks");
const argvBase = ["--work-root", ws, "--harness-root", HARNESS, "--project", proj];

console.log(`沙箱工作区：${ws}`);
console.log(`目标项目：  ${proj}`);

// ═════════════════════════════════════════════ 1. 首次生成
section("① 首次运行：生成项目内机制层");

const r1 = run(SCAFFOLD_EXT, argvBase);
check("退出码 0", r1.code === 0, `实际 ${r1.code}\n${r1.out.slice(0, 800)}`);

const projSettings = path.join(proj, ".claude", "settings.json");
check("生成了 .claude/settings.json", exists(projSettings));
check("生成了 .claude/hooks/", exists(projHooks));

// hooks 与主副本逐字节一致（含 lib/）
const masterFiles = walkRel(masterHooks);
const projFiles = walkRel(projHooks);
const diff = [];
for (const f of masterFiles) {
  if (!projFiles.includes(f)) { diff.push(`缺 ${f}`); continue; }
  const a = fs.readFileSync(path.join(masterHooks, f));
  const b = fs.readFileSync(path.join(projHooks, f));
  if (Buffer.compare(a, b) !== 0) diff.push(`内容不同 ${f}`);
}
check(`hooks 全部逐字节复制到位（${masterFiles.length} 个文件，含 lib/）`,
  masterFiles.length > 5 && projFiles.length === masterFiles.length && diff.length === 0,
  diff.join("; "));
check("lib/policy.mjs 在内（hooks 依赖它）", exists(path.join(projHooks, "lib", "policy.mjs")));

// settings.json 内容
let s = null;
try { s = JSON.parse(read(projSettings)); } catch { /* 下面断言会报 */ }
check("settings.json 是合法 JSON", s !== null);
check("autoCompactWindow = 102400（沿用工作区根的值）", s?.autoCompactWindow === 102400,
  `实际 ${s?.autoCompactWindow}`);
check("hooks 已注册 6 个事件",
  s?.hooks && Object.keys(s.hooks).length === 6,
  `实际 ${s?.hooks ? Object.keys(s.hooks).join(",") : "(无 hooks)"}`);
check("statusLine 已写入", !!s?.statusLine);

// settings 引用的脚本必须真实存在
const refs = [];
for (const ev of Object.values(s?.hooks ?? {})) {
  for (const item of ev ?? []) for (const h of item.hooks ?? []) for (const a of h.args ?? []) {
    if (typeof a === "string" && a.endsWith(".mjs")) refs.push(a);
  }
}
for (const a of s?.statusLine?.args ?? []) if (String(a).endsWith(".mjs")) refs.push(a);
const missingRefs = [...new Set(refs)].filter((r) => !exists(path.join(proj, r)));
check(`settings 引用的 ${new Set(refs).size} 个脚本都在项目内`, missingRefs.length === 0, missingRefs.join(", "));

// .harness / state / JOURNAL
// 第 2 段（日志中心）：项目内**不再**建 .harness/logs/ —— 日志写在**工作区根**的 日志\。
// 这里把"不建"当断言：一旦有人把这个目录加回来，就是"项目里又会留下运行痕迹"。
check(".harness/ 已建（只放运行态：JOURNAL / HANDOFF / verify.json）", exists(path.join(proj, ".harness")));
check("★ 项目内没有 .harness/logs/（第 2 段已把日志迁到工作区根 日志\\）", !exists(path.join(proj, ".harness", "logs")));
check(".claude/state/ 已建", exists(path.join(proj, ".claude", "state")));
check("JOURNAL.md 种子已建", exists(path.join(proj, ".harness", "JOURNAL.md")));
check("★ 不预生成 HANDOFF.md（否则会注入假的「上次交接」）",
  !exists(path.join(proj, ".harness", "HANDOFF.md")));
check("★ 不预生成 quota.json（真实路径是 .claude/state/quota.json，由 hooks 按需建）",
  !exists(path.join(proj, ".claude", "state", "quota.json")));

// .gitignore
const gi = read(path.join(proj, ".gitignore")) ?? "";
check(".gitignore 含 .harness/ 与 .claude/state/",
  gi.split(/\r?\n/).some((l) => l.trim() === ".harness/") &&
  gi.split(/\r?\n/).some((l) => l.trim() === ".claude/state/"));

// 规则文件（3 份，与模板逐字节相同）
const tplDir = path.join(HARNESS, "自定义", "项目规则模板");
for (const [tpl, dst] of [
  ["CLAUDE.template.md", "CLAUDE.md"],
  ["AGENTS.template.md", "AGENTS.md"],
  ["trae-project_rules.template.md", path.join(".trae", "rules", "project_rules.md")],
]) {
  const a = fs.readFileSync(path.join(tplDir, tpl));
  const b = exists(path.join(proj, dst)) ? fs.readFileSync(path.join(proj, dst)) : null;
  check(`规则文件 ${dst} 与模板逐字节相同`, b !== null && Buffer.compare(a, b) === 0);
}

// ═════════════════════════════════════════════ 2. 幂等
section("② 幂等：再跑一次不许有任何改动");

const before = new Map(walkRel(projHooks).map((f) => [f, fs.readFileSync(path.join(projHooks, f), "utf8")]));
const settingsBefore = read(projSettings);
const baksBefore = fs.readdirSync(path.join(proj, ".claude")).filter((f) => f.includes(".bak")).length;

const r2 = run(SCAFFOLD_EXT, argvBase);
check("第二次运行退出码 0", r2.code === 0, `实际 ${r2.code}\n${r2.out.slice(0, 600)}`);
check("输出说明 hook 已是最新版", /已是主副本的最新版/.test(r2.out), r2.out.slice(0, 500));
check("settings.json 内容未被改写", read(projSettings) === settingsBefore);
check("没有产生新的 .bak 备份", fs.readdirSync(path.join(proj, ".claude")).filter((f) => f.includes(".bak")).length === baksBefore);
let same = true;
for (const [f, txt] of before) if (read(path.join(projHooks, f)) !== txt) same = false;
check("hook 文件内容全部未变", same);

// ═════════════════════════════════════════════ 3. 漂移检测 + 修复闭环
section("③ 漂移检测与修复（验收 3 的机制层部分）");

const target = path.join(projHooks, "guard-bash.mjs");
fs.appendFileSync(target, "\n// ── 沙箱故意篡改（模拟项目内 hook 过期）\n", "utf8");

const rc = run(SCAFFOLD_EXT, [...argvBase, "--check"]);
check("--check 发现漂移时退出码 1", rc.code === 1, `实际 ${rc.code}`);
check("--check 报出「内容不同」", /内容不同/.test(rc.out), rc.out.slice(0, 600));
check("--check 没有写任何文件（漂移仍在）", read(target).includes("沙箱故意篡改"));

// env-doctor 的一致性检查（验收 3 的主体）
const reDrift = run(ENV_DOCTOR, ["--root", ws, "--project", proj, "--harness-root", HARNESS, "--json"]);
let edDrift = null;
try { edDrift = JSON.parse(reDrift.out); } catch { /* 下面断言会报 */ }
const driftCheck = edDrift?.checks?.find((c) => c.id === "drift");
check("env-doctor 报出 drift 不一致", !!driftCheck && driftCheck.level === "warn" && /不一致/.test(driftCheck.title),
  JSON.stringify(driftCheck ?? null).slice(0, 400));
check("env-doctor 的修复提示指向 scaffold-ext",
  !!driftCheck && /scaffold-ext\.mjs/.test(driftCheck.action ?? ""), driftCheck?.action ?? "");

// 同步修复
const r3 = run(SCAFFOLD_EXT, argvBase);
check("重跑后在项目内同步了被改动的 hook", /同步（覆盖）hook 1 个/.test(r3.out), r3.out.slice(0, 700));
check("原文件被留了 .bak-* 备份",
  fs.readdirSync(projHooks).some((f) => f.startsWith("guard-bash.mjs.bak-")));
check("同步后内容与主副本逐字节一致",
  Buffer.compare(fs.readFileSync(target), fs.readFileSync(path.join(masterHooks, "guard-bash.mjs"))) === 0);

const rc2 = run(SCAFFOLD_EXT, [...argvBase, "--check"]);
check("--check 现在退 0（一致）", rc2.code === 0, `实际 ${rc2.code}\n${rc2.out.slice(0, 500)}`);

const reOk = run(ENV_DOCTOR, ["--root", ws, "--project", proj, "--harness-root", HARNESS, "--json"]);
let edOk = null;
try { edOk = JSON.parse(reOk.out); } catch { /* 忽略 */ }
const driftOk = edOk?.checks?.find((c) => c.id === "drift");
check("env-doctor 现在报 drift 一致", !!driftOk && driftOk.level === "ok", JSON.stringify(driftOk ?? null).slice(0, 300));

// 第 5 批新加：env-doctor 在项目目录内跑时，**自动把 cwd 当项目**（终端模式的主路径）
const reAuto = run(ENV_DOCTOR, ["--root", ws, "--harness-root", HARNESS, "--json"], { cwd: proj });
let edAuto = null;
try { edAuto = JSON.parse(reAuto.out); } catch { /* 忽略 */ }
check("env-doctor 在项目目录内自动识别项目 = cwd（不需要 --project）",
  !!edAuto?.checks?.some((c) => c.id === "drift"), reAuto.out.slice(0, 300));
check("自动识别后 drift 判定为一致",
  edAuto?.checks?.find((c) => c.id === "drift")?.level === "ok",
  JSON.stringify(edAuto?.checks?.find((c) => c.id === "drift") ?? null).slice(0, 200));

// 反例：在工作区根跑（cwd == root）时不应把任何子目录当项目 → 一致性检查按原样跳过
const reRootCwd = run(ENV_DOCTOR, ["--root", ws, "--harness-root", HARNESS, "--json"], { cwd: ws });
let edRoot = null;
try { edRoot = JSON.parse(reRootCwd.out); } catch { /* 忽略 */ }
check("在工作区根跑时行为不变（一致性检查跳过，不误判项目）",
  /已跳过/.test(edRoot?.checks?.find((c) => c.id === "drift")?.title ?? ""),
  JSON.stringify(edRoot?.checks?.find((c) => c.id === "drift") ?? null).slice(0, 200));

// --no-overwrite：只报告不覆盖
fs.appendFileSync(target, "\n// ── 沙箱第二次篡改\n", "utf8");
const rNo = run(SCAFFOLD_EXT, [...argvBase, "--no-overwrite"]);
check("--no-overwrite 时保留被改文件并告警", /保留了内容不同的 hook/.test(rNo.out) && read(target).includes("沙箱第二次篡改"));
run(SCAFFOLD_EXT, argvBase);   // 复原
check("复原后一致", read(target) === read(path.join(masterHooks, "guard-bash.mjs")));

// ═════════════════════════════════════════════ 4. 护栏 / dry-run / remove
section("④ 边界：护栏、预演、撤销");

const rGuard = run(SCAFFOLD_EXT, ["--work-root", ws, "--harness-root", HARNESS, "--project", ws]);
check("拒绝把项目目录指向工作区根（退 2）", rGuard.code === 2 && /拒绝执行/.test(rGuard.out), rGuard.out.slice(0, 300));

const rGuard2 = run(SCAFFOLD_EXT, ["--work-root", ws, "--harness-root", HARNESS, "--project", HARNESS]);
check("拒绝把项目目录指向 AI-Dev-Harness\\", rGuard2.code === 2, rGuard2.out.slice(0, 300));

const fresh = path.join(ws, "dryrun-项目");
const rDry = run(SCAFFOLD_EXT, ["--work-root", ws, "--harness-root", HARNESS, "--project", fresh, "--dry-run"]);
check("--dry-run 不建项目目录", !exists(path.join(fresh, ".claude")), "发现 .claude 被创建了");
check("--dry-run 输出「预演」", /预演/.test(rDry.out));

const rRem = run(SCAFFOLD_EXT, [...argvBase, "--remove"]);
check("--remove 退 0", rRem.code === 0, `实际 ${rRem.code}`);
check("--remove 删掉了 .claude/hooks", !exists(projHooks));
check("--remove 删掉了 .claude/settings.json", !exists(projSettings));
check("--remove 不动规则文件（归 cleanup.ps1 管）", exists(path.join(proj, "AGENTS.md")));
check("--remove 不动 .harness\\", exists(path.join(proj, ".harness")));

// ═════════════════════════════════════════════ 5. 删掉重建（验收 4）
section("⑤ 删掉整目录重建（验收 4：流程可重复）");

fs.rmSync(proj, { recursive: true, force: true });
check("项目目录已删除", !exists(proj));

const r4 = run(SCAFFOLD_EXT, argvBase);
check("重建后再次运行退 0", r4.code === 0, `实际 ${r4.code}\n${r4.out.slice(0, 600)}`);
check("重建后 hooks 与主副本一致",
  walkRel(projHooks).every((f) =>
    Buffer.compare(fs.readFileSync(path.join(projHooks, f)), fs.readFileSync(path.join(masterHooks, f))) === 0));
const rc3 = run(SCAFFOLD_EXT, [...argvBase, "--check"]);
check("重建后 --check 退 0", rc3.code === 0, `实际 ${rc3.code}`);

// 真实主副本（工作区根）一个字节都没动
section("⑥ 没有污染真实工作区");

// 全程只动沙箱：真实工作区必须与开跑前**逐字节一致**
const polluted = [...realHooksBefore.entries()].filter(([f, txt]) => read(path.join(realHooks, f)) !== txt);
check(`真实 .claude/hooks 未被本自检台改动（${realHooksBefore.size} 个文件）`, polluted.length === 0,
  polluted.map(([f]) => f).join(", "));
check("真实 .claude/ 的文件清单没有变化（没多出 .bak / settings.json）",
  fs.readdirSync(realClaudeDir).sort().join("|") === realClaudeBefore,
  fs.readdirSync(realClaudeDir).sort().join(", "));
check("真实 AI-Dev-Harness/state/model-profiles 未被写",
  fs.readdirSync(path.join(HARNESS, "state", "model-profiles")).filter((f) => /\.bak-/.test(f)).length === 0);
  // 我的项目\ 现在带一个**骨架占位** .gitignore（让空目录能随仓库走 + 防止用户项目被误提交进 harness 仓库）。
  // 断言据此放宽成"除了骨架文件，不许有测试残留" —— 保护意图（测试不往真实项目文件夹写内容）不变。
  const realProjectEntries = exists(path.join(ROOT, "我的项目")) ? fs.readdirSync(path.join(ROOT, "我的项目")) : null;
  check("真实 我的项目\\ 里只有骨架占位（没有测试残留）",
    realProjectEntries !== null && realProjectEntries.every((f) => f === ".gitignore"),
    realProjectEntries ? realProjectEntries.join(", ") : "(目录不存在)");

// ───────────────────────────────────────────── 收尾
console.log(`\n${"─".repeat(60)}`);
console.log(`自检结果：${pass} 项通过、${fail} 项失败`);
if (failures.length) {
  console.log("失败项：");
  for (const f of failures) console.log(`  · ${f}`);
}
if (KEEP) console.log(`沙箱保留在 ${ws}（--keep）`);
else {
  try { fs.rmSync(ws, { recursive: true, force: true }); console.log("沙箱已清理"); }
  catch { console.log(`沙箱清理失败（可手动删）：${ws}`); }
}
process.exit(fail ? 1 : 0);
