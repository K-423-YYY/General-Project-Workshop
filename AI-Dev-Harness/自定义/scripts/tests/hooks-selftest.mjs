/**
 * hooks-selftest.mjs —— 第 2 批（机制层）的零成本自检台
 *
 * 做法：把构造好的 stdin JSON 直接喂给 hook 脚本，读它的 stdout 判定。
 * 不启动任何模型、不消耗任何额度 —— 与第 1 批的 probe-selftest.mjs 同一套路数。
 *
 * 覆盖：04-实施批次与验收.md 第 2 批的 9 项验收标准（能离线判定的部分）
 *   + G1–G8 的边界用例（防误伤）
 *
 * 跑法：node AI-Dev-Harness/自定义/scripts/tests/hooks-selftest.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../.."); // → General-Project-Workshop
const BASH_HOOK = path.join(ROOT, ".claude/hooks/guard-bash.mjs");
const TOOLS_HOOK = path.join(ROOT, ".claude/hooks/guard-tools.mjs");

/**
 * 第 2 段（日志中心）：hooks 现在会把 deny/warn 写进**工作区根** 日志\04-拦截\。
 * 自检台会故意触发几十次拦截 —— 这些是测试噪声，不该混进真日志中心，
 * 所以这里显式把 HARNESS_LOG_ROOT 指到临时目录（同时也顺带验证"位置可配"）。
 */
const TEST_LOG_ROOT = path.join(os.tmpdir(), `harness-hooks-selftest-日志-${process.pid}`);
const TEST_ENV = { ...process.env, HARNESS_LOG_ROOT: TEST_LOG_ROOT };

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

function section(title) {
  console.log(`\n${title}`);
}

let seq = 0;
const newSid = (tag) => `selftest-${tag}-${Date.now()}-${(seq += 1)}`;

function callHook(script, ev) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(ev),
    encoding: "utf8",
    cwd: ROOT,
    // 第 2 段：自检台也走日志中心，但指到**临时目录**，绝不污染真日志中心
    env: TEST_ENV,
  });
  let json = null;
  const out = (r.stdout || "").trim();
  if (out) {
    try {
      json = JSON.parse(out);
    } catch {
      /* 交给断言去判 */
    }
  }
  return { raw: r.stdout || "", stderr: r.stderr || "", status: r.status, json };
}

const bashEv = (cmd, sid, extra = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  session_id: sid,
  cwd: ROOT,
  tool_input: { command: cmd, ...extra },
});

const toolEv = (tool, input, sid) => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  session_id: sid,
  cwd: ROOT,
  tool_input: input,
});

const bashPost = (cmd, sid, ok = true) => ({
  hook_event_name: ok ? "PostToolUse" : "PostToolUseFailure",
  tool_name: "Bash",
  session_id: sid,
  cwd: ROOT,
  tool_input: { command: cmd },
  tool_response: ok ? { stdout: "ok", exit_code: 0 } : { is_error: true, exit_code: 1 },
});

const preBash = (cmd, sid, extra) => callHook(BASH_HOOK, bashEv(cmd, sid, extra));
const postBash = (cmd, sid, ok) => callHook(BASH_HOOK, bashPost(cmd, sid, ok));

/**
 * ★ 第 3 批起：guard-bash 会对「测试 / 构建 / 类型检查」类命令做 G10 包装改写
 *   （PreToolUse 的 updatedInput）。真实会话里 **PostToolUse 拿到的 tool_input.command
 *   是改写后的那一串**，所以模拟后置事件时也必须用它 —— 拿原命令当 key，配额记账会永远对不上账。
 *   preBash2 把「跑前置 hook」和「取出实际会执行的命令」合成一步，避免各处再写一遍。
 */
const eff = (r, cmd) => r.json?.hookSpecificOutput?.updatedInput?.command ?? cmd;
const preBash2 = (cmd, sid, extra) => {
  const r = preBash(cmd, sid, extra);
  return { r, cmd: eff(r, cmd) };
};

const denied = (r) =>
  r.json?.hookSpecificOutput?.permissionDecision === "deny" &&
  r.json.hookSpecificOutput.hookEventName === "PreToolUse";
const allowed = (r) => !r.json || r.json.hookSpecificOutput?.permissionDecision === undefined;
const reasonOf = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";

// ───────────────────────────────────────────── 开测

console.log("第 2 批 · 机制层 hooks 自检（零成本）");
console.log(`项目根：${ROOT}`);

// ══════════════════════════════ 0. 文件与语法
section("【0】交付物存在且语法正确");
for (const f of [
  ".claude/settings.json",
  ".claude/hooks/lib/policy.mjs",
  ".claude/hooks/guard-bash.mjs",
  ".claude/hooks/guard-tools.mjs",
]) {
  check(`${f} 存在`, fs.existsSync(path.join(ROOT, f)));
}
for (const f of [".claude/hooks/lib/policy.mjs", ".claude/hooks/guard-bash.mjs", ".claude/hooks/guard-tools.mjs"]) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, f)], { encoding: "utf8" });
  check(`${f} 语法通过`, r.status === 0, (r.stderr || "").trim().split("\n")[0]);
}

// ══════════════════════════════ settings.json 结构（10 条铁律逐条核）
section("【1】settings.json 结构核验（03 文档 10 条铁律）");
let settings = null;
try {
  settings = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude/settings.json"), "utf8"));
} catch (e) {
  check("settings.json 可解析", false, e.message);
}
if (settings) {
  check("hooks 键在 settings.json 顶层（铁律 10）", Object.prototype.hasOwnProperty.call(settings, "hooks"));
  check("autoCompactWindow 仍为 102400（merge 未覆盖第 1 批成果）", settings.autoCompactWindow === 102400);

  const allHooks = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const g of groups) {
      for (const h of g.hooks || []) allHooks.push({ event, matcher: g.matcher, ...h });
    }
  }
  check("每个 hook 都是 command 类型（铁律 9：不用 prompt/agent）", allHooks.every((h) => h.type === "command"));
  check(
    "每个 hook 都显式写了 timeout（铁律 6）",
    allHooks.every((h) => Number.isFinite(h.timeout) && h.timeout > 0),
    allHooks.filter((h) => !Number.isFinite(h.timeout)).map((h) => h.event).join(","),
  );
  check(
    "command 与 args 分开写，不是一根字符串（铁律 5）",
    allHooks.every((h) => h.command === "node" && Array.isArray(h.args) && h.args.length > 0),
  );
  check(
    "matcher 只写工具名，不含命令参数（铁律 4）",
    allHooks.every((h) => !h.matcher || /^[A-Za-z0-9_|]+$/.test(h.matcher)),
    allHooks.map((h) => h.matcher).filter(Boolean).join(" / "),
  );
  check(
    "hook 脚本路径存在（注册的都能跑起来）",
    allHooks.every((h) => fs.existsSync(path.join(ROOT, h.args[0]))),
    allHooks.map((h) => h.args[0]).join(", "),
  );
}

// ══════════════════════════════ 验收 2
section("【验收 2】sed -i 被 deny，且消息含替代方案与解除方法");
{
  const sid = newSid("sed");
  const r = preBash("sed -i 's/a/b/' src/foo.ts", sid);
  check("sed -i 被拦截", denied(r), `raw=${r.raw.slice(0, 200)}`);
  const msg = reasonOf(r);
  check("消息含 hookEventName（铁律 1）", r.json?.hookSpecificOutput?.hookEventName === "PreToolUse");
  check("消息说清「拦了什么」", msg.includes("已拦截") && /sed/.test(msg));
  check("消息说清「为什么」", msg.includes("为什么："));
  check("消息说清「怎么做」（指向 Edit 工具）", msg.includes("怎么做：") && /Edit/.test(msg));
  check("消息说清「怎么解除」（逃生阀）", msg.includes("怎么解除") && msg.includes(".harness/bypass"));
  check("reason 长度 ≤ 2000（二进制硬限制）", msg.length <= 2000, `实际 ${msg.length}`);
  // 反例：不带 -i 的 sed 必须放行
  check("反例：sed -n '1,5p' 放行（不误伤）", allowed(preBash("sed -n '1,5p' README.md", newSid("sedn"))));
}

// ══════════════════════════════ 验收 3
section("【验收 3】cat > file.ts <<EOF 被 deny");
{
  const r = preBash("cat > src/bar.ts <<EOF\nconsole.log(1)\nEOF", newSid("cat"));
  check("heredoc 写源码被拦截", denied(r));
  check(
    "反例：重定向到 .log 放行（第 2 段后日志在 工作区根\\日志\\02-命令\\）",
    allowed(preBash("npm run build > 日志/02-命令/build.log 2>&1", newSid("log"))),
  );
}

// ══════════════════════════════ 验收 4
section("【验收 4】python -c 内联改码被 deny（严格模式）");
{
  const r = preBash("python -c \"open('x.ts','w').write('a')\"", newSid("py"));
  check("python -c 写文件被拦截", denied(r));
  check("反例：python -c 只打印放行", allowed(preBash("python -c \"print(1)\"", newSid("pyprint"))));
}

// ══════════════════════════════ 验收 5
section("【验收 5】sleep 180 被 deny");
{
  check("sleep 180 被拦截", denied(preBash("sleep 180", newSid("sleep"))));
  check("反例：sleep 5 放行", allowed(preBash("sleep 5", newSid("sleep5"))));
  check(
    "反例：run_in_background 的 sleep 180 放行（正是我们要的做法）",
    allowed(preBash("sleep 180", newSid("sleepbg"), { run_in_background: true })),
  );
}

// ══════════════════════════════ 验收 6
section("【验收 6】连续 3 次 npx playwright test：前 2 次放行，第 3 次被拦");
{
  // 6a：全部成功 → 第 3 次拦
  const sid = newSid("e2e-ok");
  const cmd = "npx playwright test";
  const a1 = preBash2(cmd, sid);
  check("第 1 次放行", allowed(a1.r));
  postBash(a1.cmd, sid, true);
  const a2 = preBash2(cmd, sid);
  check("第 2 次放行（已成功 1 次，未超配额 2）", allowed(a2.r));
  postBash(a2.cmd, sid, true);
  const a3 = preBash2(cmd, sid);
  check("第 3 次被拦（已成功 2 次 = 配额）", denied(a3.r));
  check("拦截消息说明了配额与替代方案", /配额/.test(reasonOf(a3.r)) && /定向单测|vitest/.test(reasonOf(a3.r)));

  // 6b：失败不计数（决策 3 / 05-决策点 3）
  const sid2 = newSid("e2e-fail");
  for (let i = 1; i <= 4; i += 1) {
    const a = preBash2(cmd, sid2);
    check(`失败场景第 ${i} 次仍放行（失败不计数）`, allowed(a.r));
    postBash(a.cmd, sid2, false); // 失败 → 退款
  }
}

// ══════════════════════════════ 验收 7
section("【验收 7】.harness/bypass 逃生阀可用");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bypass-"));
  fs.mkdirSync(path.join(tmp, ".harness"), { recursive: true });
  const ev = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    session_id: newSid("bypass"),
    cwd: tmp,
    tool_input: { command: "sed -i 's/a/b/' src/foo.ts" },
  };
  const before = callHook(BASH_HOOK, ev);
  check("未建 bypass 时被拦", denied(before));
  fs.writeFileSync(path.join(tmp, ".harness", "bypass"), "");
  const after = callHook(BASH_HOOK, ev);
  check("建 .harness/bypass 后放行", allowed(after), `raw=${after.raw.slice(0, 200)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ══════════════════════════════ G4/G5 边界
section("【附加】G5 全量 CI 配额 & 定向单测不误伤");
{
  const sid = newSid("ci");
  check("定向单测 npx vitest run src/a.spec.ts 放行", allowed(preBash("npx vitest run src/a.spec.ts", sid)));
  const c = "npm test";
  for (let i = 1; i <= 3; i += 1) {
    const a = preBash2(c, sid);
    check(`npm test 第 ${i} 次放行（配额 3）`, allowed(a.r));
    postBash(a.cmd, sid, true);
  }
  check("npm test 第 4 次被拦", denied(preBash2(c, sid).r));
}

// ══════════════════════════════ G7 / G8
section("【附加】G7 大文件重复全读 / G8 同文件反复改（只警告不拦截）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tools-"));
  const big = path.join(tmp, "big.ts");
  fs.writeFileSync(big, Array.from({ length: 600 }, (_, i) => `// line ${i}`).join("\n"));

  const s7 = newSid("g7");
  const first = callHook(TOOLS_HOOK, toolEv("Read", { file_path: big }, s7));
  check("G7 第 1 次全读：不打扰", !ctxOf(first) && allowed(first));
  const second = callHook(TOOLS_HOOK, toolEv("Read", { file_path: big }, s7));
  check("G7 第 2 次全读：警告", /第 2 次全量读入/.test(ctxOf(second)) && !denied(second));
  const partial = callHook(TOOLS_HOOK, toolEv("Read", { file_path: big, offset: 1, limit: 50 }, s7));
  check("G7 分段读（offset/limit）：不计数不警告", !ctxOf(partial));

  const s8 = newSid("g8");
  const small = path.join(tmp, "small.ts");
  fs.writeFileSync(small, "a\n");
  let warned = 0;
  let everDenied = false;
  for (let i = 0; i < 8; i += 1) {
    const r = callHook(TOOLS_HOOK, toolEv("Edit", { file_path: small }, s8));
    if (ctxOf(r)) warned += 1;
    if (denied(r)) everDenied = true;
  }
  check("G8 第 8 次编辑触发警告", warned >= 1, `实际警告 ${warned} 次`);
  check("G8 只警告，从不 deny（方案硬要求）", !everDenied);

  // 软化验证：跑过 L1 之后不再警告
  const s8b = newSid("g8b");
  for (let i = 0; i < 7; i += 1) callHook(TOOLS_HOOK, toolEv("Edit", { file_path: small }, s8b));
  callHook(BASH_HOOK, bashEv("npx vitest run src/a.spec.ts", s8b));
  postBash("npx vitest run src/a.spec.ts", s8b, true);
  const r8 = callHook(TOOLS_HOOK, toolEv("Edit", { file_path: small }, s8b));
  check("G8 软化：中途跑过 L1 定向测试则不警告", !ctxOf(r8));

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ══════════════════════════════ 后置事件不产出决定
section("【附加】PostToolUse / PostToolUseFailure 绝不产出决定");
{
  const sid = newSid("post");
  check("PreToolUse(sed -i) 被拦", denied(preBash("sed -i 's/a/b/' x.ts", sid)));
  const post = postBash("sed -i 's/a/b/' x.ts", sid, true);
  check("PostToolUse 不输出任何决定（工具已跑完，拦不住）", post.raw.trim() === "");
  const pf = postBash("sed -i 's/a/b/' x.ts", sid, false);
  check("PostToolUseFailure 不输出任何决定", pf.raw.trim() === "");
}

// ══════════════════════════════ fail-open
section("【附加】hook 自身异常必须 fail-open");
{
  const r = spawnSync(process.execPath, [BASH_HOOK], { input: "", encoding: "utf8", cwd: ROOT, env: TEST_ENV });
  check("空 stdin：exit 0 且无输出（不干预）", r.status === 0 && (r.stdout || "").trim() === "");
  const r2 = spawnSync(process.execPath, [BASH_HOOK], { input: "{坏 JSON", encoding: "utf8", cwd: ROOT, env: TEST_ENV });
  check("坏 JSON：exit 0 且无输出（不干预）", r2.status === 0 && (r2.stdout || "").trim() === "");

  // 第 2 段（日志中心）：把这次自检台产生的拦截记录**顺手验证一下**，然后清掉，
  // 免得临时目录越堆越多（这也是第 1 段遗留的"沙箱清理失败"那个毛病的正确做法）。
  const blockDir = path.join(TEST_LOG_ROOT, "04-拦截");
  const blocks = fs.existsSync(blockDir) ? fs.readdirSync(blockDir).filter((f) => f.endsWith(".jsonl")) : [];
  check("★ 拦截记录落在日志中心 04-拦截\\（第 2 段迁移生效）", blocks.length > 0, `目录=${blockDir}`);
  try {
    fs.rmSync(TEST_LOG_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

// ───────────────────────────────────────────── 收尾
console.log(`\n${"─".repeat(60)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(fail ? 1 : 0);
