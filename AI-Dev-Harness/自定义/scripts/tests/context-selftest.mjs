/**
 * context-selftest.mjs —— 第 3 批（上下文治理与可见性）的零成本自检台
 *
 * 做法与第 2 批的 hooks-selftest.mjs 同一路数：把构造好的 stdin JSON 直接喂给 hook 脚本，读它的 stdout 判定。
 * 不启动任何模型、不消耗任何额度。
 *
 * ★ 关键设计：所有测试都在**临时沙箱目录**里跑（把 ev.cwd 指向沙箱），
 *   所以不会往真实项目里写 HANDOFF / 日志 / 状态。
 *
 * 第 2 段（日志中心）：日志已从"项目内 .harness\logs\"迁到**工作区根**的 日志\。
 *   本自检台对每个 hook 子进程显式设 `HARNESS_LOG_ROOT`，指向**每个沙箱各自的** 日志\ ——
 *   这样既验证新位置真的生效，又绝不污染真日志中心、也不会让各用例互相读到对方的日志。
 *
 * 覆盖：04-实施批次与验收.md 第 3 批的 8 项验收标准（能离线判定的部分）
 *   + 两个高危点的边界用例（截断必须保留失败项、Stop 不许死循环）
 *
 * 跑法：node AI-Dev-Harness/自定义/scripts/tests/context-selftest.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../.."); // → General-Project-Workshop
const H = (f) => path.join(ROOT, ".claude/hooks", f);

/**
 * ★ 第 3 段（P2-2/P2-5 同源修复）：本自检台有 5 项是**真跑 bash** 的端到端断言
 * （G10 改写出来的命令交给 bash 实际执行）。旧实现 `spawnSync("bash")` 在本机解析到
 * C:\Windows\System32\bash.exe（WSL 垫片）→ E_ACCESSDENIED，于是永远 5 项红。
 * 那是**自检台自己的环境假设错了**，不是产品坏了。
 * 现在：用 harness 侧的统一 bash 判定（引擎探测同一份规则）；找不到真 bash 就明确 skip。
 */
const { bashCommand } = await import(new URL("../lib/engine-detect.mjs", import.meta.url).href);
const REAL_BASH = bashCommand();

const GUARD = H("guard-bash.mjs");
const SHAPE = H("shape-output.mjs");
const COMPACT = H("compact-instructions.mjs");
const STOP = H("on-stop.mjs");
const INJECT = H("inject-rules.mjs");
const STATUSLINE = H("statusline.mjs");
const VERIFY = H("verify-gate.mjs");

// ───────────────────────────────────────────── 迷你测试台

let pass = 0;
let fail = 0;
let skipCount = 0;
const failures = [];

/** 环境不满足时明确 skip（不算失败）—— 第 3 段：本机没有真 bash 时不再假红 */
function skip(name, why) {
  skipCount += 1;
  console.log(`  ○ ${name}（跳过：${why}）`);
}

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
function section(t) {
  console.log(`\n${t}`);
}

let seq = 0;
const newSid = (tag) => `b3-${tag}-${Date.now()}-${(seq += 1)}`;

function callHook(script, ev, { cwd } = {}) {
  // 注意：本文件的调用有两种风格 —— 有的把项目根放在 options.cwd，有的放在 ev.cwd。
  // 日志根必须跟着**事件里的项目根**走（hook 也是按 ev.cwd 判定的），所以两者都要看。
  const cwdAbs = cwd || ev?.cwd || ROOT;
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(ev),
    encoding: "utf8",
    cwd: cwdAbs,
    // ★ 第 2 段：日志根 = 该沙箱专属（见文件头说明），避免用例之间互相读到对方的日志
    env: { ...process.env, HARNESS_LOG_ROOT: logRootFor(cwdAbs) },
  });
  const out = (r.stdout || "").trim();
  let json = null;
  try {
    json = JSON.parse(out);
  } catch {
    /* 非 JSON 输出交给断言判 */
  }
  return { raw: r.stdout || "", stderr: r.stderr || "", status: r.status, json };
}

// ───────────────────────────────────────────── 沙箱

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "harness-b3-"));
/** 沙箱专用日志根（工作区根 日志\ 的替身） */
const TEST_LOG_ROOT = path.join(SANDBOX, "日志");
/** 每个沙箱一个日志根：用例之间互不串味（否则 readLog 会读到上一个用例的落盘文件） */
const logRootFor = (root) => path.join(TEST_LOG_ROOT, path.basename(String(root || "root")) || "root");
function sandbox(name) {
  const d = path.join(SANDBOX, name);
  fs.mkdirSync(path.join(d, ".claude", "state"), { recursive: true });
  // 第 2 段：项目内**不再有** .harness\logs\（日志写在 TEST_LOG_ROOT 下）；.harness\ 本身保留
  fs.mkdirSync(path.join(d, ".harness"), { recursive: true });
  // 沙箱里也放一份真实的 hook 副本。
  // 生产里项目根的 .claude/hooks 就是这么来的（第 5 批 scaffold-ext 负责铺），
  // 所以这样测出来的行为才和真实会话一致 —— 尤其 G10 的包装命令要能找到 log-summary.mjs。
  fs.cpSync(path.join(ROOT, ".claude", "hooks"), path.join(d, ".claude", "hooks"), { recursive: true });
  return d;
}
/** 伪造一份 statusline 写出来的水位文件 */
function writeCtx(root, usedPct, ageMs = 0) {
  fs.writeFileSync(
    path.join(root, ".claude", "state", "ctx.json"),
    JSON.stringify(
      { usedPct, remainPct: 100 - usedPct, windowSize: 102400, model: "test-model", ts: Date.now() - ageMs },
      null,
      2,
    ),
  );
}
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const reasonOf = (r) => r.json?.reason ?? "";
/** 读该沙箱日志中心 02-命令\ 里落盘的原始输出（第 2 段：不在项目里了） */
const readLog = (root) => {
  const dir = path.join(logRootFor(root || ROOT), "02-命令");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".log"));
  } catch {
    return null;
  }
  files.sort();
  return files.length ? fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8") : null;
};

console.log(`沙箱：${SANDBOX}\n项目根：${ROOT}`);
console.log("═".repeat(64));

// ══════════════════════════════════════════════════════════════
section("验收 1+2 · shape-output：★失败项必须保留（不能只留末尾）+ 完整日志落盘");

// ── 1a. 单元层：直接测 policy.shapeOutput() 的「保留失败项」逻辑。
//    这一段是本批「截断不能只保留末尾」这条硬要求的**真正落点**，且不依赖 Claude Code 版本。
{
  // Windows 上动态 import 必须给 file:// URL，直接给盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const { shapeOutput, LIMITS } = await import(
    pathToFileURL(path.join(ROOT, ".claude/hooks/lib/policy.mjs")).href
  );
  const lines = [];
  for (let i = 1; i <= 4000; i++) {
    if (i === 1200) lines.push("FAIL src/middle.spec.ts > 中间这条失败必须被保留");
    else if (i === 3990) lines.push("Error: 靠近末尾的失败");
    else lines.push(`✔ 通过用例 #${i} —— ${"填充".repeat(12)}`);
  }
  const big = lines.join("\n");
  check("测试素材 > 8KB", Buffer.byteLength(big, "utf8") > LIMITS.outputShapeBytes, `${Buffer.byteLength(big, "utf8")} 字节`);

  const shaped = shapeOutput(big);
  check("shapeOutput 对大输出返回了整形结果", !!shaped);
  check("★ 中间那条失败被保留（不是只留末尾）", shaped.summary.includes("中间这条失败必须被保留"));
  check("末尾那条失败也在", shaped.summary.includes("靠近末尾的失败"));
  check("末尾 40 行也在", shaped.summary.includes("通过用例 #4000"));
  check("报告了原始总行数", shaped.summary.includes("原始 4000 行"));
  check("失败项被单独成段并置顶", shaped.summary.indexOf("失败项") < shaped.summary.indexOf("末尾"));
  check("整形后确实变短", shaped.summary.length < big.length, `${big.length} → ${shaped.summary.length}`);
  check("小输出不整形（返回 null）", shapeOutput("hello\nworld") === null);
}

// ── 1b. 集成层：真 hook 进程 —— 完整日志必须落盘
{
  const sb = sandbox("shape");
  const lines = [];
  for (let i = 1; i <= 4000; i++) {
    if (i === 1200) lines.push("FAIL src/middle.spec.ts > 中间这条失败必须被保留");
    else lines.push(`✔ 通过用例 #${i} —— ${"填充".repeat(12)}`);
  }
  const big = lines.join("\n");

  const r = callHook(SHAPE, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    session_id: newSid("shape"),
    cwd: sb,
    tool_input: { command: "npx vitest run" },
    tool_response: { stdout: big, stderr: "", exit_code: 0 },
  });

  const log = readLog(sb);
  check("★ 完整日志已落盘", !!log);
  check("落盘的是完整原文（4000 行一行不少）", !!log && log.split("\n").length === 4000, log ? `${log.split("\n").length} 行` : "无");
  check("落盘的原文里中间那条失败也在", !!log && log.includes("中间这条失败必须被保留"));

  const ctx = ctxOf(r);
  check("hookEventName 写对（少了就静默失效）", r.json?.hookSpecificOutput?.hookEventName === "PostToolUse", JSON.stringify(r.json?.hookSpecificOutput?.hookEventName));
  check("提示里给了**日志中心**的落盘路径（第 2 段：日志在项目外）", /02-命令[\\/][^\\/]*\.log/.test(ctx), ctx.slice(0, 160));
  check("提示里带上了字节数与退出码", /字节/.test(ctx) && /退出码/.test(ctx));
  check(
    "★ 提示保持极简（不重复摘要正文，避免给已经超长的输出再加码）",
    ctx.length < 400,
    `${ctx.length} 字符`,
  );
  check("提示没有把原始输出再抄一遍", !ctx.includes("通过用例 #2000"));
}

// ── 1c. ★ PostToolUseFailure 路径（本批实测：非零退出只走这个事件，且没有 tool_response）
{
  const sb = sandbox("shape-fail");
  const big = Array.from({ length: 2000 }, (_, i) => `✔ 通过用例 #${i + 1} —— ${"填充".repeat(8)}`).join("\n");
  const errText = `Exit code 1\n${big}`;

  const r = callHook(SHAPE, {
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    session_id: newSid("shapefail"),
    cwd: sb,
    tool_input: { command: "node fake-big-log.mjs" },
    error: errText,
    is_interrupt: false,
  });

  const log = readLog(sb);
  check("★ 失败路径也落盘了完整日志", !!log && log.split("\n").length === 2000, log ? `${log.split("\n").length} 行` : "无");
  check("★ 落盘内容剥掉了 `Exit code N` 前缀（只留输出本体）", !!log && !log.startsWith("Exit code"));
  check("hookEventName 回的是 PostToolUseFailure（写错就静默失效）", r.json?.hookSpecificOutput?.hookEventName === "PostToolUseFailure", JSON.stringify(r.json?.hookSpecificOutput?.hookEventName));
  check("提示里给了日志路径（日志中心 02-命令）", /02-命令[\\/][^\\/]*\.log/.test(ctxOf(r)));
  check("提示里带上了退出码 1", /退出码 1/.test(ctxOf(r)));
}

{
  const sb = sandbox("shape-small");
  const r = callHook(SHAPE, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    session_id: newSid("small"),
    cwd: sb,
    tool_input: { command: "echo hi" },
    tool_response: { stdout: "ok\n".repeat(50), exit_code: 0 },
  });
  check("不超阈值 → 完全不干预（无任何输出、不落盘）", r.raw.trim() === "" && readLog(sb) === null);
}

// ══════════════════════════════════════════════════════════════
section("验收 3 · compact-instructions：禁止用 exit 2；注入「必须保留」清单");

{
  const sb = sandbox("compact");
  fs.writeFileSync(path.join(sb, ".harness", "HANDOFF.md"), "# 交接\n## 当前任务\n把第 3 批做完\n");
  writeCtx(sb, 42);

  const r = callHook(COMPACT, {
    hook_event_name: "PreCompact",
    session_id: newSid("compact"),
    cwd: sb,
    trigger: "auto",
    custom_instructions: null,
  });

  check("★ 退出码 0（铁律 8：exit 2 会报 Conversation too long 并中断）", r.status === 0, `status=${r.status}`);
  check("没有输出 JSON（走的是 stdout 追加指令这条路）", r.json === null);
  check("要求保留 HANDOFF 全文", /HANDOFF\.md/.test(r.raw));
  check("★ 三条禁止事项在指令里", /不得用 sed -i/.test(r.raw) && /playwright/.test(r.raw) && /Safety Kernel/.test(r.raw));
  check("带上当前模型与压缩上限", /test-model/.test(r.raw) && /102400/.test(r.raw));
  check("HANDOFF 正文被内联进去了", r.raw.includes("把第 3 批做完"));
  check("说明了可丢弃什么", /可以丢弃/.test(r.raw));
}

// ══════════════════════════════════════════════════════════════
section("验收 4 · on-stop：生成 HANDOFF.md（结构完整）");

{
  const sb = sandbox("stop-handoff");
  fs.writeFileSync(
    path.join(sb, ".harness", "HANDOFF.md"),
    "# 旧交接\n<!-- harness:manual -->\n这是我自己手写的内容，脚本不许覆盖。\n",
  );
  writeCtx(sb, 30);

  const r = callHook(STOP, {
    hook_event_name: "Stop",
    session_id: newSid("handoff"),
    cwd: sb,
    stop_hook_active: false,
    last_assistant_message: "现在正在做第 3 批的 on-stop.mjs。\n下一步要跑验收。",
  });

  const h = fs.readFileSync(path.join(sb, ".harness", "HANDOFF.md"), "utf8");
  check("退出码 0", r.status === 0, `status=${r.status}`);
  check("水位 30% < 70% → 不拦（无输出）", r.raw.trim() === "");
  for (const sec of ["## 当前任务", "## 已完成（本轮）", "## 下一步", "## 关键决策 / 坑", "## 环境"]) {
    check(`HANDOFF 含「${sec}」`, h.includes(sec));
  }
  check("★ 从 last_assistant_message 提炼了当前任务", h.includes("现在正在做第 3 批的 on-stop.mjs"));
  check("写进了模型与压缩上限", h.includes("test-model") && h.includes("102400"));
  check("★ 手写内容被原样保留", h.includes("这是我自己手写的内容，脚本不许覆盖。"));
  check("JOURNAL.md 追加了一行", fs.readFileSync(path.join(sb, ".harness", "JOURNAL.md"), "utf8").includes("结束"));
  // 第 2 段：Stop 事件原始载荷写在**日志中心** 01-会话\stop-stdin-<日期>.jsonl（不在项目里）
  const stopDump = (() => {
    try {
      const dir = path.join(logRootFor(sb), "01-会话");
      const f = fs.readdirSync(dir).filter((n) => n.startsWith("stop-stdin-"));
      return f.length ? fs.readFileSync(path.join(dir, f[f.length - 1]), "utf8") : "";
    } catch {
      return "";
    }
  })();
  check("★ stdin 原始 JSON 已落盘到日志中心（待实测项 #2 的取证点）", stopDump.length > 0);
  const dumped = stopDump;
  check("落盘的 JSON 里含 stop_hook_active 字段", dumped.includes("stop_hook_active"));
}

// ── 回归：连续多轮结束后 HANDOFF 不许越滚越大
//    初版用 indexOf 找标记，而文件头的说明行里也写了这个标记 → 每轮把整份内容当"人工区"抄回去，
//    实测 397 行里有 394 行是这么涨出来的（真会话里被模型当场发现）。
{
  const sb = sandbox("handoff-growth");
  fs.writeFileSync(path.join(sb, ".harness", "HANDOFF.md"), "# 旧\n<!-- harness:manual -->\n用户手写的一行\n");
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    callHook(STOP, {
      hook_event_name: "Stop",
      session_id: newSid(`growth${i}`),
      cwd: sb,
      stop_hook_active: false,
      last_assistant_message: `第 ${i} 轮。`,
    });
    sizes.push(fs.statSync(path.join(sb, ".harness", "HANDOFF.md")).size);
  }
  const h = fs.readFileSync(path.join(sb, ".harness", "HANDOFF.md"), "utf8");
  check("★ 回归：连续 6 轮结束后 HANDOFF 不膨胀", sizes[5] <= sizes[0], sizes.join(" → "));
  check("★ 用户手写内容仍然保留", h.includes("用户手写的一行"));
  const marks = (h.match(/^<!-- harness:manual -->[ \t]*$/gm) || []).length;
  check("★ 整份文件里有且只有一行标记", marks === 1, `找到 ${marks} 行`);
}

// ══════════════════════════════════════════════════════════════
section("验收 5 · on-stop：水位超 70% 拒绝结束 ★★ 且绝不死循环");

{
  const sb = sandbox("stop-loop");
  writeCtx(sb, 85);
  const sid = newSid("loop");
  const stopEv = (extra = {}) => ({
    hook_event_name: "Stop",
    session_id: sid,
    cwd: sb,
    stop_hook_active: false,
    last_assistant_message: "干到一半。",
    ...extra,
  });
  const blocked = (r) => r.json?.decision === "block";
  const guardFile = path.join(sb, ".claude", "state", "stop-guard.json");
  const rewind = () => {
    const g = JSON.parse(fs.readFileSync(guardFile, "utf8"));
    for (const k of Object.keys(g)) g[k].lastAt = Date.now() - 10 * 60 * 1000;
    fs.writeFileSync(guardFile, JSON.stringify(g));
  };

  const r1 = callHook(STOP, stopEv());
  check("第 1 次：拒绝结束会话", blocked(r1));
  check("拒绝原因里说了水位", /85%/.test(r1.json?.reason ?? ""));
  check("拒绝原因里给了三步做法", /HANDOFF/.test(r1.json?.reason ?? "") && /新会话|开一个新会话/.test(r1.json?.reason ?? ""));
  check("原因长度未超 2000 字符上限", (r1.json?.reason ?? "").length <= 2000, `${(r1.json?.reason ?? "").length} 字符`);

  const r2 = callHook(STOP, stopEv());
  check("★ 第 1 层防抖：冷却期内不再拦（不会紧凑循环）", !blocked(r2));

  rewind();
  const r3 = callHook(STOP, stopEv());
  check("冷却过后再试一次：仍会拦（第 2 次也是最后一次）", blocked(r3));

  rewind();
  const r4 = callHook(STOP, stopEv());
  check("★ 第 2 层硬上限：本会话已拦 2 次 → 无条件放行", !blocked(r4));

  // 换一个全新会话，验证「stop_hook_active 为真就放行」这条主防线
  const sb2 = sandbox("stop-active");
  writeCtx(sb2, 95);
  const r5 = callHook(STOP, {
    hook_event_name: "Stop",
    session_id: newSid("active"),
    cwd: sb2,
    stop_hook_active: true,
    last_assistant_message: "结束吧。",
  });
  check("★ 第 1 层主防线：stop_hook_active=true → 直接放行", !blocked(r5) && r5.raw.trim() === "");

  // 水位数据太旧 → 不足以支撑「拒绝结束」这种重决定
  const sb3 = sandbox("stop-stale");
  writeCtx(sb3, 95, 3 * 60 * 60 * 1000);
  const r6 = callHook(STOP, {
    hook_event_name: "Stop",
    session_id: newSid("stale"),
    cwd: sb3,
    stop_hook_active: false,
    last_assistant_message: "结束吧。",
  });
  check("水位数据过期（3 小时前）→ 不拦", !blocked(r6));

  // 水位低 → 不拦
  const sb4 = sandbox("stop-low");
  writeCtx(sb4, 40);
  const r7 = callHook(STOP, {
    hook_event_name: "Stop",
    session_id: newSid("low"),
    cwd: sb4,
    stop_hook_active: false,
    last_assistant_message: "结束吧。",
  });
  check("水位 40% → 不拦", !blocked(r7));

  // 逃生阀
  const sb5 = sandbox("stop-bypass");
  writeCtx(sb5, 95);
  fs.writeFileSync(path.join(sb5, ".harness", "bypass"), "");
  const r8 = callHook(STOP, {
    hook_event_name: "Stop",
    session_id: newSid("bypass"),
    cwd: sb5,
    stop_hook_active: false,
    last_assistant_message: "结束吧。",
  });
  check("逃生阀存在 → 不拦", !blocked(r8));
}

// ══════════════════════════════════════════════════════════════
section("验收 6 · inject-rules：SessionStart 注入硬规则 + HANDOFF 摘要");

{
  const sb = sandbox("inject");
  fs.writeFileSync(
    path.join(sb, ".harness", "HANDOFF.md"),
    Array.from({ length: 60 }, (_, i) => `HANDOFF 第 ${i + 1} 行`).join("\n"),
  );
  fs.writeFileSync(path.join(sb, ".harness", "JOURNAL.md"), "一笔\n二笔\n三笔\n");
  writeCtx(sb, 20);

  const r = callHook(INJECT, {
    hook_event_name: "SessionStart",
    session_id: newSid("inject"),
    cwd: sb,
    source: "startup",
  });

  check("退出码 0", r.status === 0, `status=${r.status}`);
  check("注入的是纯文本（不是 JSON）", r.json === null && r.raw.length > 200);
  check("含硬规则第 1 条（改码只用 Edit / Write）", /改代码只用 Edit \/ Write/.test(r.raw));
  check("含 8 条编号规则", /^8\./m.test(r.raw), "没找到第 8 条");
  check("含测试分层", /测试分层/.test(r.raw));
  check("含 70% 水位纪律", /70%/.test(r.raw));
  check("含 verify-gate 的用法", /verify-gate\.mjs/.test(r.raw));
  check("★ 注入的是 HANDOFF 前 20 行（不是全部）", r.raw.includes("HANDOFF 第 20 行") && !r.raw.includes("HANDOFF 第 21 行"));
  check("注入了 JOURNAL 末尾", r.raw.includes("三笔"));
  check("注入体量克制（< 8000 字符）", r.raw.length < 8000, `${r.raw.length} 字符`);

  const r2 = callHook(INJECT, {
    hook_event_name: "SessionStart",
    session_id: newSid("inject-compact"),
    cwd: sb,
    source: "compact",
  });
  check(
    "source=compact 时精简（不重复灌 HANDOFF）",
    r2.raw.length < r.raw.length && !r2.raw.includes("HANDOFF 第 20 行"),
    `${r.raw.length} → ${r2.raw.length}`,
  );

  const sbEmpty = sandbox("inject-empty");
  const r3 = callHook(INJECT, {
    hook_event_name: "SessionStart",
    session_id: newSid("inject-empty"),
    cwd: sbEmpty,
    source: "startup",
  });
  check("没有 HANDOFF 时仍注入规则，并提示先跑 env-doctor", /env-doctor/.test(r3.raw));
}

// ══════════════════════════════════════════════════════════════
section("验收 7 · statusline：显示水位，并写出 ctx.json（其它 hook 的唯一数据源）");

{
  const sb = sandbox("status");
  const r = callHook(STATUSLINE, {
    hook_event_name: "Status",
    session_id: "status-test",
    cwd: sb,
    workspace: { current_dir: sb, project_dir: sb },
    model: { id: "deepseek-v4-flash", display_name: "deepseek-v4-flash" },
    context_window: {
      total_input_tokens: 45000,
      total_output_tokens: 3000,
      context_window_size: 102400,
      used_percentage: 42.4,
      remaining_percentage: 57.6,
    },
    rate_limits: { five_hour: { used_percentage: 18.2 }, seven_day: { used_percentage: 7 } },
    prompt_cache: { hit_ratio: 0.91 },
  });

  check("退出码 0", r.status === 0, `status=${r.status}`);
  check("★ 输出含「上下文 X%」", /上下文 42%/.test(r.raw), JSON.stringify(r.raw));
  check("输出含 5h 用量", /5h 18%/.test(r.raw));
  check("输出含缓存命中", /缓存 91%/.test(r.raw));
  check("输出含模型名与窗口", /deepseek-v4-flash/.test(r.raw) && /win 102K/.test(r.raw));
  check("输出含进度条", /[█▓#]/.test(r.raw));
  check("输出只有一行", r.raw.trimEnd().split("\n").length === 1);

  const ctxFile = path.join(sb, ".claude", "state", "ctx.json");
  check("★ 写出了 ctx.json", fs.existsSync(ctxFile));
  const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf8"));
  check("ctx.json 里的 usedPct 正确", ctx.usedPct === 42.4, String(ctx.usedPct));
  check("ctx.json 记下了压缩阈值（窗口 − 33000）", ctx.compactThreshold === 102400 - 33000, String(ctx.compactThreshold));
  check("ctx.json 有 ts（on-stop 靠它判新鲜度）", typeof ctx.ts === "number");
  check("ctx.json 记下了模型名", ctx.model === "deepseek-v4-flash");

  // 坏输入绝不能让状态栏变空白
  const r2 = callHook(STATUSLINE, {}, { cwd: sb });
  check("空对象输入：仍输出内容且 exit 0", r2.status === 0 && r2.raw.trim().length > 0, JSON.stringify(r2.raw));
  const bad = spawnSync(process.execPath, [STATUSLINE], { input: "{不是 JSON", encoding: "utf8", cwd: sb });
  check("坏 JSON 输入：仍输出内容且 exit 0", bad.status === 0 && (bad.stdout || "").trim().length > 0);
}

// ══════════════════════════════════════════════════════════════
section("验收 8 · verify-gate：原始输出落盘，摘要里有脚本给出的退出码");

{
  const sb = sandbox("verify");
  const okRun = spawnSync(
    process.execPath,
    [VERIFY, "--cmd", "node --version", "--root", sb],
    { encoding: "utf8", cwd: sb, env: { ...process.env, HARNESS_LOG_ROOT: logRootFor(sb) } },
  );
  check("全通过 → 进程退出码 0", okRun.status === 0, `status=${okRun.status}`);
  check("摘要里带「独立验收」标识", /独立验收/.test(okRun.stdout));
  check("摘要里有 PASS 标记", /\[PASS\]/.test(okRun.stdout));
  check("摘要里给出退出码 0", /退出码 0/.test(okRun.stdout));

  // 第 2 段：独立验收的原始输出落在日志中心 03-验证\（只追加、每次运行一个新文件）
  const logsDir = path.join(logRootFor(sb), "03-验证");
  const vlogs = fs.readdirSync(logsDir).filter((f) => f.startsWith("verify-"));
  check("★ 原始输出落盘为 verify-*.log", vlogs.length > 0, vlogs.join(","));
  const raw = vlogs.length ? fs.readFileSync(path.join(logsDir, vlogs[0]), "utf8") : "";
  check("★ 落盘的是原始 stdout（内容真在）", /^v\d+\.\d+\.\d+/m.test(raw), raw.slice(0, 80));

  const badRun = spawnSync(
    process.execPath,
    [VERIFY, "--cmd", "node --definitely-not-a-real-flag-xyz", "--root", sb],
    { encoding: "utf8", cwd: sb, env: { ...process.env, HARNESS_LOG_ROOT: logRootFor(sb) } },
  );
  check("有失败 → 进程退出码 1（不撒谎）", badRun.status === 1, `status=${badRun.status}`);
  check("摘要里标 FAIL", /\[FAIL\]/.test(badRun.stdout));
  check("摘要里有「不许改写成已全部通过」的约束", /不要改写成/.test(badRun.stdout));
  check("非零退出码被如实写进摘要", /退出码 [1-9]/.test(badRun.stdout), badRun.stdout.slice(0, 200));

  // 清单文件
  fs.writeFileSync(
    path.join(sb, ".harness", "verify.json"),
    JSON.stringify({ commands: [{ name: "冒烟", cmd: "node --version" }] }),
  );
  const listRun = spawnSync(process.execPath, [VERIFY, "--list", "--root", sb], {
    encoding: "utf8",
    cwd: sb,
    env: { ...process.env, HARNESS_LOG_ROOT: logRootFor(sb) },
  });
  check("--list 能读出清单", /node --version/.test(listRun.stdout) && /冒烟/.test(listRun.stdout));

  const noCfg = sandbox("verify-nocfg");
  const missRun = spawnSync(process.execPath, [VERIFY], { encoding: "utf8", cwd: noCfg });
  check("没有命令也没有清单 → 退出码 2 且给出用法", missRun.status === 2 && /verify\.json/.test(missRun.stderr));
}

// ══════════════════════════════════════════════════════════════
section("★ G10 · 命令包装改写（本批新增：方案原定的 updatedToolOutput 在本版本不存在）");

const preBash = (cmd, cwd, extra = {}) =>
  callHook(GUARD, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    session_id: `b3-rewrite-${++seq}`,
    cwd,
    tool_input: { command: cmd, ...extra },
  });
const rewritten = (r) => r.json?.hookSpecificOutput?.updatedInput?.command ?? null;

{
  const sb = sandbox("rewrite");

  // ── 该被包装的
  for (const cmd of [
    "npx vitest run",
    "npm test",
    "npm run build",
    "npx playwright test",
    "tsc --noEmit",
  ]) {
    const r = preBash(cmd, sb);
    const w = rewritten(r);
    check(`被包装：${cmd}`, !!w, JSON.stringify(r.json?.hookSpecificOutput ?? null).slice(0, 140));
    if (w) {
      check(`  └ 原命令原样嵌进 { … ; }`, w.includes(`{ ${cmd} ; }`));
      check(`  └ 全量输出重定向到 日志中心 02-命令（项目外）`, /02-命令[\\/].*\.log/.test(w));
      check(`  └ 调 log-summary.mjs 回显摘要`, w.includes("log-summary.mjs"));
      check(`  └ ★ 退出码原样透传（exit $__h_rc）`, /__h_rc=\$\?/.test(w) && /exit \$__h_rc/.test(w));
    }
    check(`  └ 不设 permissionDecision（不替用户自动放行）`, r.json?.hookSpecificOutput?.permissionDecision === undefined);
    check(`  └ 用 additionalContext 告知模型命令被包装过`, /包装/.test(ctxOf(r)), ctxOf(r).slice(0, 100));
  }

  // ── 绝不该被包装的（防误伤）
  const notRewritten = [
    ["ls -la", "普通命令"],
    ["sed -n '1,5p' README.md", "分段读（不是就地改）"],
    ["npm run build > 日志/02-命令/build.log 2>&1", "模型已自己重定向到文件"],
    ["cat > src/a.ts <<EOF", "heredoc 写文件"],
    ["grep -rn 'test' src/", "普通搜索"],
    ["echo 'npm test 会跑很久'", "只是提到，不是真的跑"],
  ];
  for (const [cmd, why] of notRewritten) {
    const r = preBash(cmd, sb);
    check(`不包装：${why}`, rewritten(r) === null, `实际=${String(rewritten(r)).slice(0, 90)}`);
  }

  check("不包装：run_in_background 的后台任务", rewritten(preBash("npm test", sb, { run_in_background: true })) === null);

  // 逃生阀
  const bypassSb = sandbox("rewrite-bypass");
  fs.writeFileSync(path.join(bypassSb, ".harness", "bypass"), "");
  check("不包装：逃生阀 .harness/bypass 存在", rewritten(preBash("npm test", bypassSb)) === null);

  // 拦截优先于改写
  const denySb = sandbox("rewrite-deny");
  check(
    "被拦的命令不做包装（拦截优先）",
    preBash("npx playwright test && sed -i 's/a/b/' x.ts", denySb).json?.hookSpecificOutput?.permissionDecision === "deny",
  );
}

// ── ★ 真跑一遍：把改写出来的命令交给 bash 实际执行，验证机制真的成立
{
  const sb = sandbox("rewrite-e2e");
  // 造一个"测试脚本"：2000 行输出，失败埋在第 900 行（远不在末尾），退出码 3
  fs.writeFileSync(
    path.join(sb, "gen.mjs"),
    [
      "const L=[];",
      "for(let i=1;i<=2000;i++){",
      "  if(i===900) L.push('FAIL 中间失败标记串 ENDTOEND-5150');",
      "  else L.push('ok 用例 #'+i+' —— '+'填充'.repeat(8));",
      "}",
      "console.log(L.join('\\n'));",
      "process.exit(3);",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(sb, "package.json"), JSON.stringify({ name: "t", scripts: { test: "node gen.mjs" } }));

  const w = rewritten(preBash("npm run test", sb));
  check("拿到改写后的命令", !!w);

  if (w) {
    // 用统一解析器找到的**真 bash**（跳过 WSL 垫片）；找不到就明确跳过，不再假红
    const run = REAL_BASH
      ? spawnSync(REAL_BASH, ["-c", w], { cwd: sb, encoding: "utf8", timeout: 60000 })
      : null;
    if (!run) {
      skip("★ 端到端：G10 改写命令真跑一遍（退出码/回显/落盘）", "本机没有可用的 bash（只有 WSL 垫片也算没有）");
    } else {
    check("★ 端到端：退出码 3 被原样透传（模型的错误处理不受影响）", run.status === 3, `status=${run.status} stderr=${(run.stderr || "").slice(0, 200)}`);
    const out = run.stdout || "";
    check("★ 端到端：回显很短（不是 2000 行）", out.length < 8000, `${out.length} 字符 / 原始约 2000 行`);
    const dbg = `stdout=${JSON.stringify(out.slice(0, 300))} stderr=${JSON.stringify((run.stderr || "").slice(0, 300))}`;
    check("★ 端到端：中间那条失败被保留（不是只留末尾）", out.includes("ENDTOEND-5150"), dbg);
    check("端到端：给了完整日志路径（日志中心）", /02-命令[\\/].*\.log/.test(out), dbg);
    // 注意：npm 自己会往输出里加 4–5 行头（> t@ test / > node gen.mjs），所以行数是 2000 多而不是恰好 2000
    check("端到端：报告了原始行数与退出码", /20\d\d 行/.test(out) && /退出码 3/.test(out), dbg);
    check("端到端：没有把 2000 行原样吐回来", !out.includes("用例 #1000"), dbg);
    // 目录可能不存在（本机 bash 起不来时这条命令根本没跑，自然也没有日志）—— 别让自检台自己崩
    const e2eLogDir = path.join(logRootFor(sb), "02-命令");
    const logs = fs.existsSync(e2eLogDir) ? fs.readdirSync(e2eLogDir).filter((f) => f.endsWith(".log")) : [];
    check("★ 端到端：完整日志落盘", logs.length === 1, logs.join(","));
    if (logs.length) {
      const full = fs.readFileSync(path.join(logRootFor(sb), "02-命令", logs[0]), "utf8");
      // 比 2000 略多：npm 会往 stderr 打 4–5 行头，那些也一起收进日志（这是对的，不该丢）
      const n = full.split("\n").length;
      check("★ 端到端：落盘的是完整输出（含 npm 头部，一行不少）", n >= 2000 && n <= 2010, `${n} 行`);
      check("★ 端到端：落盘的日志里那条中间失败也在", full.includes("ENDTOEND-5150"));
    }
    }
  }
}

{
  const sb = sandbox("summary-unit");
  const { logSummaryRun } = {};
  // 小日志：包装对它必须透明（原样回显）
  const smallLog = path.join(sb, "small.log");
  fs.writeFileSync(smallLog, "hello\nworld\n");
  const r1 = spawnSync(process.execPath, [H("log-summary.mjs"), smallLog, "0"], { encoding: "utf8", cwd: sb });
  check("log-summary：小日志原样回显（包装对普通命令透明）", r1.stdout === "hello\nworld\n", JSON.stringify(r1.stdout));

  // 日志不存在也不能吞掉结果
  const r2 = spawnSync(process.execPath, [H("log-summary.mjs"), path.join(sb, "nope.log"), "1"], { encoding: "utf8", cwd: sb });
  check("log-summary：日志读不到时如实说明且不崩", r2.status === 0 && /无法读取/.test(r2.stdout));

  // ★ 大日志 + cwd 在子目录（真实形态：`cd 子目录 && npm test`）→ 路径仍须是**相对日志根**的写法，且必须保留失败项
  const bigLog = path.join(logRootFor(sb), "02-命令", "big.log");
  fs.mkdirSync(path.dirname(bigLog), { recursive: true });
  fs.writeFileSync(
    bigLog,
    Array.from({ length: 3000 }, (_, i) => (i === 800 ? "FAIL 中间失败标记串 CWD-4242" : `✔ 用例 #${i + 1} ${"填".repeat(20)}`)).join("\n"),
  );
  const sub = path.join(sb, "sub", "dir");
  fs.mkdirSync(sub, { recursive: true });
  const r3 = spawnSync(process.execPath, [H("log-summary.mjs"), bigLog, "1"], { encoding: "utf8", cwd: sub });
  check(
    "log-summary：★ 路径写成相对日志根的 日志/(…/)02-命令/…（不泄露本机绝对路径）",
    /日志\/[^\n]*02-命令\/big\.log/.test(r3.stdout) && !/[A-Za-z]:[\\/]/.test(r3.stdout.split("\n")[1] ?? ""),
    JSON.stringify(r3.stdout.slice(0, 200)),
  );
  check("log-summary：★ 中间那条失败被保留（不是只留末尾）", r3.stdout.includes("CWD-4242"));
  check("log-summary：报告原始行数与退出码", /300[0-9] 行/.test(r3.stdout) && /退出码 1/.test(r3.stdout));
}

// ══════════════════════════════════════════════════════════════
section("附加 · 全部 hook 的 fail-open 与静默失效防护");

{
  const sb = sandbox("robust");
  // shape-output / on-stop 是「有决定才说话」：坏输入必须完全安静。
  for (const [name, script] of [["shape-output", SHAPE], ["on-stop", STOP]]) {
    const empty = spawnSync(process.execPath, [script], { input: "", encoding: "utf8", cwd: sb });
    check(`${name}：空 stdin → exit 0 且不输出`, empty.status === 0 && (empty.stdout || "").trim() === "", `status=${empty.status}`);
    const bad = spawnSync(process.execPath, [script], { input: "{坏", encoding: "utf8", cwd: sb });
    check(`${name}：坏 JSON → exit 0 且不输出`, bad.status === 0 && (bad.stdout || "").trim() === "");
  }
  // compact / inject 是「注入了才有意义」：坏输入也必须 exit 0，但**仍要输出要注入的文本**
  // ——压缩/新会话时就该保守地把规则和保留清单塞进去，读不到事件不是放弃注入的理由。
  for (const [name, script] of [["compact", COMPACT], ["inject", INJECT]]) {
    const empty = spawnSync(process.execPath, [script], { input: "", encoding: "utf8", cwd: sb });
    check(`${name}：空 stdin → exit 0 且仍输出注入文本`, empty.status === 0 && (empty.stdout || "").trim().length > 100, `status=${empty.status}`);
    const bad = spawnSync(process.execPath, [script], { input: "{坏", encoding: "utf8", cwd: sb });
    check(`${name}：坏 JSON → exit 0 且仍输出注入文本`, bad.status === 0 && (bad.stdout || "").trim().length > 100);
  }

  const r = callHook(SHAPE, {
    hook_event_name: "PostToolUse",
    tool_name: "Read", // 不是 Bash → 不该管
    session_id: newSid("wrongtool"),
    cwd: sb,
    tool_response: { content: "x".repeat(20000) },
  });
  check("shape-output：非 Bash 工具不干预", r.raw.trim() === "");

  // 事件名对不上时必须自己退出（避免被误注册到别的 matcher 上乱动）
  const w = callHook(STOP, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: sb, session_id: "x" });
  check("on-stop：事件名不是 Stop → 不干预", w.raw.trim() === "");
}

// ══════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项${skipCount ? `，跳过 ${skipCount} 项` : ""}`);
if (failures.length) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
