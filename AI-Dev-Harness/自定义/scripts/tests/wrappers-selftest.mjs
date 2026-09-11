#!/usr/bin/env node
/**
 * tests/wrappers-selftest.mjs —— 命令包装器「真的执行了吗」自检台（P0-1 / P0-2 的防回归闸门）
 * ============================================================
 * 为什么要有这个自检台：
 *   原本 5 个自检台里**没有一个**碰过 `自定义\bin\_log.mjs`，这正是 P0-1 能漏网的原因 ——
 *   包装器里 npm / npx 会「不执行、无输出、退出码 0」，而所有自检台都是绿的。
 *
 * 它测什么（四段）：
 *   【A】解析器单元：扩展名优先级 / PATHEXT / skipDirs（用合成目录，结果确定，不依赖本机装了什么）
 *   【B】MSYS 路径映射：/usr/bin 能不能映射到真实安装目录，sleep 还能不能找到（P0-2）
 *   【C】端到端「对照 vs 包装」：同一条命令行，唯一差别是 PATH 有没有前置 `自定义\bin`
 *        · 对照必须先真的跑起来（非零退出码也是"真的跑了"）
 *        · 断言：退出码一致、stdout 一致（不被吞/不变形）、确实留下审计记录
 *   【D】防回归：spawn 失败一律 127（绝不 0）、sed -i 仍被拦、无扩展名垫片不会被优先选中
 *
 * 用法：
 *   node tests/wrappers-selftest.mjs            # 跑完自动删临时目录
 *   node tests/wrappers-selftest.mjs --keep     # 保留临时目录（排查用）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 * 本机没装的工具（如 Git 的 sed/perl）会明确标成「跳过」并说明原因，**不算通过**。
 * ============================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  WIN_EXTS,
  extensionOrder,
  deriveMsysRoots,
  mapMsysPath,
  resolveCommand,
} from "../lib/resolve-command.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …\自定义\scripts\tests
const SCRIPTS = path.dirname(HERE); // …\自定义\scripts
const HARNESS = path.dirname(path.dirname(SCRIPTS)); // …\AI-Dev-Harness
const BIN = path.join(path.dirname(SCRIPTS), "bin"); // …\自定义\bin
const LOG_MJS = path.join(BIN, "_log.mjs");

const KEEP = process.argv.includes("--keep");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wrappers-selftest-"));
const APP = path.join(ROOT, "app");

// ──────────────────────────────────────────────────────────── 结果统计

let failures = 0;
let passes = 0;
let skips = 0;
const results = [];
const failedNames = [];

function check(name, cond, detail) {
  if (cond) passes++;
  else {
    failures++;
    failedNames.push(name);
  }
  results.push(`  ${cond ? "✅ 通过" : "❌ 失败"}  ${name}${detail ? `\n         ${detail}` : ""}`);
}

function skip(name, why) {
  skips++;
  results.push(`  ⏭️  跳过  ${name}\n         原因：${why}`);
}

function section(title) {
  if (results.length) console.log(results.splice(0).join("\n"));
  console.log(`\n${"─".repeat(64)}\n【${title}】`);
}

const norm = (s) =>
  String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();

/**
 * 去掉首行"带路径的程序名"前缀再比较。
 * 原因：MSYS 工具（sed/perl）会把 argv[0] 原样打进输出，走 cmd 时是 `sed`，
 * 走包装器时是绝对路径（msys runtime 又转成 `/usr/bin/sed`）。这属于 argv[0] 形态差异，
 * 不是"输出被吞"，所以比较前统一抹掉——抹掉的只是首行的路径前缀，正文一个字不动。
 */
const stripProgPath = (s) => String(s ?? "").replace(/^[^\s]*[\\/](?=\S)/, "");

const oneLine = (s, n = 160) => {
  const v = norm(s).replace(/\n/g, "⏎");
  return v.length > n ? `${v.slice(0, n)}…` : v;
};

// ──────────────────────────────────────────────────────────── 环境构造

/** Git/MSYS 的 bin 目录（本机 PATH 里通常没有 usr\bin，得自己补，模拟 Git Bash 会话）。 */
function msysBinDirs() {
  const out = [];
  for (const r of deriveMsysRoots()) {
    for (const rel of [["usr", "bin"], ["mingw64", "bin"], ["mingw32", "bin"]]) {
      const d = path.join(r, ...rel);
      try {
        if (fs.statSync(d).isDirectory() && !out.includes(d)) out.push(d);
      } catch {
        /* 没有就跳过 */
      }
    }
  }
  return out;
}

const MSYS_BINS = msysBinDirs();
// 注意必须**追加**在 PATH 末尾：实测 MSYS 的 usr\bin 里有一个叫 `cmd` 的脚本，
// 前置它会顶掉 Windows 的 cmd.exe（自检台自己就崩了）。
const COMPAT_PATH = [...String(process.env.PATH ?? "").split(";").filter(Boolean), ...MSYS_BINS].join(";");

/** 造干净 env：所有 PATH 的变体只留一个，并清掉会影响包装器判断的 HARNESS_* 开关。 */
function makeEnv({ pathValue, extra = {}, dropHarnessSwitches = true } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() === "path") continue;
    env[k] = v;
  }
  env.PATH = pathValue;
  if (dropHarnessSwitches) {
    for (const k of Object.keys(env)) {
      if (/^HARNESS_(BYPASS|NO_WRAP|NEED_E2E|ALLOW_SLEEP|SLEEP_LIMIT|WRAP_LOG|PROJECT|SESSION_KEY)$/i.test(k)) delete env[k];
    }
  }
  Object.assign(env, extra);
  return env;
}

function runCmd(cmdline, { env, cwd = ROOT } = {}) {
  const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdline], {
    encoding: "utf8",
    env,
    cwd,
    timeout: 180000,
  });
  return {
    status: typeof r.status === "number" ? r.status : null,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? String(r.error.message) : null,
  };
}

function runNode(args, { env, cwd = ROOT } = {}) {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env, cwd, timeout: 180000 });
  return {
    status: typeof r.status === "number" ? r.status : null,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? String(r.error.message) : null,
  };
}

function readLog(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────── 准备临时项目

fs.mkdirSync(path.join(APP), { recursive: true });
fs.writeFileSync(
  path.join(APP, "package.json"),
  JSON.stringify({ name: "wrappers-selftest-app", private: true, scripts: { test: "node test.cjs" } }, null, 2),
  "utf8"
);
fs.writeFileSync(path.join(APP, "test.cjs"), 'console.log("REAL-TEST-RAN");process.exit(3);\n', "utf8");
// 一个"解释器不存在"的无扩展名脚本（D 段用：包装器必须 127，不许 0）
const BOGUS = path.join(ROOT, `bogus-tool-${Date.now()}`);
fs.writeFileSync(BOGUS, "#!/usr/bin/env not-a-real-interpreter-xyz\n");

// ════════════════════════════════════════════════════════════ A · 解析器单元
section("A · 解析器单元（扩展名优先级 / PATHEXT / skipDirs）");

{
  const dir = path.join(ROOT, "ext-order");
  fs.mkdirSync(dir, { recursive: true });
  const name = "ordertool";
  const mk = (ext) => {
    const p = path.join(dir, name + ext);
    fs.writeFileSync(p, "x");
    return p;
  };
  const opt = { pathValue: dir };

  check("A1 空目录里找不到命令 → null（不猜）", resolveCommand(name, opt) === null);

  const pBare = mk("");
  check("A2 只有无扩展名时，才轮到它（不是首选）", resolveCommand(name, opt) === pBare);

  const pCom = mk(".com");
  check("A3 有 .com 时优先 .com（无扩展名排最后）", resolveCommand(name, opt) === pCom);

  const pBat = mk(".bat");
  check("A4 有 .bat 时优先 .bat", resolveCommand(name, opt) === pBat);

  const pCmd = mk(".cmd");
  check("A5 有 .cmd 时优先 .cmd", resolveCommand(name, opt) === pCmd);

  const pExe = mk(".exe");
  check("A6 ★ 有 .exe 时优先 .exe（P0-1 的核心：无扩展名绝不抢先）", resolveCommand(name, opt) === pExe);

  fs.rmSync(pExe);
  check("A7 删掉 .exe 后落到 .cmd", resolveCommand(name, opt) === pCmd);

  check("A8 扩展名顺序（默认 PATHEXT）", extensionOrder({}).join(",") === ".exe,.cmd,.bat,.com,");

  const custom = extensionOrder({ PATHEXT: ".COM;.CMD" }).join(",");
  check("A9 PATHEXT 里没有的扩展名不参与（.COM;.CMD → .cmd,.com,）", custom === ".cmd,.com,", `实际：${custom}`);

  check("A10 无扩展名永远排最后（PATHEXT 缺省也一样）", extensionOrder({ PATHEXT: "" }).at(-1) === "");

  check("A11 skipDirs 生效：只给 harness 自己的 bin 且要求跳过它时，找不到 npm（防自己调自己）",
    resolveCommand("npm", { pathValue: BIN, skipDirs: [BIN] }) === null,
    `不跳过时解析到：${resolveCommand("npm", { pathValue: BIN })}`);
  check("A12 WIN_EXTS 顺序就是 .exe → .cmd → .bat → .com", WIN_EXTS.join(",") === ".exe,.cmd,.bat,.com");
}

// ════════════════════════════════════════════════════════════ B · MSYS 路径映射
section("B · MSYS 路径映射（P0-2：/usr/bin、/mingw64/bin 要能找到真命令）");

{
  const roots = deriveMsysRoots();
  if (!roots.length) {
    skip("B1–B4 MSYS 映射", "本机没有 Git for Windows / msys64 / cygwin 安装根");
  } else {
    check("B1 推导出 MSYS 安装根", roots.length > 0, `根：${roots.join(" | ")}`);

    const usrBin = mapMsysPath("/usr/bin");
    check("B2 /usr/bin 映射到真实存在的目录", !!usrBin && fs.existsSync(usrBin), `映射结果：${usrBin}`);

    if (usrBin && fs.existsSync(usrBin)) {
      const hasTool = ["sleep.exe", "sed.exe", "sh.exe", "bash.exe"].some((f) => fs.existsSync(path.join(usrBin, f)));
      check("B3 映射出来的目录里确实有 unix 工具", hasTool, `目录：${usrBin}`);
    } else {
      skip("B3 目录内容检查", "/usr/bin 没映射成功");
    }

    const sleepReal = resolveCommand("sleep", { pathValue: "/usr/bin" });
    check("B4 ★ PATH 里只有 MSYS 形式 /usr/bin 时也能找到 sleep（旧实现返回 127）",
      !!sleepReal && fs.existsSync(sleepReal), `解析结果：${sleepReal}`);
  }

  check("B5 老行为不回归：/c/Users → C:\\Users", mapMsysPath("/c/Users") === "C:\\Users",
    `实际：${mapMsysPath("/c/Users")}`);
  check("B6 非 MSYS 路径原样返回", mapMsysPath("C:\\Windows\\System32") === "C:\\Windows\\System32");
  check("B7 ★ 映射不出来返回 null（不臆造路径）", mapMsysPath("/绝对不存在的目录-xyz") === null,
    `实际：${mapMsysPath("/绝对不存在的目录-xyz")}`);
}

// ════════════════════════════════════════════════════════════ C · 对照 vs 包装
section("C · 对照（不包装）vs 包装（PATH 前置 自定义\\bin）");
console.log("  说明：对照与包装是**同一条命令行**，唯一差别是 PATH 有没有前置 harness 的 bin。");

const CASES = [
  {
    id: "C-npm-test",
    tool: "npm",
    cmd: "npm test",
    cwd: APP,
    expect: { exit: 3, contains: "REAL-TEST-RAN" },
  },
  {
    id: "C-npm-version",
    tool: "npm",
    cmd: "npm --version",
    expect: { exit: 0, match: /^\d+\.\d+\.\d+/m },
  },
  {
    id: "C-npx-version",
    tool: "npx",
    cmd: "npx --version",
    expect: { exit: 0, match: /^\d+\.\d+\.\d+/m },
  },
  {
    id: "C-sed-version",
    tool: "sed",
    cmd: "sed --version",
    expect: { exit: 0, match: /GNU sed/i },
  },
  {
    id: "C-perl-inline",
    tool: "perl",
    // 注意：这里**故意不写引号**。实测在这台机器上，命令行里只要出现双引号，
    // MSYS 的 perl/python 会「静默不干活、退出码还是 0」（比失败更危险），
    // 所以自检台一律用无需引号的短程序。
    cmd: "perl -e print(4343)",
    expect: { exit: 0, contains: "4343" },
  },
  {
    id: "C-python-inline",
    tool: "python",
    cmd: "python -c print(4242)",
    expect: { exit: 0, contains: "4242" },
  },
  {
    id: "C-sleep",
    tool: "sleep",
    cmd: "sleep 1",
    expect: { exit: 0, quiet: true },
  },
];

for (const c of CASES) {
  const cwd = c.cwd ?? ROOT;
  const real = resolveCommand(c.tool, { pathValue: COMPAT_PATH, skipDirs: [BIN] });
  if (!real) {
    skip(`${c.id}（${c.tool}）`, `本机 PATH（含 Git/MSYS bin）里没有 ${c.tool}，无法做对照`);
    continue;
  }

  const logFile = path.join(ROOT, "logs", `${c.id.replace(/[^\w.-]/g, "_")}.jsonl`);
  const control = runCmd(c.cmd, { env: makeEnv({ pathValue: COMPAT_PATH }), cwd });
  const wrapped = runCmd(c.cmd, {
    env: makeEnv({
      pathValue: `${BIN};${COMPAT_PATH}`,
      extra: {
        HARNESS_PROJECT: ROOT,
        HARNESS_WRAP_LOG: logFile,
        HARNESS_SESSION_KEY: "wrappers-selftest",
      },
    }),
    cwd,
  });

  const cOut = norm(control.stdout);
  const wOut = norm(wrapped.stdout);

  check(`${c.id} · 对照真的执行了（期望退出码 ${c.expect.exit}）`, control.status === c.expect.exit,
    `实际对照退出码 ${control.status}；输出=${oneLine(cOut) || "(空)"}；stderr=${oneLine(control.stderr)}`);

  if (c.expect.contains) {
    check(`${c.id} · 对照输出里有 ${c.expect.contains}`, cOut.includes(c.expect.contains), `对照输出=${oneLine(cOut)}`);
    check(`${c.id} · ★ 包装后也有 ${c.expect.contains}（输出没被吞）`, wOut.includes(c.expect.contains),
      `包装输出=${oneLine(wOut)}`);
  }
  if (c.expect.match) {
    check(`${c.id} · ★ 包装后输出匹配 ${c.expect.match}`, c.expect.match.test(wOut), `包装输出=${oneLine(wOut)}`);
  }

  check(`${c.id} · ★ 包装后退出码与对照一致`, wrapped.status === control.status,
    `对照=${control.status} 包装=${wrapped.status}；包装 stderr=${oneLine(wrapped.stderr)}`);

  check(`${c.id} · ★ 包装后 stdout 与对照逐字一致（不变形）`,
    stripProgPath(wOut) === stripProgPath(cOut),
    `对照=${oneLine(cOut) || "(空)"}\n         包装=${oneLine(wOut) || "(空)"}`);

  const recs = readLog(logFile).filter((r) => r.tool === c.tool);
  check(`${c.id} · 确实走了包装器（留下审计记录）`, recs.length > 0,
    recs.length
      ? `日志：${logFile}（${recs.length} 条 tool=${c.tool}）`
      : `日志 ${logFile} 里没有 tool=${c.tool} 的记录 —— 说明 PATH 前置没生效，这组断言可能是假绿`);
  if (recs.length) {
    check(`${c.id} · 审计记录里真实命令不是 harness 自己的垫片`, !String(recs.at(-1).real ?? "").toLowerCase().startsWith(BIN.toLowerCase()),
      `实际 real=${recs.at(-1).real}`);
  }
}

// ════════════════════════════════════════════════════════════ D · 防回归（P0-1 的三个具体失败模式）
section("D · 防回归：spawn 失败绝不返回 0");

{
  const missing = `harness-not-exist-${Date.now()}`;
  const r = runNode([LOG_MJS, "--tool", missing, "--", "--version"], { env: makeEnv({ pathValue: COMPAT_PATH }) });
  check("D1 找不到的命令 → 127（不是 0）", r.status === 127, `实际退出码 ${r.status}`);
  check("D2 找不到命令时终端出声（stderr 有说明）", norm(r.stderr).length > 0, `stderr=${oneLine(r.stderr)}`);
  check("D3 ★ 找不到命令时 stdout 没有假装输出", norm(r.stdout) === "", `stdout=${oneLine(r.stdout)}`);
}

{
  const r = runNode([LOG_MJS, "--tool", "bogus", "--real", BOGUS, "--", "run"], {
    env: makeEnv({ pathValue: COMPAT_PATH }),
  });
  check("D4 ★ shebang 解释器不存在且无同名垫片 → 127（旧实现返回 0）", r.status === 127, `实际退出码 ${r.status}`);
  check("D5 且终端出声（stderr 说明为什么没跑起来）", norm(r.stderr).length > 0, `stderr=${oneLine(r.stderr)}`);
}

{
  const sedReal = resolveCommand("sed", { pathValue: COMPAT_PATH, skipDirs: [BIN] });
  if (!sedReal) {
    skip("D6 sed -i 仍被拦", "本机没有 sed");
  } else {
    const f = path.join(ROOT, "deny-target.txt");
    fs.writeFileSync(f, "aaa\n");
    const r = runCmd(`sed -i "s/aaa/bbb/" "${f}"`, {
      env: makeEnv({ pathValue: `${BIN};${COMPAT_PATH}`, extra: { HARNESS_PROJECT: ROOT } }),
    });
    check("D6 sed -i 仍被拦（退出码 1）", r.status === 1, `实际退出码 ${r.status}`);
    check("D7 被拦时文件没被改动（拦得是真的）", fs.readFileSync(f, "utf8").trim() === "aaa",
      `实际内容：${fs.readFileSync(f, "utf8").trim()}`);
    check("D8 拦截原因说给了用户听（stderr 含「拦截」）", /拦截/.test(r.stderr), `stderr=${oneLine(r.stderr)}`);
  }
}

{
  const nodeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(nodeDir, "npm.cmd"))) {
    const got = resolveCommand("npm", { pathValue: nodeDir });
    check("D9 ★ 真实 node 安装目录里，解析到的是 npm.cmd 而不是无扩展名的 npm",
      !!got && /\.(cmd|exe|bat|com)$/i.test(got), `实际：${got}`);
  } else {
    skip("D9 真实 npm 垫片解析", `${nodeDir} 里没有 npm.cmd`);
  }
}

// ════════════════════════════════════════════════════════════ 收尾

if (results.length) console.log(results.splice(0).join("\n"));

if (KEEP) {
  // 保留临时目录时也把路径打出来，方便手工复现
  console.log(`\n  （--keep：临时目录保留在 ${ROOT}）`);
} else {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    console.log(`\n  （临时目录清理失败，可手动删：${ROOT}）`);
  }
}

console.log("\n" + "=".repeat(64));
console.log(`自检结果：${passes} 项通过、${failures} 项失败、${skips} 项跳过`);
if (failures) {
  console.log("\n失败清单：");
  for (const n of failedNames) console.log(`  ✗ ${n}`);
  console.log("\n结论：命令包装器不能保证「放行 = 真的执行」，不要信任何经它跑出来的绿。");
} else {
  console.log("\n结论：包装器放行即真执行，退出码与输出与不包装完全一致。");
}
process.exitCode = failures ? 1 : 0;
