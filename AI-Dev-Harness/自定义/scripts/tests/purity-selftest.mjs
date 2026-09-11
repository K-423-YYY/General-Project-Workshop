/**
 * purity-selftest.mjs —— 交付流程（清理两段式 + 纯净度自检）的自检台（第 4 段）
 * ============================================================
 * 守什么（锁定决策 8 + 前提 5.1 + 前提 4）：
 *   ① purity-check.mjs：干净项目退 0；有脚手架残留退 1；有 harness 路径引用退 1；
 *   ② cleanup.ps1 第一段（不带 -Confirm）：**一个文件都不删**、退 3、清单落 日志\05-清理\；
 *   ③ cleanup.ps1 第二段（-Confirm）：归档 .harness\ → 删脚手架 → 纯净度自检 → 报告落盘；
 *   ④ 两段式跑完，项目目录里只剩下项目自己的文件。
 * 全部在临时沙箱里跑（项目目录是临时目录；归档目录用临时项目名，跑完删除）。
 *
 * 跑法：node AI-Dev-Harness/自定义/scripts/tests/purity-selftest.mjs [--keep]
 * ============================================================
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // …\自定义\scripts\tests
const SCRIPTS = path.resolve(HERE, "..");                    // …\自定义\scripts
const CUSTOM = path.resolve(SCRIPTS, "..");                  // …\自定义
const HARNESS = path.resolve(CUSTOM, "..");                  // …\AI-Dev-Harness
const ROOT = path.resolve(HARNESS, "..");                    // …\General-Project-Workshop

const PURITY = path.join(SCRIPTS, "purity-check.mjs");
const CLEANUP = path.join(HARNESS, "内置", "scripts", "cleanup.ps1");
const LOG_CLEAN = path.join(ROOT, "日志", "05-清理");
const KEEP = process.argv.includes("--keep");

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(`${name}${detail ? ` —— ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function skipped(name, why) { skip += 1; console.log(`  ○ ${name}（跳过：${why}）`); }
function section(t) { console.log(`\n${t}`); }

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const listFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(dir);
  return out;
};
const logSnapshot = () => new Set(listFiles(LOG_CLEAN).map((f) => path.basename(f)));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "purity-selftest-"));
const projectName = `purity-selftest-${path.basename(sandbox).split("-").pop()}`;
const project = path.join(sandbox, projectName);
const archive = path.join(HARNESS, "state", projectName);
const logBefore = logSnapshot();

console.log("交付流程自检台（清理两段式 + 纯净度自检）");

// ════════════════════════════════════════════════════════════
section("① purity-check.mjs：三种情形");

const cleanProj = path.join(sandbox, "clean-proj");
fs.mkdirSync(path.join(cleanProj, "src"), { recursive: true });
fs.writeFileSync(path.join(cleanProj, "src", "main.js"), "console.log(1)\n", "utf8");
fs.writeFileSync(path.join(cleanProj, "README.md"), "# demo\n\n运行：node src/main.js\n", "utf8");
const r1 = run(process.execPath, [PURITY, "--project", cleanProj, "--json"]);
let j1 = null;
try { j1 = JSON.parse(r1.stdout); } catch { /* 下面按失败处理 */ }
check("干净项目 → 退出 0", r1.status === 0, `status=${r1.status} ${r1.stderr.trim()}`);
check("干净项目 → clean=true 且无残留/引用", j1 && j1.clean === true && j1.leftovers.length === 0 && j1.refs.length === 0);

const dirtyProj = path.join(sandbox, "dirty-proj");
fs.mkdirSync(path.join(dirtyProj, ".harness", "logs"), { recursive: true });
fs.mkdirSync(path.join(dirtyProj, ".claude", "hooks"), { recursive: true });
fs.mkdirSync(path.join(dirtyProj, ".trae", "rules"), { recursive: true });
fs.writeFileSync(path.join(dirtyProj, "AGENTS.md"), "# rules\n", "utf8");
fs.writeFileSync(path.join(dirtyProj, "CLAUDE.md"), "# rules\n", "utf8");
const r2 = run(process.execPath, [PURITY, "--project", dirtyProj, "--json"]);
let j2 = null;
try { j2 = JSON.parse(r2.stdout); } catch { /* 下面按失败处理 */ }
check("有脚手架残留 → 退出 1", r2.status === 1, `status=${r2.status}`);
check("残留清单命中 5 类（.claude / .harness / .trae / AGENTS.md / CLAUDE.md）",
  j2 && new Set(j2.leftovers.map((l) => path.basename(l.path))).size === 5,
  j2 ? j2.leftovers.map((l) => path.basename(l.path)).join(", ") : "无 JSON");

const refProj = path.join(sandbox, "ref-proj");
fs.mkdirSync(refProj, { recursive: true });
fs.writeFileSync(path.join(refProj, "方案.md"), "本项目使用上级目录的 ..\\AI-Dev-Harness\\ 配置\n", "utf8");
const r3 = run(process.execPath, [PURITY, "--project", refProj, "--json"]);
let j3 = null;
try { j3 = JSON.parse(r3.stdout); } catch { /* 下面按失败处理 */ }
check("有 harness 路径引用 → 退出 1 且点名文件:行", r3.status === 1 && j3 && j3.refs.length === 1 && j3.refs[0].line === 1,
  `status=${r3.status} refs=${j3 ? JSON.stringify(j3.refs) : "无 JSON"}`);

// ════════════════════════════════════════════════════════════
section("② cleanup.ps1 第一段：只出清单，一个文件都不删");

fs.mkdirSync(path.join(project, ".harness", "logs"), { recursive: true });
fs.mkdirSync(path.join(project, ".claude", "hooks"), { recursive: true });
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, ".harness", "logs", "a.log"), "x\n", "utf8");
fs.writeFileSync(path.join(project, "AGENTS.md"), "# rules\n", "utf8");
fs.writeFileSync(path.join(project, "src", "main.js"), "console.log(1)\n", "utf8");

const planRun = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", CLEANUP, "-ProjectRoot", project]);
check("退出码 = 3（清单已给、等你确认）", planRun.status === 3, `status=${planRun.status}`);
check("打印「将删除」清单", /将删除/.test(planRun.stdout) && /AGENTS\.md/.test(planRun.stdout));
check("打印「将保留」清单", /将保留/.test(planRun.stdout) && /src/.test(planRun.stdout));
check("项目里什么都没删（.harness / .claude / AGENTS.md 仍在）",
  fs.existsSync(path.join(project, ".harness")) && fs.existsSync(path.join(project, ".claude")) && fs.existsSync(path.join(project, "AGENTS.md")));
check("清单已落盘到 日志\\05-清理\\（cleanup-plan-*.md）",
  listFiles(LOG_CLEAN).some((f) => path.basename(f).startsWith("cleanup-plan-")));

// ════════════════════════════════════════════════════════════
section("③ cleanup.ps1 第二段：-Confirm 执行 + 纯净度自检");

const confirmRun = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", CLEANUP, "-ProjectRoot", project, "-Confirm"]);
check("退出码 = 0", confirmRun.status === 0, `status=${confirmRun.status}\n${confirmRun.stdout}`);
check("报告里包含纯净度自检结论", /纯净度自检/.test(confirmRun.stdout) && /结论|通过/.test(confirmRun.stdout));
check("脚手架已删（.harness / .claude / AGENTS.md 全部消失）",
  !fs.existsSync(path.join(project, ".harness")) && !fs.existsSync(path.join(project, ".claude")) && !fs.existsSync(path.join(project, "AGENTS.md")));
check("项目文件保留（src\\main.js 还在）", fs.existsSync(path.join(project, "src", "main.js")));
check(".harness\\ 已归档到 state\\<项目名>\\harness\\",
  fs.existsSync(path.join(archive, "harness", "logs", "a.log")));
check("清理报告已落盘（cleanup-*.md）", listFiles(LOG_CLEAN).some((f) => /^cleanup-\d{8}-\d{6}\.md$/.test(path.basename(f))));

// ════════════════════════════════════════════════════════════
section("④ 收尾：清理后项目目录真的只剩项目自己");

const afterRun = run(process.execPath, [PURITY, "--project", project, "--quiet"]);
check("清理后 purity-check 退出 0（结论：通过）", afterRun.status === 0, `status=${afterRun.status} ${afterRun.stdout.trim()}`);
const remain = fs.readdirSync(project).sort();
check("项目里只剩 src（.claude / .harness / AGENTS.md 都没了）",
  remain.length === 1 && remain[0] === "src", remain.join(", "));

// ════════════════════════════════════════════════════════════
// 这一段是端到端真跑时抓到的缺陷回归：scaffold-ext.mjs 会往项目 .gitignore 里写
// `.harness/` 与 `.claude/state/`，清理时若不撤掉，纯净度自检就会判"项目里还有 .harness 字样"→ 永远不过。
section("⑤ .gitignore 残留（scaffold-ext 自己写进去的行必须自己撤掉）");

const giProj = path.join(sandbox, "gitignore-proj");
fs.mkdirSync(path.join(giProj, "src"), { recursive: true });
fs.writeFileSync(path.join(giProj, "src", "main.js"), "console.log(1)\n", "utf8");
const scaffoldExt = path.join(SCRIPTS, "scaffold-ext.mjs");
const applyRun = run(process.execPath, [scaffoldExt, "--project", giProj]);
check("scaffold-ext.mjs 应用成功（退出 0）", applyRun.status === 0, `status=${applyRun.status}`);
const giAfterApply = fs.readFileSync(path.join(giProj, ".gitignore"), "utf8");
check(".gitignore 里确实写进了 .harness/ 与 .claude/state/", /\.harness\//.test(giAfterApply) && /\.claude\/state\//.test(giAfterApply));
const prePurity = run(process.execPath, [PURITY, "--project", giProj, "--json"]);
check("未清理时 purity-check 退出 1（能被自检抓住）", prePurity.status === 1);

const removeRun = run(process.execPath, [scaffoldExt, "--project", giProj, "--remove"]);
check("scaffold-ext.mjs --remove 退出 0", removeRun.status === 0, `status=${removeRun.status}`);
const giAfterRemove = fs.existsSync(path.join(giProj, ".gitignore")) ? fs.readFileSync(path.join(giProj, ".gitignore"), "utf8") : "";
check("--remove 已撤掉 .gitignore 里的 .harness/ 与 .claude/state/ 行",
  !/\.harness\//.test(giAfterRemove) && !/\.claude\/state\//.test(giAfterRemove), giAfterRemove.trim() || "(文件已删除)");
// 注意：--remove 只管 .claude\（规则文件与 .harness\ 归 cleanup.ps1 管），所以这里断言的是
// "harness 路径引用归零" —— 这一段要防的正是那种引用。
const postPurity = run(process.execPath, [PURITY, "--project", giProj, "--json"]);
let j4 = null;
try { j4 = JSON.parse(postPurity.stdout); } catch { /* 下面按失败处理 */ }
check("撤销后 harness 路径引用归零（.gitignore 不再提 .harness / .claude）",
  j4 && j4.refs.length === 0, j4 ? `refs=${j4.refs.length}` : "无 JSON");

// ───────────────────────────────────────────── 卫生：把自检台自己产生的东西收干净
section("⑥ 卫生：本次自检留下的东西都收掉");
let cleaned = true;
try { fs.rmSync(archive, { recursive: true, force: true }); } catch { cleaned = false; }
for (const f of listFiles(LOG_CLEAN)) {
  if (!logBefore.has(path.basename(f)) && !process.argv.includes("--keep-logs")) {
    try { fs.rmSync(f, { force: true }); } catch { cleaned = false; }
  }
}
check("临时项目名下的 state\\<name>\\ 归档已删除", !fs.existsSync(archive));
check("本次自检新增的 日志\\05-清理\\ 文件已删除", new Set(listFiles(LOG_CLEAN).map((f) => path.basename(f))).size === logBefore.size);

console.log(`\n${"─".repeat(64)}`);
console.log(`自检结果：${pass} 项通过、${fail} 项失败、${skip} 项跳过`);
if (failures.length) { console.log("失败项："); for (const f of failures) console.log(`  · ${f}`); }
if (!cleaned) console.log("⚠️ 有临时产物没能自动删除，请手动检查 state\\ 与 日志\\05-清理\\");
if (KEEP) console.log(`沙箱保留在 ${sandbox}`);
else {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); console.log("沙箱已清理"); }
  catch { console.log(`沙箱清理失败（可手动删）：${sandbox}`); }
}
process.exit(fail ? 1 : 0);
