#!/usr/bin/env node
/**
 * selftest-ext.mjs —— 扩展自检（第 2 段新增 · 由 内置\scripts\selftest.ps1 调用）
 * ============================================================
 * 为什么要有它：`内置\scripts\selftest.ps1` 的老清单只有 27 项，覆盖的是"老 harness"的结构；
 * 第 1~2 段新增的东西（`.claude\` 机制层、`自定义\bin\`、`自定义\scripts\`、两个能力表、
 * 规则源.md、引擎适配\、prompt-模板\、日志中心，以及"项目内不再有 .harness\logs"）
 * 一项都没查。**清单不覆盖 = 文件被删了也发现不了。**
 *
 * 它比"文件在不在"多查四类**语义一致性**（这几类正是历史事故的真实形状）：
 *   1. `.claude\settings.json` 里引用的每个 hook 脚本是否真的存在（少一个 → hooks 静默失效）；
 *   2. 8 个命令工具 × 3 种形态（无扩展名 / `.cmd` / `.ps1`）是否齐全（少一种 → 某些 shell 绕过包装）；
 *   3. 内置区 `*.ps1` 是否都是 **UTF-8 with BOM**（PowerShell 5.1 按 ANSI 读中文会解析失败），
 *      同时 `run.sh` 必须**无 BOM**（bash 不认 BOM）；
 *   4. 全仓**源码**里是否还残留 `.harness\logs`（第 2 段已把日志迁到工作区根 日志\；
 *      残留一处就等于"项目里迟早还会长出一个 logs 目录"）。
 *
 * 退出码：0 = 全绿；1 = 有 ✗。用法：node AI-Dev-Harness\自定义\scripts\selftest-ext.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLogCenter, resolveLogRoot } from "./lib/log-center.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\自定义\scripts
const HARNESS_ROOT = path.resolve(SCRIPT_DIR, "..", ".."); // …\AI-Dev-Harness
const WORK_ROOT = path.resolve(HARNESS_ROOT, ".."); // …\工作区根
const CUSTOM = path.join(HARNESS_ROOT, "自定义");
const BUILTIN = path.join(HARNESS_ROOT, "内置");
const CLAUDE_DIR = path.join(WORK_ROOT, ".claude");

let pass = 0;
let fail = 0;
const fails = [];

function check(title, ok, detail = "") {
  if (ok) {
    pass++;
    process.stdout.write(`  ✓ ${title}\n`);
  } else {
    fail++;
    fails.push(title + (detail ? ` —— ${detail}` : ""));
    process.stdout.write(`  ✗ ${title}${detail ? ` —— ${detail}` : ""}\n`);
  }
}

function section(t) {
  process.stdout.write(`\n${t}\n`);
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function hasBom(p) {
  try {
    const b = Buffer.alloc(3);
    const fd = fs.openSync(p, "r");
    try {
      fs.readSync(fd, b, 0, 3, 0);
    } finally {
      fs.closeSync(fd);
    }
    return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  } catch {
    return false;
  }
}

/** 递归列文件（跳过 .git / node_modules），返回绝对路径 */
function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

async function main() {
  process.stdout.write("═".repeat(70) + "\n");
  process.stdout.write("  扩展自检（第 2 段 · 新增目录与语义一致性）\n");
  process.stdout.write("═".repeat(70) + "\n");

  // ── 1. 机制层 .claude\
  section("【1】机制层 .claude\\（配置与 hooks）");
  const settingsPath = path.join(CLAUDE_DIR, "settings.json");
  const settings = readJson(settingsPath);
  check(".claude\\settings.json 存在且是合法 JSON", !!settings, settingsPath);
  if (settings) {
    const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "Stop", "SessionStart"];
    const missingEvents = events.filter((e) => !settings.hooks || !settings.hooks[e]);
    check(`hooks 覆盖 ${events.length} 个事件`, missingEvents.length === 0, `缺：${missingEvents.join("、")}`);
    check("statusLine 已注册（上下文水位的唯一来源）", !!settings.statusLine);
    check(
      `autoCompactWindow = ${settings.autoCompactWindow}（锁定决策 1：102400）`,
      Number(settings.autoCompactWindow) === 102400,
      `实际 ${settings.autoCompactWindow}`,
    );

    // 引用的每个脚本都要真的存在 —— 少一个就是"hooks 静默失效"
    const refs = [];
    for (const list of Object.values(settings.hooks ?? {})) {
      for (const item of list ?? []) {
        for (const h of item?.hooks ?? []) for (const a of h?.args ?? []) if (/\.(mjs|js|cjs)$/i.test(a)) refs.push(a);
      }
    }
    for (const a of settings.statusLine?.args ?? []) if (/\.(mjs|js|cjs)$/i.test(a)) refs.push(a);
    const missingRefs = [...new Set(refs)].filter((r) => !exists(path.join(WORK_ROOT, r)));
    check(`settings.json 引用的 ${new Set(refs).size} 个脚本都在`, missingRefs.length === 0, missingRefs.join("、"));
  }

  const hookFiles = [
    "guard-bash.mjs",
    "guard-tools.mjs",
    "shape-output.mjs",
    "compact-instructions.mjs",
    "inject-rules.mjs",
    "on-stop.mjs",
    "statusline.mjs",
    "verify-gate.mjs",
    "log-summary.mjs",
    "lib/policy.mjs",
    "lib/log-center.mjs",
    "lib/learn.mjs",
  ];
  const missingHooks = hookFiles.filter((f) => !exists(path.join(CLAUDE_DIR, "hooks", f)));
  check(`.claude\\hooks\\ 下 ${hookFiles.length} 个文件齐全（含 lib\\）`, missingHooks.length === 0, missingHooks.join("、"));

  // ── 2. 命令包装层 自定义\bin\
  section("【2】命令包装层 自定义\\bin\\（8 工具 × 3 形态）");
  const tools = ["sed", "perl", "python", "python3", "sleep", "playwright", "npx", "npm"];
  const missingForms = [];
  for (const t of tools) {
    for (const form of ["", ".cmd", ".ps1"]) {
      if (!exists(path.join(CUSTOM, "bin", `${t}${form}`))) missingForms.push(`${t}${form || "(无扩展名)"}`);
    }
  }
  check(`${tools.length} 个工具 × 3 种形态（无扩展名 / .cmd / .ps1）齐全`, missingForms.length === 0, missingForms.join("、"));
  check("包装器实现 _log.mjs 存在", exists(path.join(CUSTOM, "bin", "_log.mjs")));
  check("_env.sh（BASH_ENV 兜底）存在", exists(path.join(CUSTOM, "bin", "_env.sh")));
  check("自定义\\bin\\README.md 存在（文档与行为对齐）", exists(path.join(CUSTOM, "bin", "README.md")));

  // ── 3. 能力层 自定义\scripts\
  section("【3】能力层 自定义\\scripts\\");
  const scripts = [
    "env-doctor.mjs",
    "probe-model.mjs",
    "probe-engines.mjs",
    "scaffold-ext.mjs",
    "gen-rules.mjs",
    "build-prompt.mjs",
    "audit.mjs",
    "purity-check.mjs",
    "selftest-ext.mjs",
    "audit-rules.json",
    "lib/resolve-command.mjs",
    "lib/engine-detect.mjs",
    "lib/model-capability.mjs",
    "lib/log-center.mjs",
  ];
  const missingScripts = scripts.filter((f) => !exists(path.join(CUSTOM, "scripts", f)));
  check(`自定义\\scripts\\ 下 ${scripts.length} 个必备文件齐全`, missingScripts.length === 0, missingScripts.join("、"));
  const tests = [
    "hooks-selftest.mjs",
    "context-selftest.mjs",
    "scaffold-selftest.mjs",
    "probe-selftest.mjs",
    "engine-probe-selftest.mjs",
    "wrappers-selftest.mjs",
    "model-learning-selftest.mjs",
    "purity-selftest.mjs",
    "rules-selftest.mjs",
  ];
  const missingTests = tests.filter((f) => !exists(path.join(CUSTOM, "scripts", "tests", f)));
  check(`${tests.length} 个自检台齐全（tests\\，第 4 段新增 purity / rules）`, missingTests.length === 0, missingTests.join("、"));
  check("audit-rules.json 可解析", !!readJson(path.join(CUSTOM, "scripts", "audit-rules.json")));

  // ── 4. 能力表 / 规则源 / 引擎适配 / prompt 模板
  section("【4】两个能力表 · 规则源 · 引擎适配 · prompt 模板");
  const modelTable = readJson(path.join(CUSTOM, "模型能力表.json"));
  const engineTable = readJson(path.join(CUSTOM, "引擎能力表.json"));
  check("模型能力表.json 可解析", !!modelTable);
  check(
    "模型能力表.json 含保守默认（conservative.autoCompactWindow）",
    !!modelTable?.conservative?.autoCompactWindow,
    String(modelTable?.conservative?.autoCompactWindow ?? "缺"),
  );
  check("引擎能力表.json 可解析", !!engineTable);
  check("引擎能力表.json 含 engines 段", !!engineTable?.engines);
  check("规则源.md 存在（gen-rules 的唯一真源）", exists(path.join(CUSTOM, "规则源.md")));
  const adapters = ["README.md", "codex/README.md", "dsh/README.md", "traecode/README.md"];
  const missingAdapters = adapters.filter((f) => !exists(path.join(CUSTOM, "引擎适配", f)));
  check("引擎适配\\ 四份文档齐全（codex / dsh / traecode / 总说明）", missingAdapters.length === 0, missingAdapters.join("、"));
  // ★ 第 3 段新增：引擎能力矩阵（人读版）+ Claude 桌面端适配说明 + 引擎选择落盘位置的忽略规则
  check("引擎能力矩阵.md 存在（三档强制力：hooks > 命令包装 > 启动词）",
    exists(path.join(CUSTOM, "引擎适配", "引擎能力矩阵.md")));
  check("引擎适配\\claude-code\\README.md 存在（终端 vs 桌面端的生效条件）",
    exists(path.join(CUSTOM, "引擎适配", "claude-code", "README.md")));
  const promptTpls = [
    "基础.md",
    "硬规则.md",
    "引擎/codex-cli.md",
    "引擎/claude-code.md",
    "引擎/deepseek-harness.md",
    "引擎/traecode-cli.md",
  ];
  const missingTpls = promptTpls.filter((f) => !exists(path.join(CUSTOM, "prompt-模板", f)));
  check("prompt-模板\\ 齐全（基础 + 硬规则 + 4 个引擎模板）", missingTpls.length === 0, missingTpls.join("、"));

  // ── 5. 内置区编码
  section("【5】内置区编码（UTF-8 with BOM / run.sh 无 BOM）");
  const ps1s = walk(BUILTIN).filter((f) => f.toLowerCase().endsWith(".ps1"));
  const noBom = ps1s.filter((f) => !hasBom(f));
  check(
    `内置区 ${ps1s.length} 个 *.ps1 全部是 UTF-8 with BOM`,
    noBom.length === 0,
    noBom.map((f) => path.basename(f)).join("、"),
  );
  const runSh = path.join(BUILTIN, "engine", "run.sh");
  check("run.sh 无 BOM（bash 不认 BOM）", exists(runSh) && !hasBom(runSh));

  // ── 6. 日志中心（第 2 段）
  section("【6】日志中心（工作区根 日志\\）");
    const logRoot = resolveLogRoot({ workRoot: WORK_ROOT });
    const categories = ["01-会话", "02-命令", "03-验证", "04-拦截", "05-清理", "06-引擎", "07-审计", "08-模型"];
    const lc = await loadLogCenter();
    check(".claude\\hooks\\lib\\log-center.mjs（日志中心唯一实现）可加载", !!lc);
    // 全新克隆里 日志\ 可能还不存在（git 不跟踪空目录）；日志中心本来就是"用到即建"，
    // 所以先做一次幂等初始化再断言布局 —— 检查的是"日志中心可用"，不是"目录恰好已存在"。
    if (lc?.ensureLayout) lc.ensureLayout(logRoot);
    const missingCats = categories.filter((c) => !exists(path.join(logRoot, c)));
    check(`日志\\ 下 ${categories.length} 个分类子目录齐全`, missingCats.length === 0, missingCats.join("、"));
    check("日志\\README.md 存在（每个子目录记什么、怎么检索）", exists(path.join(logRoot, "README.md")));
    if (lc) {
    const w = lc.probeWritable(logRoot);
    check("日志根可写（写不进去时只出声、不阻塞；但这里必须先证明平时是能写的）", w.writable, String(w.error ?? ""));
  }
  check("工作区根下没有 .harness\\logs\\（第 2 段已取消这个位置）", !exists(path.join(WORK_ROOT, ".harness", "logs")));

  // ── 7. 迁移完整性：源码里不许再有 .harness\logs 引用
  section("【7】迁移完整性（源码里不再引用 .harness\\logs）");
  const codeExt = new Set([".mjs", ".js", ".cjs", ".ps1", ".sh", ".bat", ".json"]);
  // 说明（为什么这样判）：
  //   · **注释行**里出现 `.harness\logs` 是好事 —— 那是"我们为什么把它迁走"的说明，
  //     一刀切禁掉等于禁止解释历史，反而更糟。所以只查**非注释行**。
  //   · 有两处代码**必须**提到这个名字，因为它们干的正是"发现这个残留"这件事：
  //       `scaffold-ext.mjs` 的 checkLegacyLogs()（探测老项目里的残留目录）
  //       `tests\scaffold-selftest.mjs`（断言"项目内不该有它"）
  //     只豁免这两个文件，而且在报告里点名说明 —— 豁免范围写死，不让它慢慢变大。
  const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*|#|<!--|rem\b)/i;
  const ALLOW_FILES = [
    path.join(CUSTOM, "scripts", "scaffold-ext.mjs"),
    path.join(CUSTOM, "scripts", "tests", "scaffold-selftest.mjs"),
  ];
  const hits = [];
  for (const root of [CLAUDE_DIR, CUSTOM, BUILTIN]) {
    for (const f of walk(root)) {
      if (!codeExt.has(path.extname(f).toLowerCase())) continue;
      if (f.includes(`${path.sep}设计文档${path.sep}`)) continue; // 历史方案文档不参与
      if (ALLOW_FILES.includes(f)) continue; // 探测残留的代码本身（见上）
      let text;
      try {
        text = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/\.harness[\\/]logs/.test(line)) return;
        if (COMMENT_LINE.test(line)) return; // 注释/文档行不算
        hits.push(`${path.relative(WORK_ROOT, f)}:${i + 1} ${line.trim().slice(0, 80)}`);
      });
    }
  }
  check(
    "没有源码还引用 .harness\\logs（豁免 2 处「探测残留」的代码）",
    hits.length === 0,
    hits.slice(0, 8).join("；"),
  );

  // ── 8. 模板根残留
  section("【8】模板根残留");
  const baks = (() => {
    try {
      return fs.readdirSync(CLAUDE_DIR).filter((f) => /^settings\.json\.bak-/.test(f));
    } catch {
      return [];
    }
  })();
  check("没有 .claude\\settings.json.bak-* 备份残留（已进 .gitignore，也不该留在盘上）", baks.length === 0, baks.join("、"));
  check("工作区根没有 .harness\\ 残留（运行态由 scaffold-ext 按需创建）", !exists(path.join(WORK_ROOT, ".harness")));
  const gi = (() => {
    try {
      return fs.readFileSync(path.join(WORK_ROOT, ".gitignore"), "utf8");
    } catch {
      return "";
    }
  })();
  const giLines = gi.split(/\r?\n/).map((l) => l.trim());
    // 日志两条自"克隆可用性"修复起变为：日志**内容**忽略（日志/*）+ 放行说明文件（!日志/README.md）。
    // 必须用这种写法：被忽略目录里的文件无法用 ! 单独放行。
    const giNeed = ["日志/*", "!日志/README.md", ".harness/", ".claude/state/", ".claude/*.bak-*"];
    const giMissing = giNeed.filter((l) => !giLines.includes(l));
    check(`.gitignore 含 ${giNeed.length} 条关键规则（日志内容忽略 + 放行日志说明 / 运行态 / 备份）`, giMissing.length === 0, giMissing.join("、"));
    check("我的项目\\.gitignore 存在（空目录随仓库走 + 防误提交）",
      exists(path.join(WORK_ROOT, "我的项目", ".gitignore")));

  // ── 9. 第 3 段新增：状态目录 / 引擎选择 / 自主学习
  section("【9】第 3 段：HARNESS_STATE_DIR · 引擎选择 · 自主学习");
  check("AI-Dev-Harness\\state\\.gitignore 存在（引擎选择与模型画像不进仓库）",
    exists(path.join(HARNESS_ROOT, "state", ".gitignore")));
  const specSkill = path.join(CUSTOM, "skills", "spec", "SKILL.md");
  check("自定义\\skills\\spec\\SKILL.md 存在（P3-1：按 skills 约定补齐外壳）", exists(specSkill));
  if (exists(specSkill)) {
    const s = fs.readFileSync(specSkill, "utf8");
    check("spec\\SKILL.md 有 frontmatter（name + description）", /^---[\s\S]*name:\s*spec/m.test(s) && /description:/.test(s));
    check("spec\\SKILL.md 指向两个角色文档（spec-writer / spec-checker）",
      /spec-writer\.md/.test(s) && /spec-checker\.md/.test(s));
  }
  // 引擎判定只有一份实现：四个调用方都必须指向它
  const resolverUsers = [
    path.join(CUSTOM, "scripts", "probe-engines.mjs"),
    path.join(CUSTOM, "scripts", "env-doctor.mjs"),
    path.join(CUSTOM, "scripts", "tests", "engine-probe-selftest.mjs"),
    path.join(BUILTIN, "adapters", "_detect.ps1"),
  ];
  const noResolver = resolverUsers.filter((f) => {
    try { return !/engine-detect\.mjs/.test(fs.readFileSync(f, "utf8")); } catch { return true; }
  });
  check("引擎判定只有一份实现（probe-engines / env-doctor / 自检台 / _detect.ps1 都指向 engine-detect.mjs）",
    noResolver.length === 0, noResolver.map((f) => path.basename(f)).join("、"));

  // ── 10. 技能索引（省 token 的第一道门）
  section("【10】技能索引（扫技能只读摘要：list-skills.mjs）");
  const listSkills = path.join(CUSTOM, "scripts", "list-skills.mjs");
  check("自定义\\scripts\\list-skills.mjs 存在", exists(listSkills));
  if (exists(listSkills)) {
    const runLs = (arg) => spawnSync(process.execPath, [listSkills, ...(arg ? [arg] : ["--json"])], { encoding: "utf8" });
    const js = runLs(null);
    let idx = null;
    try { idx = JSON.parse(js.stdout); } catch { /* 下面按失败处理 */ }
    check("list-skills.mjs --json 能跑并且是合法 JSON", idx !== null, `status=${js.status} ${(js.stderr || "").trim()}`);
    if (idx) {
      const skillDirs = fs.readdirSync(path.join(CUSTOM, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory());
      check(`索引条目数 = 技能目录数（${idx.count}）`, idx.count === skillDirs.length, `索引 ${idx.count} / 目录 ${skillDirs.length}`);
      check(`索引体积 ${idx.indexBytes} B 未超预算 ${idx.indexBudgetBytes} B`, idx.indexBytes <= idx.indexBudgetBytes);
      const noFm = idx.rows.filter((r) => r.noFrontmatter);
      check("每个技能都有 frontmatter（name + description）", noFm.length === 0, noFm.map((r) => r.dir).join("、"));
      check("索引展示的正文合计远大于索引本身（证明「只读摘要」确实省）",
        idx.totalBytes > idx.indexBytes * 10, `正文 ${idx.totalBytes} B vs 索引 ${idx.indexBytes} B`);
    }
    const chk = runLs("--check");
    check("skills\\README.md 里的索引与现状一致（--check）", chk.status === 0, `status=${chk.status} ${(chk.stdout || "").trim()}`);
    // 行尾无关性：本仓库 core.autocrlf=true，本地 LF / clone 后 CRLF —— 体积口径必须一致，
    // 否则会出现"本地 --check 通过、克隆后报漂移"（这真的发生过一次）。
    try {
      const { contentBytes } = await import(pathToFileURL(listSkills).href);
      check("索引体积口径与行尾无关（LF 与 CRLF 算出同一个数）",
        contentBytes("a\r\nb\r\n") === contentBytes("a\nb\n"));
    } catch {
      check("索引体积口径与行尾无关（LF 与 CRLF 算出同一个数）", false, "无法导入 contentBytes");
    }
  }
  // 规则层：硬规则正文里必须写明"技能只读摘要"
  const rulesTpl = path.join(CUSTOM, "项目规则模板", "AGENTS.template.md");
  check("规则模板里写明「技能只读摘要」（防全量读 skills）",
    exists(rulesTpl) && /技能只读摘要/.test(fs.readFileSync(rulesTpl, "utf8")));
  const guardTools = path.join(WORK_ROOT, ".claude", "hooks", "guard-tools.mjs");
  check("guard-tools.mjs 含 G12 守门（技能正文超 8 KB 即提醒）",
    exists(guardTools) && /G12-skill-body-oversize/.test(fs.readFileSync(guardTools, "utf8")));

  // ── 汇总
  process.stdout.write("\n" + "─".repeat(70) + "\n");
  process.stdout.write(`扩展自检结果：${pass} 项通过、${fail} 项失败\n`);
  if (fail) {
    process.stdout.write("失败项：\n");
    for (const f of fails) process.stdout.write(`  - ${f}\n`);
  } else {
    process.stdout.write("全部通过。\n");
  }
  process.stdout.write("─".repeat(70) + "\n");
  return fail ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[selftest-ext] 自身异常：${err?.stack || err}\n`);
    process.exit(1);
  });
