#!/usr/bin/env node
/**
 * engine-detect.mjs —— 「这个引擎装了没 / 装在哪 / 能不能自动跑」的唯一实现
 * ============================================================
 * 第 3 段（P2-5）。以前 probe-engines.mjs / env-doctor.mjs / engine-probe-selftest.mjs
 * 各写一份 PATH 扫描，规则还不一致 —— 实测后果就是**引擎明明装了却被探成「本机没有 codex」**：
 *   · 旧实现按 ["", ".exe", ".cmd", ".bat", ".com"] 找命令（空扩展名排第一）→
 *     Windows 上无扩展名的 npm/Git-Bash 脚本会先被命中；
 *   · 自检台用 spawnSync("codex") 直接起进程 → `.cmd` 垫片在 node 下必然 ENOENT；
 *   · 「桌面端算不算装了」根本没有判据。
 *
 * 现在统一到 第 1 段 的 `lib/resolve-command.mjs`（.exe → .cmd → .bat → .com → 无扩展名，
 * 认 PATH/PATHEXT，认 MSYS 路径），并在这里补上三件 resolve-command 不该管的事：
 *   1. **额外安装位置**：PATH 上没有、但确实装了的（原生安装器、npm 全局、WinGet Links…）。
 *   2. **桌面端**：Claude 桌面应用 / Trae IDE 这类没有 CLI 命令的形态（用安装痕迹判定）。
 *   3. **引擎选择记忆**：上次用的引擎落盘到 state（锁定决策 10），供 run.bat 回车沿用。
 *
 * 铁律：本模块**只读**（唯一的写操作是 writeChoice()，写的是 harness 自己的 state），
 *       绝不读用户配置文件，绝不发网络请求。
 *
 * 命令行（给 PowerShell / bash 用，避免它们再写第四份扫描逻辑）：
 *   node engine-detect.mjs --json            # 全部引擎 + 安装状态 + 上次选择（机器可读）
 *   node engine-detect.mjs --list            # 人读列表（run.bat 用）
 *   node engine-detect.mjs --id codex-cli    # 单个引擎的 JSON
 *   node engine-detect.mjs --remember <id>   # 记住本次选择（run.bat 回车沿用）
 * ============================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveCommand, planChild, childExit, deriveMsysRoots } from "./resolve-command.mjs";

// 本文件在 <harness>\自定义\scripts\lib\ 下 → 往上三级才是 AI-Dev-Harness
export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const WORK_ROOT = path.dirname(HARNESS_ROOT);

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

/**
 * 引擎目录。字段含义：
 *   id         引擎 id（与 引擎能力表.json / run.ps1 的 switch 一致）
 *   label      终端里给人看的名字
 *   kind       cli（有命令行，能自动 exec） | desktop（只有图形端，只能给启动词）
 *   commands   命令名（按顺序试）
 *   extraDirs  PATH 上没有时额外找的目录（占位符已展开）
 *   rules      该引擎的规则自动加载方式（写进引擎能力矩阵）
 *   mechanism  该引擎的强制手段（写进引擎能力矩阵）
 */
function expand(p) {
  return path.normalize(String(p)
    .replace(/^~(?=[\\/]|$)/, HOME)
    .replace(/%APPDATA%/gi, APPDATA)
    .replace(/%LOCALAPPDATA%/gi, LOCALAPPDATA)
    .replace(/%USERPROFILE%/gi, HOME));
}

export const ENGINES = [
  {
    id: "codex-cli",
    label: "Codex CLI",
    kind: "cli",
    commands: ["codex"],
    extraDirs: ["%LOCALAPPDATA%/Programs/Codex/bin", "%APPDATA%/npm", "~/.local/bin"],
    rules: ["AGENTS.md"],
    mechanism: "hooks（~/.codex/config.toml 的 [hooks] 段）+ 命令包装 + 启动词",
  },
  {
    id: "claude-code",
    label: "Claude Code（终端）",
    kind: "cli",
    commands: ["claude"],
    extraDirs: [
      "~/.local/bin",
      "%LOCALAPPDATA%/Programs/claude-code",
      "%LOCALAPPDATA%/Programs/claude",
      "%APPDATA%/npm",
      "%LOCALAPPDATA%/Microsoft/WinGet/Links",
      "%LOCALAPPDATA%/pnpm",
    ],
    rules: ["CLAUDE.md", "AGENTS.md"],
    mechanism: "hooks 全套（.claude/settings.json 的 6 个事件）+ 命令包装 + 启动词",
  },
  {
    id: "claude-code-desktop",
    label: "Claude Code（桌面端）",
    kind: "desktop",
    commands: [],
    appPackagePrefix: "Claude",
    // ★ 判据只认**桌面应用自己的安装痕迹**。注意 `~/.claude.json` 不能当判据：
    //   终端 CLI 也会生成它（本机就是这种情形）→ 拿它判桌面端 = 又一个误报。
    desktopMarks: [
      { rel: "%APPDATA%/Claude", why: "Claude 桌面应用数据目录" },
      { rel: "%LOCALAPPDATA%/Claude", why: "Claude 桌面应用本机目录" },
      { rel: "%LOCALAPPDATA%/AnthropicClaude", why: "Claude 桌面应用安装目录" },
    ],
    rules: ["CLAUDE.md", "AGENTS.md"],
    mechanism: "与终端同一套 .claude/ hooks —— **只有在项目目录里开会话才生效**（不向上寻找）",
  },
  {
    id: "deepseek-harness",
    label: "DeepSeek Harness (dsh)",
    kind: "cli",
    commands: ["dsh"],
    extraDirs: ["%APPDATA%/npm", "~/.dsh/bin", "~/.local/bin"],
    rules: ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md"],
    mechanism: "--patch 叠加层 + 命令包装 + 启动词注入（不自动读规则文件时靠启动词）",
  },
  {
    id: "traecode-cli",
    label: "TraeCode CLI",
    kind: "cli",
    commands: ["traecode"],
    extraDirs: ["%APPDATA%/npm", "~/.local/bin"],
    rules: [".trae/rules/"],
    mechanism: "命令包装 + 启动词（CLI 机制层未查明，如实标注）",
  },
  {
    id: "trae-ide",
    label: "Trae IDE（图形端）",
    kind: "desktop",
    commands: ["trae", "trae-cn"],
    appPackagePrefix: "Trae",
    desktopMarks: [
      { rel: "%APPDATA%/Trae", why: "Trae IDE 数据目录" },
      { rel: "%APPDATA%/Trae CN", why: "Trae CN 数据目录" },
      { rel: "~/.trae", why: "Trae 规则目录（.trae/rules 的父级）" },
    ],
    rules: [".trae/rules/"],
    mechanism: "命令包装 + 启动词（IDE 内直接开对话不走 run.bat，机制层不生效）",
  },
];

export const ENGINE_IDS = ENGINES.map((e) => e.id);

const byId = new Map(ENGINES.map((e) => [e.id, e]));
export function engineSpec(id) {
  return byId.get(String(id)) ?? null;
}

// ──────────────────────────────────────────────────────────── 状态目录（锁定决策 4）

/**
 * harness 的状态目录。
 * 优先级：显式参数 → 环境变量 HARNESS_STATE_DIR → 默认 <AI-Dev-Harness>\state。
 * 默认行为不变；设了 HARNESS_STATE_DIR 就整体搬到那里（验收要求：项目目录不受影响）。
 */
export function stateDir(override = null) {
  const explicit = override || process.env.HARNESS_STATE_DIR || "";
  if (explicit) return path.resolve(expand(explicit));
  return path.join(HARNESS_ROOT, "state");
}

export function choiceFile(override = null) {
  return path.join(stateDir(override), "engine-choice.json");
}

/** 读「上次用的引擎」。坏文件/缺失都返回 null（fail-open）。 */
export function readChoice(override = null) {
  try {
    // 去掉 BOM：PowerShell 的 Set-Content -Encoding UTF8（PS 5.1）会写 BOM，
    // 而 JSON.parse 见到 BOM 直接抛 —— 兜底写路径与 node 写路径必须都能读回来。
    const j = JSON.parse(fs.readFileSync(choiceFile(override), "utf8").replace(/^\uFEFF/, ""));
    if (j && typeof j.engine === "string" && j.engine) {
      return { engine: j.engine, at: j.at ?? null, file: choiceFile(override) };
    }
  } catch {
    /* 首次运行 / 文件损坏 */
  }
  return null;
}

/** 记住本次选择（run.bat 下次回车沿用它）。写失败只出声，不影响启动。 */
export function writeChoice(engineId, override = null) {
  const file = choiceFile(override);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ engine: String(engineId), at: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    );
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file, error: String(err?.message ?? err) };
  }
}

// ──────────────────────────────────────────────────────────── 安装探测

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 在额外目录里按统一解析器的扩展名顺序找命令（不碰 PATH 之外的东西）。 */
function findInExtraDirs(spec, { env = process.env, platform = process.platform } = {}) {
  const exts = platform === "win32"
    ? [".exe", ".cmd", ".bat", ".com", ""]
    : [""];
  for (const rawDir of spec.extraDirs ?? []) {
    const dir = expand(rawDir);
    if (!isDir(dir)) continue;
    for (const cmd of spec.commands ?? []) {
      for (const ext of exts) {
        const cand = path.join(dir, cmd + ext);
        if (isFile(cand)) return cand;
      }
    }
  }
  return null;
}

/**
 * 桌面端安装痕迹。返回 { present, id, version, evidence } —— 判据是**安装痕迹**，不是进程活着。
 * version 从 WindowsApps 包目录名里抽（`Claude_1.24012.1.0_x64__xxx` → 1.24012.1.0）。
 */
function detectDesktop(spec, { env = process.env } = {}) {
  // 先看 Windows 商店包（能顺便拿到版本号），再看安装痕迹
  const pkg = scanAppPackages(spec);
  if (pkg.present) return pkg;
  for (const mark of spec.desktopMarks ?? []) {
    const p = expand(mark.rel);
    if (isDir(p) || isFile(p)) {
      return { present: true, via: mark.why, path: p, version: null, evidence: mark.rel };
    }
  }
  return { present: false, via: null, path: null, version: null, evidence: null };
}

/** Windows 商店应用：C:\Program Files\WindowsApps\<Name>_<version>_<arch>__<publisher> */
function scanAppPackages(spec) {
  const empty = { present: false, via: null, path: null, version: null, evidence: null };
  if (!spec.appPackagePrefix) return empty;
  if (process.platform === "win32") {
    const root = process.env.ProgramW6432 || "C:\\Program Files";
    const apps = path.join(root, "WindowsApps");
    let names = [];
    try { names = fs.readdirSync(apps); } catch { names = []; }
    const re = new RegExp(`^(${String(spec.appPackagePrefix ?? "__never__")})_(\\d[\\w.]*)_`, "i");
    for (const n of names) {
      const m = re.exec(n);
      if (m) return { present: true, via: `WindowsApps 包 ${n}`, path: path.join(apps, n), version: m[2], evidence: n };
    }
  }
  return empty;
}

/**
 * 探测一个引擎。
 * @returns {{id,label,kind,installed,path,via,version,evidence,spec}}
 */
export function detectEngine(id, { env = process.env, platform = process.platform } = {}) {
  const spec = byId.get(String(id));
  if (!spec) return { id: String(id), label: String(id), kind: "unknown", installed: false, path: null, via: null, version: null, evidence: null, spec: null };

  let bin = null;
  let via = null;
  for (const cmd of spec.commands ?? []) {
    const found = resolveCommand(cmd, { env, platform });
    if (found) { bin = found; via = `PATH 上的 ${cmd}`; break; }
  }
  if (!bin) {
    const extra = findInExtraDirs(spec, { env, platform });
    if (extra) { bin = extra; via = "额外安装位置（不在 PATH 上）"; }
  }

  let desktop = { present: false, via: null, path: null, version: null, evidence: null };
  if (spec.desktopMarks || spec.appPackagePrefix) desktop = detectDesktop(spec, { env });

  const installed = Boolean(bin) || desktop.present;
  // ★ kind 以**引擎自己的形态**为准：Trae 的 `trae.cmd` 是 IDE 启动器，解析得到它
  //   也不能说明有「能 exec 一条 prompt」的 CLI —— 否则 run.bat 会拿着启动器当 CLI 用。
  const kind = spec.kind === "desktop" ? "desktop" : bin ? "cli" : desktop.present ? "desktop" : spec.kind;
  return {
    id: spec.id,
    label: spec.label,
    kind,
    installed,
    path: bin ?? desktop.path ?? null,
    via: bin ? via : desktop.via,
    version: desktop.version ?? null,
    evidence: desktop.evidence ?? null,
    spec,
  };
}

/** 全部引擎的探测结果（含未安装的 —— 调用方自己筛）。 */
export function detectAll(opts = {}) {
  return ENGINES.map((spec) => detectEngine(spec.id, opts));
}

/** 只挑装了的。 */
export function availableEngines(opts = {}) {
  return detectAll(opts).filter((d) => d.installed);
}

/**
 * 找一台**真能跑 Windows 路径脚本**的 bash（harness 侧）。
 *
 * Windows 自带的 C:\Windows\System32\bash.exe 是 WSL 垫片：用它跑
 * `bash -c '<含 Windows 路径的命令>'` 会直接报「无法访问 Bash/Service/CreateInstance/E_ACCESSDENIED」
 * 或 /bin/bash 不存在（实测）。而「找不到真 bash 就放弃包装」正是 G10 的守卫要求（P2-2）。
 *
 * 与 .claude\hooks\lib\policy.mjs 的 bashCommand() 是**同一套判定规则**：
 * 那边必须是项目侧自包含实现（hooks 会被复制进项目，不能依赖 harness 相对路径），
 * 所以规则各写一份但保持一致；HARNESS_BASH 两处都认、HARNESS_BASH=none 两处都能强制关闭。
 */
export function bashCommand({ env = process.env, platform = process.platform } = {}) {
  if (/^(none|off|0)$/i.test(String(env.HARNESS_BASH || "").trim())) return null;
  const looksWslStub = (p) => {
    const leaf = path.basename(p).toLowerCase();
    if (leaf !== "bash.exe") return false;
    const dir = path.dirname(p).toLowerCase().replace(/[\\/]+$/, "");
    return dir === "c:\\windows\\system32" || dir === "c:\\windows\\sysnative" || dir === "c:\\windows\\wsl";
  };
  const explicit = String(env.HARNESS_BASH || "").trim();
  if (explicit && isFile(explicit)) return explicit;

  const fromPath = resolveCommand("bash", { env, platform });
  if (fromPath && !looksWslStub(fromPath)) return fromPath;

  // 顺序有讲究：Git for Windows 优先（Claude Code / 本 harness 的文档都以它为准），
  // 再是 PATH 推出来的 MSYS 根，最后才是其它已知安装根。
  const roots = [
    "C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git",
    ...deriveMsysRoots({ env, platform }),
    "C:\\msys64", "C:\\cygwin64",
  ];
  for (const r of roots) {
    for (const rel of [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]]) {
      const cand = path.join(r, ...rel);
      if (isFile(cand)) return cand;
    }
  }
  return null;
}

/**
 * 给 run.bat / run.ps1 / run.sh 用的选择清单：
 *   可用引擎（装了且能选）+ 上次选择 + 默认项（上次选择仍然可用则沿用，否则第一个可用）。
 */
export function engineChoiceList(opts = {}) {
  const { stateDirOverride = null, ...rest } = opts;
  const all = detectAll(rest);
  const available = all.filter((d) => d.installed);
  const last = readChoice(stateDirOverride);
  const lastUsable = last && available.some((d) => d.id === last.engine) ? last.engine : null;
  return {
    available: available.map(({ spec, ...d }) => ({ ...d, rules: spec.rules, mechanism: spec.mechanism })),
    unavailable: all.filter((d) => !d.installed).map(({ spec, ...d }) => ({ ...d, rules: spec.rules, mechanism: spec.mechanism })),
    last: last ? last.engine : null,
    lastUsable,
    default: lastUsable ?? available[0]?.id ?? null,
    stateDir: stateDir(stateDirOverride),
    choiceFile: choiceFile(stateDirOverride),
  };
}

// ──────────────────────────────────────────────────────────── 跑一条只读命令（版本探测等）

/** 从输出里抽 semver。 */
export function semver(out) {
  const m = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(String(out ?? ""));
  return m ? m[1] : null;
}

/**
 * 用统一解析器跑一条命令并抓输出。
 * ★ 与旧实现的区别：不再用 `shell: true` 拼字符串，也不再 spawnSync("claude") 直接起（.cmd 垫片必 ENOENT）；
 *   而是先解析出真实文件，再按 planChild 的方案链执行（.cmd → cmd /c、无扩展名 → 同名垫片）。
 *   跑不起来时 code = -1 且 error 写明原因 —— **绝不把「没跑起来」当成成功**。
 */
export function runCaptured(argv, {
  env = process.env,
  platform = process.platform,
  cwd = HARNESS_ROOT,
  timeoutMs = 30000,
  maxBuffer = 16 * 1024 * 1024,
  windowsHide = true,
} = {}) {
  const [tool, ...rest] = argv;
  const cmdLine = argv.map((s) => (/[\s"&|<>^()]/.test(String(s)) ? `"${String(s).replace(/"/g, "")}"` : String(s))).join(" ");
  let file = null;
  if (tool && (path.isAbsolute(tool) || tool.includes("/") || tool.includes("\\"))) file = tool;
  else {
    file = resolveCommand(tool, { env, platform });
    if (!file) {
      for (const spec of ENGINES) {
        if ((spec.commands ?? []).includes(tool)) { file = findInExtraDirs(spec, { env, platform }); break; }
      }
    }
  }
  if (!file || !isFile(file)) {
    return { cmd: cmdLine, code: -1, out: "", stdout: "", stderr: "", error: `找不到命令：${tool}`, via: null, file: null };
  }

  const { primary, fallbacks } = planChild(file, rest, { env, platform });
  const plans = [primary, ...fallbacks].filter(Boolean);
  let lastError = null;
  for (const plan of plans) {
    let r;
    try {
      r = spawnSync(plan.command, plan.args, {
        cwd, env, timeout: timeoutMs, maxBuffer, windowsHide,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      lastError = String(err?.message ?? err);
      continue;
    }
    if (r.error) { lastError = `${r.error.code || r.error.name}: ${r.error.message}`; continue; }
    const { exit, reason } = childExit(r);
    return {
      cmd: cmdLine,
      code: exit,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      error: reason,
      via: plan.via ?? null,
      file,
    };
  }
  return { cmd: cmdLine, code: -1, out: "", stdout: "", stderr: "", error: lastError ?? "所有方案都没能启动", via: null, file };
}

/** 拿引擎自己报的版本号（不装则 null）。 */
export function versionOf(id, opts = {}) {
  const det = detectEngine(id, opts);
  if (!det.installed) return null;
  if (!det.path || det.kind === "desktop") return det.version ?? null;
  const r = runCaptured([det.path, "--version"], { timeoutMs: 20000, ...opts });
  return semver(r.out) ?? det.version ?? null;
}

// ──────────────────────────────────────────────────────────── 命令行

function printList(choice) {
  const out = [];
  choice.available.forEach((d, i) => {
    const mark = d.id === choice.lastUsable ? "（上次用的）" : "";
    out.push(`  ${i + 1}) ${d.label}  [${d.id}]${mark}`);
    out.push(`     ${d.path ?? "?"}`);
  });
  if (!choice.available.length) out.push("  （本机没有检测到任何可用引擎）");
  if (choice.unavailable.length) {
    out.push(`  未安装（探过，确实没有）：${choice.unavailable.map((d) => d.id).join(" / ")}`);
  }
  return out.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "用法：node engine-detect.mjs [--json | --list | --id <引擎id> | --remember <引擎id>]\n" +
        "  --json             全部引擎 + 上次选择（机器可读）\n" +
        "  --list             人读列表（run.bat 用）\n" +
        "  --ids              每行一个可用引擎 id（run.sh 用）\n" +
        "  --pick             只输出这次该用哪个引擎（回车沿用上次选择）\n" +
        "  --id <id>          单个引擎\n" +
        "  --remember <id>    记住本次选择（写入 HARNESS_STATE_DIR 或 <harness>/state）\n",
    );
    return 0;
  }

  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };

  if (argv.includes("--remember")) {
    const id = valueOf("--remember");
    if (!id) { process.stderr.write("[engine-detect] --remember 后面要跟引擎 id\n"); return 2; }
    const r = writeChoice(id);
    process.stdout.write(r.ok ? `已记住本次选择：${id} → ${r.file}\n` : `[engine-detect] 写入失败（不影响启动）：${r.error}\n`);
    return r.ok ? 0 : 1;
  }

  if (argv.includes("--id")) {
    const id = valueOf("--id");
    const { spec, ...det } = detectEngine(id);
    process.stdout.write(JSON.stringify({ ...det, rules: spec?.rules ?? null, mechanism: spec?.mechanism ?? null }, null, 2) + "\n");
    return det.installed ? 0 : 1;
  }

  const choice = engineChoiceList();
  // --ids：每行一个可用引擎 id（bash 侧要数组接，不想解析 JSON）
  if (argv.includes("--ids")) {
    process.stdout.write(choice.available.map((d) => d.id).join("\n") + (choice.available.length ? "\n" : ""));
    return choice.available.length ? 0 : 1;
  }
  // --pick：只输出「这次该用哪个引擎」的 id（上次选择仍可用 → 沿用；否则第一个可用）
  if (argv.includes("--pick")) {
    process.stdout.write((choice.default ?? "unsupported") + "\n");
    return choice.default ? 0 : 1;
  }
  if (argv.includes("--list")) {
    process.stdout.write(printList(choice) + "\n");
    return choice.available.length ? 0 : 1;
  }
  process.stdout.write(JSON.stringify(choice, null, 2) + "\n");
  return 0;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`[engine-detect] 出错：${err?.message ?? err}\n`);
    process.exitCode = 2;
  }
}

export default {
  ENGINES,
  ENGINE_IDS,
  HARNESS_ROOT,
  WORK_ROOT,
  engineSpec,
  stateDir,
  choiceFile,
  readChoice,
  writeChoice,
  detectEngine,
  detectAll,
  availableEngines,
  bashCommand,
  engineChoiceList,
  runCaptured,
  versionOf,
  semver,
};
