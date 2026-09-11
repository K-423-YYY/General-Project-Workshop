/**
 * model-learning-selftest.mjs —— 自主学习三根线（第 3 段 · 锁定决策 6）的零成本自检台
 * ============================================================
 * 守什么：三根线必须**真的接上了**，而不是"代码里写了三行注释"。
 *   ① statusLine → context-size（记录引擎报出的真实窗口）
 *   ② 会话出错中断 → prompt-too-long（自动下调 25%）
 *   ③ 会话正常收尾（连续 ≥30 轮）→ session-ok（上调 10%，有上限保护）
 * 全部在**临时沙箱**里跑：状态目录指向 HARNESS_STATE_DIR、日志根指向临时目录，
 * 断言跑完还会核对「真实工作区 / 项目目录一个文件都没多」。
 *
 * 零额度：全程不发任何模型请求（probe-model 的 --record 是被动学习通道）。
 *
 * 跑法：node AI-Dev-Harness/自定义/scripts/tests/model-learning-selftest.mjs [--keep]
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

const PROBE_MODEL = path.join(SCRIPTS, "probe-model.mjs");
const STATUSBAR = path.join(ROOT, ".claude", "hooks", "statusline.mjs");
const ON_STOP = path.join(ROOT, ".claude", "hooks", "on-stop.mjs");

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(`${name}${detail ? ` —— ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function skipped(name, why) { skip += 1; console.log(`  ○ ${name}（跳过：${why}）`); }
function section(t) { console.log(`\n${t}`); }

const KEEP = process.argv.includes("--keep");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "b3-learn-"));
const STATE = path.join(sandbox, "state");        // 假装是本机的 HARNESS_STATE_DIR
const LOGS = path.join(sandbox, "日志");           // 假装是工作区根的日志中心
const PROJECT = path.join(sandbox, "proj");        // 假装是被开发的项目
fs.mkdirSync(path.join(PROJECT, ".claude", "hooks"), { recursive: true });

const TEST_MODEL = "learning-selftest-model";
const TEST_ENDPOINT = "127.0.0.1:9/probe";

function runNode(argv, { input, env = {}, cwd = ROOT, timeoutMs = 60000 } = {}) {
  const r = spawnSync(process.execPath, argv, {
    input,
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      HARNESS_STATE_DIR: STATE,
      HARNESS_LOG_ROOT: LOGS,
      HARNESS_ROOT: HARNESS,       // 项目在沙箱里（工作区之外）时，靠它找到 harness
      ANTHROPIC_MODEL: TEST_MODEL,
      ANTHROPIC_BASE_URL: TEST_ENDPOINT,
      ...env,
    },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const profileFile = () => {
  const dir = path.join(STATE, "model-profiles");
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f))[0] ?? null; }
  catch { return null; }
};
const readProfile = () => { const f = profileFile(); try { return f ? JSON.parse(fs.readFileSync(f, "utf8")) : null; } catch { return null; } };
const modelTrace = () => {
  const dir = path.join(LOGS, "08-模型");
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("model-") && f.endsWith(".jsonl"));
    return files.length ? fs.readFileSync(path.join(dir, files[0]), "utf8") : "";
  } catch { return ""; }
};
const listFiles = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(p); } };
  try { walk(dir); } catch { /* 不存在 */ }
  return out;
};

console.log("第 3 段自检台 · 自主学习三根线（statusLine / 出错中断 / 正常收尾）");
console.log(`沙箱：${sandbox}`);
console.log(`状态目录（HARNESS_STATE_DIR）：${STATE}`);

// ════════════════════════════════════════════════════════════
section("① 画像通道：--record 能写画像 + 能落 日志\\08-模型\\ 轨迹");

const r1 = runNode([PROBE_MODEL, "--record", "context-size", "--window", "131072",
  "--model", TEST_MODEL, "--endpoint", TEST_ENDPOINT, "--harness-root", HARNESS]);
check("probe-model --record context-size 退出 0", r1.code === 0, `exit=${r1.code}\n${r1.out.slice(0, 400)}`);
check("画像文件写在 HARNESS_STATE_DIR\\model-profiles（不是工作区、更不是项目）",
  !!profileFile(), `state=${STATE} 实得 ${profileFile() ?? "(无)"}`);
const p1 = readProfile();
check("画像记下了引擎报出的窗口（declaredWindow=131072）", Number(p1?.declaredWindow) === 131072,
  `declaredWindow=${p1?.declaredWindow}`);
check("日志\\08-模型\\ 有轨迹（signal=context-size）", /context-size/.test(modelTrace()),
  modelTrace().slice(0, 200) || "(空)");

// ════════════════════════════════════════════════════════════
section("② 出错中断 → prompt-too-long：自动下调 25%");

const before2 = Number(readProfile()?.effectiveWindow);
const r2 = runNode([PROBE_MODEL, "--record", "prompt-too-long",
  "--model", TEST_MODEL, "--endpoint", TEST_ENDPOINT, "--harness-root", HARNESS]);
const after2 = Number(readProfile()?.effectiveWindow);
const expect2 = Math.max(32768, Math.round(before2 * 0.75));
check("退出 0", r2.code === 0, `exit=${r2.code}`);
check(`窗口下调 25%（${before2} → ${after2}，期望 ${expect2}）`, after2 === expect2, `实得 ${after2}`);
check("日志\\08-模型\\ 记下了 prompt-too-long 的 before → after",
  /prompt-too-long/.test(modelTrace()) && /windowBefore/.test(modelTrace()));

// ════════════════════════════════════════════════════════════
section("③ 正常收尾 → session-ok：轮次不够不上调，够了才 +10%（有上限）");

const before3 = Number(readProfile()?.effectiveWindow);
const r3a = runNode([PROBE_MODEL, "--record", "session-ok", "--turns", "5",
  "--model", TEST_MODEL, "--endpoint", TEST_ENDPOINT, "--harness-root", HARNESS]);
const after3a = Number(readProfile()?.effectiveWindow);
check("轮次 5 < 阈值 30 → 不上调（无变化）", after3a === before3 && /不触发上调/.test(r3a.out),
  `${before3} → ${after3a}；输出：${r3a.out.split("\n")[1] ?? ""}`);

const r3b = runNode([PROBE_MODEL, "--record", "session-ok", "--turns", "60",
  "--model", TEST_MODEL, "--endpoint", TEST_ENDPOINT, "--harness-root", HARNESS]);
const after3b = Number(readProfile()?.effectiveWindow);
check("轮次 60 ≥ 30 → 上调 10%（或已被上限夹住）",
  after3b === Math.min(before3 + Math.max(1, Math.round(before3 * 0.1)), 102400) || after3b >= before3,
  `${before3} → ${after3b}；${r3b.out.split("\n")[1] ?? ""}`);
check("★ 上限保护：窗口永远不超过保守上限 102400", after3b <= 102400, `实得 ${after3b}`);

// ════════════════════════════════════════════════════════════
section("④ statusLine → context-size（第①根线，接在真实 hook 上）");

const statusPayload = JSON.stringify({
  session_id: "learn-status", cwd: PROJECT,
  model: { display_name: TEST_MODEL },
  context_window: { used_percentage: 12, context_window_size: 200000, remaining_percentage: 88 },
});
const r4 = runNode([STATUSBAR], { input: statusPayload, cwd: PROJECT });
check("statusline 退出 0（状态栏永不崩）", r4.code === 0, `exit=${r4.code}`);
check("statusline 把报告窗口记进了画像（declaredWindow=200000）",
  Number(readProfile()?.declaredWindow) === 200000, `declaredWindow=${readProfile()?.declaredWindow}`);
check("ctx.json 写在 HARNESS_STATE_DIR 下（不写项目目录）",
  listFiles(STATE).some((f) => /ctx\.json$/.test(f)) &&
    !listFiles(PROJECT).some((f) => /ctx\.json$/.test(f)));
check("上报去重记录也在状态目录（learn-report.json）",
  listFiles(STATE).some((f) => /learn-report\.json$/.test(f)));

// ════════════════════════════════════════════════════════════
section("⑤ on-stop → 轮次累计 + 第②③根线（接在真实 hook 上）");

const stopPayload = (msg, sid = "learn-stop") => JSON.stringify({
  session_id: sid, hook_event_name: "Stop", cwd: PROJECT, stop_hook_active: false, last_assistant_message: msg,
});

// 30 次正常收尾 = 30 轮；第 30 次应触发一次 session-ok 上报
const before5 = Number(readProfile()?.effectiveWindow);
let stopOk = true;
for (let i = 1; i <= 30; i++) {
  const r = runNode([ON_STOP], { input: stopPayload(`第 ${i} 轮正常收尾`), cwd: PROJECT });
  if (r.code !== 0) { stopOk = false; break; }
}
check("连跑 30 次 Stop，on-stop 每次都退出 0（fail-open）", stopOk);
const after5 = Number(readProfile()?.effectiveWindow);
check("★ 第③根线：第 30 轮触发 session-ok 上调（画像窗口变了或已到上限）",
  after5 >= before5 && /session-ok/.test(modelTrace()),
  `${before5} → ${after5}`);

// 超长中断 → 立刻下调
const before6 = Number(readProfile()?.effectiveWindow);
const r6 = runNode([ON_STOP], {
  input: stopPayload("API Error: 400 prompt is too long: 210000 tokens > 200000 maximum context length", "learn-toolong"),
  cwd: PROJECT,
});
const after6 = Number(readProfile()?.effectiveWindow);
check("★ 第②根线：识别出超长中断并退出 0", r6.code === 0, `exit=${r6.code}`);
check(`检出超长后窗口下调（${before6} → ${after6}）`, after6 < before6, `实得 ${after6}`);
check("日志\\08-模型\\ 里能看到 prompt-too-long 的两次记录",
  (modelTrace().match(/prompt-too-long/g) ?? []).length >= 2);

// ════════════════════════════════════════════════════════════
section("⑥ 卫生：真实工作区 / 项目目录一个文件都没多");

check("自检台没有往 <harness>\\state 写任何东西（全部走 HARNESS_STATE_DIR）",
  !listFiles(path.join(HARNESS, "state")).some((f) => /learning-selftest-model|learn-report/.test(f)));
check("自检台没有往真实 日志\\08-模型 写测试记录",
  !/learning-selftest-model/.test((() => {
    try { return listFiles(path.join(ROOT, "日志", "08-模型")).map((f) => fs.readFileSync(f, "utf8")).join("\n"); }
    catch { return ""; }
  })()));
check("项目目录里没有画像 / 状态文件（绝不动项目文件夹）",
  !listFiles(PROJECT).some((f) => /model-profiles|quota\.json|ctx\.json|learn-report/.test(f)),
  listFiles(PROJECT).map((f) => path.relative(PROJECT, f)).join(", "));

// ───────────────────────────────────────────── 收尾
console.log(`\n${"─".repeat(64)}`);
console.log(`自检结果：${pass} 项通过、${fail} 项失败、${skip} 项跳过`);
if (failures.length) { console.log("失败项："); for (const f of failures) console.log(`  · ${f}`); }
if (KEEP) console.log(`沙箱保留在 ${sandbox}`);
else {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); console.log("沙箱已清理"); }
  catch { console.log(`沙箱清理失败（可手动删）：${sandbox}`); }
}
process.exit(fail ? 1 : 0);
