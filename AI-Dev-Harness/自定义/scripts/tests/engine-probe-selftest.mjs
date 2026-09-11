/**
 * engine-probe-selftest.mjs —— 第 6 批（引擎探测 + U5 适配）的零成本自检台
 *
 * 与前几批（hooks-selftest / context-selftest / scaffold-selftest）同一路数：
 * 跑**真实脚本**、逐项断言，不启动模型、不消耗额度。
 *
 * 它守三件事：
 *   ① 探测铁律有没有被违反 —— 跑过的命令里不许出现任何**用户配置文件**路径
 *   ② 交付的配置片段是不是**真的合法** ——
 *        · 引擎适配/codex/config-hooks.toml 交给 codex --strict-config 验
 *        · 引擎适配/dsh/patch-overlay.yml 交给 dsh --patch 验
 *   ③ codex/hook-guard.mjs 的行为 —— 拦得住 / 放得过 / 逃生阀 / fail-open
 *
 * 引擎没装时对应小节自动跳过（记 skip，不算失败）——本自检台在别的机器上也该能跑。
 *
 * ★ 第 3 段（P2-5）：**「装了没」一律问统一解析器**（lib/engine-detect.mjs → resolve-command.mjs），
 *   不再用 `where` / spawnSync("codex")。旧写法在 Windows 上必错：
 *   `.cmd` 垫片 spawnSync 直接 ENOENT、空扩展名优先会挑错文件 ——
 *   实测后果就是「codex 明明装了，自检台却说本机没有 codex」。
 *
 * ★ 第 3 段（P2-6）：Codex 的协议侦察落盘改到 **state 目录**（或 HARNESS_STATE_DIR），
 *   所以本自检台把它指到沙箱临时目录再断言 —— 既不污染交付目录，也不受只读目录影响。
 *
 * 跑法：node AI-Dev-Harness/自定义/scripts/tests/engine-probe-selftest.mjs [--keep]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));  // …\自定义\scripts\tests
const SCRIPTS = path.resolve(HERE, "..");                   // …\自定义\scripts
const CUSTOM = path.resolve(SCRIPTS, "..");                 // …\自定义
const HARNESS = path.resolve(CUSTOM, "..");                 // …\AI-Dev-Harness
const ROOT = path.resolve(HARNESS, "..");                   // …\General-Project-Workshop

const PROBE = path.join(SCRIPTS, "probe-engines.mjs");
const ADAPTERS = path.join(CUSTOM, "引擎适配");
const CODEX_HOOKS = path.join(ADAPTERS, "codex", "config-hooks.toml");
const CODEX_GUARD = path.join(ADAPTERS, "codex", "hook-guard.mjs");
const DSH_OVERLAY = path.join(ADAPTERS, "dsh", "patch-overlay.yml");
const TABLE = path.join(CUSTOM, "引擎能力表.json");
const ENGINE_DETECT = path.join(SCRIPTS, "lib", "engine-detect.mjs");
const ENV_DOCTOR = path.join(SCRIPTS, "env-doctor.mjs");

// ★ 第 3 段：安装判定走统一解析器（本自检台自己也要用它，否则又是两套规则）
const { detectEngine, engineChoiceList } = await import(new URL("../lib/engine-detect.mjs", import.meta.url).href);

/** 第 2 段（日志中心）：自检台用的临时日志根 —— 探测记录不写进真日志中心 */
const TEST_LOG_ROOT = path.join(os.tmpdir(), `harness-engine-probe-selftest-日志-${process.pid}`);

// ───────────────────────────────────────────── 迷你测试台

let pass = 0, fail = 0, skip = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else {
    fail += 1;
    failures.push(`${name}${detail ? ` —— ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function skipped(name, why) { skip += 1; console.log(`  ○ ${name}（跳过：${why}）`); }
function section(t) { console.log(`\n${t}`); }

function run(cmd, argv, opts = {}) {
  const line = [cmd, ...argv].map((s) => (/[\s"&|<>^()]/.test(String(s)) ? `"${String(s).replace(/"/g, "")}"` : String(s))).join(" ");
  const r = spawnSync(line, {
    shell: true,
    cwd: opts.cwd ?? ROOT,
    // 第 2 段（日志中心）：把日志根指到临时目录，自检台的探测记录不混进真日志中心
    env: { ...process.env, HARNESS_LOG_ROOT: TEST_LOG_ROOT, ...(opts.env ?? {}) },
    encoding: "utf8",
    input: opts.input,
    timeout: opts.timeoutMs ?? 60000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
/**
 * 「这个引擎装了没」—— 问统一解析器，不问 `where`。
 * 返回 { installed, path, via }，方便失败信息里写清「是怎么探到的」（避免下次又误报）。
 */
const engineOf = (id) => detectEngine(id);
const has = (id) => engineOf(id).installed;
const exists = (p) => fs.existsSync(p);

/** 用户配置文件 —— 探测**绝不允许**碰的那些（可能含 API key）。 */
const FORBIDDEN = [
  ".codex/config.toml", ".codex/auth.json",
  ".dsh/settings.yaml", ".dsh/.credentials.yaml", ".dsh/.anonymous-user-id",
  ".claude/settings.json", ".claude.json",
];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "b6-selftest-"));
const KEEP = process.argv.includes("--keep");

// ════════════════════════════════════════════════════════════
console.log("第 6 批自检台 · 引擎能力探测 + U5 适配");
console.log(`沙箱：${sandbox}`);

// ───────────────────────────────────────────── ① 交付物齐不齐
section("① 交付物清单（04 文档第 6 批：F9 / F10 / F11）");
for (const [label, p] of [
  ["F9  probe-engines.mjs", PROBE],
  ["F11 引擎适配/README.md", path.join(ADAPTERS, "README.md")],
  ["F11 引擎适配/codex/config-hooks.toml", CODEX_HOOKS],
  ["F11 引擎适配/codex/hook-guard.mjs", CODEX_GUARD],
  ["F11 引擎适配/dsh/patch-overlay.yml", DSH_OVERLAY],
  ["F11 引擎适配/traecode/README.md", path.join(ADAPTERS, "traecode", "README.md")],
]) check(label, exists(p), p);

// ───────────────────────────────────────────── ② 探测脚本本身
section("② 探测脚本：能跑、能出 JSON、遵守铁律");

// ⚠️ 超时必须给足：整套差分探测要跑 23 次 codex + 5 次 dsh，实测约 70 秒。
//    之前给 60 秒 → 进程被杀 → 下面的 JSON 断言连锁失败（不是产品的问题）。
const dry = run(process.execPath, [PROBE, "--json", "--dry-run", "--verbose"], { timeoutMs: 300000 });
check("probe-engines.mjs --json --dry-run 退 0", dry.code === 0, `exit=${dry.code}\n${dry.out.slice(0, 400)}`);

let table = null;
try { table = JSON.parse(dry.stdout); } catch { /* 下面断言会报 */ }
check("--json 输出是可解析的 JSON", table !== null);

if (table) {
  check("JSON 有 engines 段且四个引擎齐全",
    table.engines && ["claude-code", "codex-cli", "deepseek-harness", "traecode-cli"].every((id) => table.engines[id]),
    Object.keys(table.engines ?? {}).join(", "));
  check("每个引擎都带 confidence（不把『未查明』当『不支持』）",
    Object.values(table.engines).every((e) => typeof e.mechanism?.confidence === "string" && e.mechanism.confidence.length > 0));
  check("每个引擎都带 ruleAutoload 结论", Object.values(table.engines).every((e) => typeof e.ruleAutoload?.supported === "boolean"));
  check("unknowns 非空（如实标注未查明项）", Array.isArray(table.unknowns) && table.unknowns.length > 0,
    `${table.unknowns?.length ?? 0} 条`);
  check("probePolicy 写明了绝不读的文件清单",
    Array.isArray(table.probePolicy?.绝不读的文件) && table.probePolicy.绝不读的文件.length >= 5);
}

// ★ 核心安全断言：跑过的命令里不许出现用户配置文件路径
const ranCommands = [...dry.out.matchAll(/^[│$]\s*(.+)$/gm)].map((m) => m[1]);
const leaked = ranCommands.filter((c) => {
  const low = c.toLowerCase();
  return FORBIDDEN.some((f) => low.includes(f.replace(/\//g, "\\")) || low.includes(f));
});
check(`执行过的命令里没有任何用户配置文件路径（扫了 ${ranCommands.length} 条命令行）`, leaked.length === 0,
  leaked.join(" | "));

// 隔离手段必须在场。CODEX_HOME 是**经 env 传的**，不会出现在命令行里，
// 所以这里验的是「结果里标注了隔离」+「命令行里没有 ~/.codex」两件事。
const codexCalls = ranCommands.filter((c) => /(^|\s)codex\s/.test(c));
const codexLinesClean = !codexCalls.some((c) => /\.codex[\\/]/i.test(c));
const codexIsolated = table?.engines?.["codex-cli"]?.features?.isolated_home === true;
check("codex 探测走隔离 CODEX_HOME（命令行里不出现用户的 ~/.codex）",
  codexLinesClean && (codexIsolated || table?.engines?.["codex-cli"]?.installed === false),
  `codex 调用 ${codexCalls.length} 条；isolated_home=${codexIsolated}`);

// ───────────────────────────────────────────── ③ Codex：交付片段是否真的合法
section("③ Codex 适配：config-hooks.toml 交给 codex --strict-config 验");

const codexDet = engineOf("codex-cli");
if (!codexDet.installed) {
  skipped("config-hooks.toml 合法性", `本机没有 codex（统一解析器探过：${codexDet.via ?? "未找到"}）`);
} else {
  const home = fs.mkdtempSync(path.join(sandbox, "codex-home-"));
  fs.copyFileSync(CODEX_HOOKS, path.join(home, "config.toml"));
  // ★ 用统一解析器拿到的**真实路径**去跑，不再写 "codex" 让 shell 找第二遍（P2-5）
  const CODEX_BIN = codexDet.path;
  const r = run(CODEX_BIN, ["--strict-config", "-m", "zzz-probe-unknown-model", "exec", "echo probe"], { env: { CODEX_HOME: home } });
  const cfgErr = /Error loading config\.toml:\s*([^\n]*)/.exec(r.out);
  check("交付的 [hooks] 片段被 codex 判定为合法配置", !cfgErr,
    cfgErr ? cfgErr[0] : "");
  check(`探测到的 codex 就是本机真实的 codex（${codexDet.via ?? "?"}）`,
    /\d+\.\d+\.\d+/.test(r.out) || /Error loading|unknown configuration field|not a git repository|trusted/i.test(r.out),
    `codex=${CODEX_BIN} exit=${r.code}`);
  // 交付片段里必须真的指向 hook-guard.mjs，且带 <harness> 占位符说明（否则用户不知道要替换）
  const toml = fs.readFileSync(CODEX_HOOKS, "utf8");
  check("交付片段里有 hook-guard.mjs 与 <harness> 占位符",
    /hook-guard\.mjs/.test(toml) && /<harness>/.test(toml));
  check("对照组有效（不存在的键必须报错）", (() => {
    fs.writeFileSync(path.join(home, "config.toml"), "zzz_not_a_key = true\n", "utf8");
    const c = run(CODEX_BIN, ["--strict-config", "-m", "zzz-probe-unknown-model", "exec", "echo probe"], { env: { CODEX_HOME: home } });
    return /unknown configuration field/.test(c.out);
  })(), "差分法前提不成立则上面的『合法』结论无效");
}

// ───────────────────────────────────────────── ④ DSH：交付叠加层是否可加载
section("④ DSH 适配：patch-overlay.yml 交给 dsh --patch 验");

const dshDet = engineOf("deepseek-harness");
if (!dshDet.installed) {
  skipped("patch-overlay.yml 可加载", `本机没有 dsh（统一解析器探过：${dshDet.via ?? "未找到"}）→ 结论保留自上次实测，本轮未复验`);
} else {
  const r = run(dshDet.path, ["--profile", "headless", "--patch", DSH_OVERLAY, "--dump-config"]);
  const err = /failed to (read overlay|parse)/.exec(r.out);
  check("交付的 patch-overlay.yml 被 dsh 接受（不报读/解析错误）", !err, err ? err[0] : "");
  // ⚠️ 只断言错误码，**不打印/不落盘** dump 内容（它含用户层）
  check("dsh 组合成功（exit 0）", r.code === 0, `exit=${r.code}`);
}

// ───────────────────────────────────────────── ⑤ hook-guard.mjs 行为
section("⑤ Codex 侧 hook-guard.mjs 行为");

const guardPayload = (cmd, cwd) => JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_input: { command: cmd } });

if (!exists(CODEX_GUARD)) check("hook-guard.mjs 存在", false);
else {
  const work = fs.mkdtempSync(path.join(sandbox, "guard-"));
  // ★ 第 3 段（P2-6）：协议侦察的落盘点改到 **state 目录**，本自检台把它指到沙箱里。
  //   好处有两个：① 交付目录不会再攒运行垃圾（旧实现写 引擎适配\codex\stdin.jsonl）；
  //   ② 断言不再依赖「交付目录可写」—— 只读分发目录下也不会假红。
  const probeState = fs.mkdtempSync(path.join(sandbox, "guard-state-"));
  const PROBE_LOG = path.join(probeState, "codex-probe", "stdin.jsonl");
  const call = (cmd, cwd = work) => run(process.execPath, [CODEX_GUARD], {
    input: guardPayload(cmd, cwd), cwd, timeoutMs: 15000, env: { HARNESS_STATE_DIR: probeState },
  });

  const denied = call("sed -i 's/a/b/' src/foo.ts");
  check("sed -i 被拒（exit 2）", denied.code === 2, `exit=${denied.code}`);
  check("拒绝理由写在 stderr 且是『教学』的（含为什么/怎么做/怎么解除）",
    /为什么/.test(denied.stderr) && /怎么做/.test(denied.stderr) && /bypass/.test(denied.stderr));

  check("cat > 源文件 被拒（exit 2）", call("cat > src/bar.ts <<EOF").code === 2);
  check("python -c 内联改码 被拒（exit 2）", call(`python -c "open('x.ts','w').write('y')"`).code === 2);
  check("sleep 180 被拒（exit 2）", call("sleep 180").code === 2);

  const ok = call("node --test test/sum.test.mjs");
  check("正常命令放行（exit 0）", ok.code === 0, `exit=${ok.code}`);

  // 注意也要带上沙箱 state（否则这次的协议侦察会落到**真实** harness\state\codex-probe\ 里）
  const bad = run(process.execPath, [CODEX_GUARD], {
    input: "{ not json", cwd: work, timeoutMs: 15000, env: { HARNESS_STATE_DIR: probeState },
  });
  check("载荷非法时 fail-open（exit 0，不把引擎卡死）", bad.code === 0, `exit=${bad.code}`);

  // 逃生阀
  const bypassWork = fs.mkdtempSync(path.join(sandbox, "guard-bypass-"));
  fs.mkdirSync(path.join(bypassWork, ".harness"), { recursive: true });
  fs.writeFileSync(path.join(bypassWork, ".harness", "bypass"), "", "utf8");
  check("有 .harness/bypass 时 sed -i 放行", call("sed -i 's/a/b/' src/foo.ts", bypassWork).code === 0);

  // 协议侦察落盘（P2-6：落在 state 目录，不是交付目录）
  check("每次调用都把 stdin 原样落盘到 state 目录（协议侦察）",
    exists(PROBE_LOG) && fs.readFileSync(PROBE_LOG, "utf8").includes("PreToolUse"),
    exists(PROBE_LOG) ? `已落盘 ${PROBE_LOG}` : `未生成 ${PROBE_LOG}`);
  check("交付目录里不再生成 stdin.jsonl（旧位置已废弃）",
    !exists(path.join(ADAPTERS, "codex", "stdin.jsonl")));
}

// ───────────────────────────────────────────── ⑥ 能力表已生成且不含密钥样式的串
section("⑥ 引擎能力表.json");

if (!exists(TABLE)) check("引擎能力表.json 已生成", false, "先跑一次 probe-engines.mjs（不带 --dry-run）");
else {
  const raw = fs.readFileSync(TABLE, "utf8");
  let t = null;
  try { t = JSON.parse(raw); } catch { /* 下面报 */ }
  check("可解析", t !== null);
  if (t) {
    check("schema=1 且有 updated", t.schema === 1 && typeof t.updated === "string", `schema=${t.schema} updated=${t.updated}`);
    check("四个引擎都有条目", ["claude-code", "codex-cli", "deepseek-harness", "traecode-cli"].every((id) => t.engines?.[id]));
    check("codex 的 hooks 事件名探到了 12 个",
      (t.engines?.["codex-cli"]?.mechanism?.events?.length ?? 0) === 12,
      `实到 ${t.engines?.["codex-cli"]?.mechanism?.events?.length ?? 0} 个`);
    check("codex 的处理器类型是引擎报出的 4 个",
      ["command", "mcp_tool", "prompt", "agent"].every((v) => (t.engines?.["codex-cli"]?.mechanism?.handlerVariants ?? []).includes(v)),
      (t.engines?.["codex-cli"]?.mechanism?.handlerVariants ?? []).join(","));
    check("DSH 的 --patch 结论是 verified-live",
      // ★ 第 3 段：本机没装 dsh 时，结论来自 lastVerified（保留上次实测值并标注未复验）。
      //   这不是放松要求 —— 是「本机没装 → 不许把上次的真实测结论抹掉」，两边都要能通过。
      t.engines?.["deepseek-harness"]?.patchVerification?.verdict === "verified-live" ||
        t.engines?.["deepseek-harness"]?.lastVerified?.patchVerification?.verdict === "verified-live",
      t.engines?.["deepseek-harness"]?.patchVerification?.verdict ??
        `lastVerified=${t.engines?.["deepseek-harness"]?.lastVerified?.patchVerification?.verdict ?? "(缺)"}`);
    check("TraeCode 明确标为未查明而非不支持",
      t.engines?.["traecode-cli"]?.mechanism?.confidence === "未查明");
  }
  // 别把密钥样式的东西写进交付物
  const keyLike = /\b(sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{20,}|ANTHROPIC_AUTH_TOKEN\s*[:=]\s*\S)/.exec(raw);
  check("能力表里没有密钥样式的字符串", !keyLike, keyLike ? keyLike[0].slice(0, 40) : "");
}

// ───────────────────────────────────────────── ⑦ 第 3 段交付物：统一解析器 / 引擎选择 / 状态重定向
section("⑦ 第 3 段：统一解析器 + 引擎选择 + HARNESS_STATE_DIR");

// 7.1 三个脚本都必须走统一解析器（P2-5 的本体：不是"改了探测"，是"只有一份判定"）
check("lib/engine-detect.mjs 存在（引擎判定的唯一实现）", exists(ENGINE_DETECT));
for (const [label, file] of [
  ["probe-engines.mjs", PROBE],
  ["env-doctor.mjs", ENV_DOCTOR],
  ["engine-probe-selftest.mjs", path.join(HERE, "engine-probe-selftest.mjs")],
]) {
  let src = "";
  try { src = fs.readFileSync(file, "utf8"); } catch { /* 下面断言会报 */ }
  // 只查**非注释行**：说明里写「旧实现用 where / spawnSync("codex")」是好事（历史解释），
  // 一刀切禁掉等于禁止解释历史 —— 与 selftest-ext 里查 .harness\logs 的口径保持一致。
  const codeOnly = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*|#|<!--|rem\b)/i.test(l))
    .join("\n");
  check(`${label} 走统一解析器（import engine-detect / resolve-command）`,
    /engine-detect\.mjs|resolve-command\.mjs/.test(src));
  check(`${label} 不再自己 spawnSync 引擎名 / 用 where 判安装`,
    !/spawnSync\(\s*["'](codex|claude|dsh|traecode)["']/.test(codeOnly) &&
    !/["']where["']\s*,/.test(codeOnly));
}

// 7.2 能力表里的「本轮复验 / 未复验」必须和真实探测一致（装了的引擎不许被标成没探到）
if (exists(TABLE)) {
  let t2 = null;
  try { t2 = JSON.parse(fs.readFileSync(TABLE, "utf8").replace(/^\uFEFF/, "")); } catch { /* 已在上节报过 */ }
  const notRe = t2?.detection?.notRecheckedThisRun ?? [];
  for (const id of ["codex-cli", "claude-code", "deepseek-harness", "traecode-cli"]) {
    const real = engineOf(id).installed;
    if (real) check(`能力表把「${id} 本轮实测在机」标对了（未误报为未安装）`, !notRe.includes(id), `notRechecked=${notRe.join(",")}`);
  }
  check("能力表有 runtimeChoice 段（run.bat 的列表与它同源）", !!t2?.runtimeChoice);
  check("能力表有引擎能力矩阵（含 claude-code-desktop 与 trae-ide 两档）",
    !!(t2?.matrix?.["claude-code-desktop"] && t2?.matrix?.["trae-ide"]));
  check("能力矩阵写明了三档强制力（hooks > 命令包装 > 启动词）",
    /hooks 强制/.test(t2?.matrix?._说明 ?? "") && /命令包装强制/.test(t2?.matrix?._说明 ?? "") && /仅启动词/.test(t2?.matrix?._说明 ?? ""));
  check("能力表 detection 段写明了统一解析器",
    /resolve-command\.mjs/.test(t2?.detection?.resolver ?? ""));
}

// 7.3 引擎选择记忆（锁定决策 10）：落盘 + 能沿用
{
  const stateTmp = fs.mkdtempSync(path.join(sandbox, "engine-state-"));
  const r1 = run(process.execPath, [ENGINE_DETECT, "--remember", "codex-cli"], { env: { HARNESS_STATE_DIR: stateTmp } });
  const choiceFile = path.join(stateTmp, "engine-choice.json");
  check("记住引擎选择：退出 0 且落盘到 HARNESS_STATE_DIR", r1.code === 0 && exists(choiceFile),
    `exit=${r1.code} file=${exists(choiceFile)}`);
  const r2 = run(process.execPath, [ENGINE_DETECT, "--pick"], { env: { HARNESS_STATE_DIR: stateTmp } });
  check("下次启动能沿用上次选择（--pick 返回 codex-cli）", r2.stdout.trim() === "codex-cli", `实得「${r2.stdout.trim()}」`);
  const r3 = run(process.execPath, [ENGINE_DETECT, "--json"], { env: { HARNESS_STATE_DIR: stateTmp } });
  let j3 = null; try { j3 = JSON.parse(r3.stdout); } catch { /* 断言会报 */ }
  check("引擎列表里 codex-cli 可用（本机装了 codex）", (j3?.available ?? []).some((d) => d.id === "codex-cli"));
  check("没装的引擎明确列在 notInstalled 里（不再误报「本机没有 codex」的镜像问题）",
    Array.isArray(j3?.unavailable) &&
      j3.unavailable.every((d) => !d.installed) &&
      j3.available.every((d) => d.installed && d.path),
    `可用=${(j3?.available ?? []).map((d) => d.id).join(",")}｜未装=${(j3?.unavailable ?? []).map((d) => d.id).join(",")}`);
}

// 7.4 HARNESS_STATE_DIR 重定向：状态写过去、项目目录不受影响
{
  const projTmp = fs.mkdtempSync(path.join(sandbox, "state-proj-"));
  const sTmp = fs.mkdtempSync(path.join(sandbox, "state-out-"));
  fs.mkdirSync(path.join(projTmp, ".claude", "state"), { recursive: true });
  const payload = JSON.stringify({
    session_id: "statetest", hook_event_name: "Stop", cwd: projTmp, stop_hook_active: false,
    last_assistant_message: "验收：状态重定向",
  });
  const r = run(process.execPath, [path.join(ROOT, ".claude", "hooks", "on-stop.mjs")], {
    input: payload, cwd: projTmp,
    env: { HARNESS_STATE_DIR: sTmp, HARNESS_LOG_ROOT: TEST_LOG_ROOT },
  });
  check("on-stop 在 HARNESS_STATE_DIR 下退出 0（fail-open）", r.code === 0, `exit=${r.code}`);
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  try { walk(sTmp); } catch { /* 空目录 */ }
  check("状态确实写到了 HARNESS_STATE_DIR（新建了项目状态目录）", files.length > 0,
    `临时状态目录里的文件：${files.map((f) => path.relative(sTmp, f)).join(", ") || "(空)"}`);
  const inProject = (() => {
    try {
      const out = [];
      const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else out.push(path.relative(projTmp, p)); } };
      w(projTmp);
      return out.filter((f) => /quota\.json|ctx\.json|stop-guard\.json|learn-report\.json/.test(f));
    } catch { return []; }
  })();
  check("项目目录里没有多出任何状态文件（重定向生效）", inProject.length === 0, inProject.join(", "));
}

// 7.5 G10 的 shell 守卫（P2-2）：非 bash 环境放弃包装，而不是产出跑不通的命令
{
  const g10Proj = fs.mkdtempSync(path.join(sandbox, "g10-"));
  fs.mkdirSync(path.join(g10Proj, ".claude", "hooks"), { recursive: true });
  const rewritable = JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "g10", cwd: g10Proj,
    tool_input: { command: "npm test" },
  });
  const noBash = run(process.execPath, [path.join(ROOT, ".claude", "hooks", "guard-bash.mjs")], {
    input: rewritable, cwd: g10Proj, env: { HARNESS_BASH: "none", HARNESS_LOG_ROOT: TEST_LOG_ROOT },
  });
  let parsed = null; try { parsed = JSON.parse(noBash.stdout || "null"); } catch { /* 空输出=没改写 */ }
  check("没有可用 bash 时 G10 放弃包装（不产出 bash 专用语法）",
    !(parsed?.hookSpecificOutput?.updatedInput),
    noBash.stdout.slice(0, 200));
  const psTool = JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "powershell", session_id: "g10b", cwd: g10Proj,
    tool_input: { command: "npm test" },
  });
  const r2 = run(process.execPath, [path.join(ROOT, ".claude", "hooks", "guard-bash.mjs")], {
    input: psTool, cwd: g10Proj, env: { HARNESS_LOG_ROOT: TEST_LOG_ROOT },
  });
  let p2 = null; try { p2 = JSON.parse(r2.stdout || "null"); } catch { /* 空输出=没改写 */ }
  check("工具名是 powershell 时 G10 也不包装", !(p2?.hookSpecificOutput?.updatedInput), r2.stdout.slice(0, 200));
}

// ───────────────────────────────────────────── ⑧ 没有污染真实工作区
section("⑧ 没有污染真实工作区");

  // 我的项目\ 允许有骨架占位 .gitignore（见 scaffold-selftest 里的同款说明）
  const realProject = exists(path.join(ROOT, "我的项目")) ? fs.readdirSync(path.join(ROOT, "我的项目")) : null;
  check("我的项目\\ 里只有骨架占位（没有测试残留）",
    realProject !== null && realProject.every((f) => f === ".gitignore"),
    realProject ? realProject.join(", ") : "(不存在)");
check("本次没有往 .claude/ 新增文件", !fs.readdirSync(path.join(ROOT, ".claude")).some((f) => /^b6-|selftest/.test(f)));
// ★ 第 3 段：协议侦察必须落在**沙箱 state**里，不许落到真实 harness\state\codex-probe\
check("本次没有往真实 AI-Dev-Harness\\state\\codex-probe\\ 写侦察数据（全部走沙箱 state）",
  (() => {
    try {
      const f = path.join(HARNESS, "state", "codex-probe", "stdin.jsonl");
      if (!exists(f)) return true;
      // 允许"历史上存在"，但断言：本次跑完之后它的**修改时间**没有变新（用 5 分钟窗口近似判断）
      return Date.now() - fs.statSync(f).mtimeMs > 5 * 60 * 1000;
    } catch { return true; }
  })(), "真实 state\\codex-probe\\stdin.jsonl 刚刚被写过");

// ───────────────────────────────────────────── 收尾
console.log(`\n${"─".repeat(64)}`);
console.log(`自检结果：${pass} 项通过、${fail} 项失败、${skip} 项跳过`);
if (failures.length) { console.log("失败项："); for (const f of failures) console.log(`  · ${f}`); }
if (KEEP) console.log(`沙箱保留在 ${sandbox}`);
else {
  // codex 会在隔离 HOME 里建 SQLite，进程退出后句柄还要几百毫秒才放。
  // 真·同步睡眠再重试（不用 spawnSync 空转，那个等不住）。
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let removed = false;
  // ★ 第 3 段：重试次数 8 → 20（约 10 秒）。旧实现常在 Windows 上留下
  //   `b6-selftest-*` 目录，每次跑都提示「沙箱清理失败（可手动删）」—— 那是本自检台自己的卫生问题。
  for (let i = 0; i < 20 && !removed; i++) {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); removed = true; }
    catch { sleepSync(500); }
  }
  console.log(removed ? "沙箱已清理" : `沙箱清理失败（可手动删）：${sandbox}`);
  // 临时日志根也一起收掉（自检台不该往真日志中心或系统临时目录留东西）
  try { fs.rmSync(TEST_LOG_ROOT, { recursive: true, force: true }); } catch { /* 无所谓 */ }
}
process.exit(fail ? 1 : 0);
