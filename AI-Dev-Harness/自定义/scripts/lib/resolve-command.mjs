#!/usr/bin/env node
/**
 * scripts/lib/resolve-command.mjs —— 统一的「命令 / 引擎」解析器
 * ============================================================
 * 这是第 1 段修的 P0-1 / P0-2 的公共底座，也是第 3 段（P2-5）要复用的**唯一**实现。
 * 以前 _log.mjs / probe-engines.mjs / env-doctor.mjs / engine-probe-selftest.mjs
 * 各写一份解析逻辑，规则不一致 → 探测结果互相打架。
 *
 * 为什么必须统一（都是实测复现过的真实事故）：
 *   1) **扩展名优先级错了**：旧实现按 ["", ".exe", ".cmd", ".bat", ".com"] 找命令，
 *      空扩展名排第一。Windows 上 node 的安装目录里同时有
 *      无扩展名 `npm`（给 Git Bash 用的 `#!/usr/bin/env bash` 脚本）和 `npm.cmd`（Windows 垫片），
 *      于是永远选中前者。
 *   2) **选中 shell 脚本又用 shebang 解释器去 spawn**：`spawnSync("/usr/bin/env", …)`
 *      在 Windows 上必然 ENOENT；调用方再把 status===null 当成 0 →
 *      **命令没跑、退出码还是 0**（假绿，会让所有 npm/npx 验证空跑成功）。
 *   3) **MSYS 路径不转换**：Git Bash 的 `/usr/bin`、`/mingw64/bin` 没映射到真实安装目录，
 *      本来能跑的命令（如 sleep）被判定成"找不到命令"（127）。
 *
 * 本文件的约定（改之前先读这三条）：
 *   · 只做解析：**不写任何文件、不发任何网络请求**；唯一的子进程调用是 cygpath。
 *   · 解析不到就返回 null / 给出 127 的结论 —— **绝不猜、绝不把"没跑起来"当成功**。
 *   · Windows 扩展名优先级：`.exe → .cmd → .bat → .com → 其余 PATHEXT 条目 → 无扩展名（永远最后）`。
 *     注意这是**有意**偏离 PATHEXT 原始顺序的（系统 PATHEXT 里 .COM 在 .EXE 前），
 *     因为 .com 垫片极少见，而 .exe/.cmd 才是真命令；顺序固定后行为才可预测。
 * ============================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Windows 上"可执行的命令垫片"扩展名，按优先级排列。 */
export const WIN_EXTS = [".exe", ".cmd", ".bat", ".com"];

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** 已知的 MSYS / Git for Windows / Cygwin 安装根（PATH 里推不出来时按这些兜底）。 */
const KNOWN_MSYS_ROOTS = [
  "C:\\Program Files\\Git",
  "C:\\Program Files (x86)\\Git",
  "C:\\msys64",
  "C:\\msys32",
  "C:\\cygwin64",
  "C:\\cygwin",
];

/** MSYS 里 `/bin` 是 `/usr/bin` 的别名（mklinks 出来的）。 */
const MSYS_ALIASES = [[/^\/bin(?=\/|$)/, "/usr/bin"]];

/** PATH / msys 映射的进程内缓存（每个包装器进程只活很短，缓存只为一次调用内部复用）。 */
const cache = {
  roots: null,
  mapped: new Map(),
  cygpath: undefined,
};

// ──────────────────────────────────────────────────────────── 小工具

export function normDir(p) {
  try {
    return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  } catch {
    return String(p).toLowerCase();
  }
}

export function sameDir(a, b) {
  if (!a || !b) return false;
  return normDir(a) === normDir(b);
}

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

/**
 * 拆 PATH。
 * **只认绝对路径**：实测本机 PATH 里有被截断的脏条目（`E`、`\Git软件\Git\cmd`），
 * 相对条目会按 cwd 解析，可能撞上 cwd 里的同名文件，比漏找更危险。
 */
export function pathEntries(value = process.env.PATH, platform = process.platform) {
  const sep = platform === "win32" ? ";" : ":";
  const out = [];
  const seen = new Set();
  for (const raw of String(value ?? "").split(sep)) {
    let d = raw.trim().replace(/^"+|"+$/g, "");
    if (!d) continue;
    if (platform === "win32") {
      if (!path.isAbsolute(d)) continue;
      // 注意：以 / 开头的条目（/usr/bin、/c/Users/…）是 MSYS 形式，**不能**转成反斜杠，
      // 否则就丢掉了"这是 MSYS 路径"这个信息，后面的 mapMsysPath 再也认不出来（实测踩过）。
      if (!d.startsWith("/")) d = d.replace(/\//g, "\\");
    }
    const key = platform === "win32" ? d.toLowerCase() : d;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * 解析候选扩展名顺序。Windows：.exe → .cmd → .bat → .com →（其余 PATHEXT）→ 无扩展名。
 * PATHEXT 缺失时用系统默认值；PATHEXT 里没有的四种固定扩展名不会出现。
 */
export function extensionOrder(env = process.env, platform = process.platform) {
  if (platform !== "win32") return [""];
  const declared = String(env.PATHEXT || DEFAULT_PATHEXT)
    .split(";")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.startsWith(".") ? s : `.${s}`));
  const fixed = WIN_EXTS.filter((e) => declared.includes(e));
  const exts = fixed.length ? fixed.slice() : WIN_EXTS.slice();
  for (const e of declared) if (!exts.includes(e)) exts.push(e);
  exts.push(""); // 无扩展名永远是最后一名（它就是 P0-1 的元凶）
  return exts;
}

// ──────────────────────────────────────────────────────────── MSYS 路径映射（P0-2）

/** 推导本机可能的 MSYS / Git 安装根，按可信度排序（PATH 里推出来的优先）。 */
function looksLikeMsysRoot(r) {
  return (
    isDir(path.join(r, "usr", "bin")) ||
    isDir(path.join(r, "mingw64", "bin")) ||
    isDir(path.join(r, "mingw32", "bin")) ||
    isFile(path.join(r, "bin", "bash.exe"))
  );
}

export function deriveMsysRoots({ env = process.env, platform = process.platform } = {}) {
  const roots = [];
  const push = (r, { mustLookReal = true } = {}) => {
    if (!r || platform !== "win32") return;
    const v = String(r).replace(/[\\/]+$/, "");
    if (!v || !path.isAbsolute(v) || !isDir(v)) return;
    if (roots.some((x) => sameDir(x, v))) return;
    // 只看"真的像 MSYS 安装根"的目录：否则 PATH 里任何一个 …\bin 目录都会推出来一个假根
    // （实测会推出 libheif、poppler、VS Code、AndroidDev 这种噪音），把映射搅乱。
    if (mustLookReal && !looksLikeMsysRoot(v)) return;
    roots.push(v);
  };
  if (cache.roots) return cache.roots;
  if (platform !== "win32") {
    cache.roots = roots;
    return roots;
  }
  push(env.GIT_INSTALL_ROOT);
  for (const d of pathEntries(env.PATH, platform)) {
    const leaf = path.basename(d).toLowerCase();
    if (leaf === "bin") push(path.dirname(path.dirname(d))); // …\Git\usr\bin / …\Git\mingw64\bin → …\Git
    else if (leaf === "cmd") push(path.dirname(d)); // …\Git\cmd → …\Git
  }
  for (const r of KNOWN_MSYS_ROOTS) push(r);
  cache.roots = roots;
  return roots;
}

function msysAlias(p) {
  let v = p;
  for (const [re, to] of MSYS_ALIASES) if (re.test(v)) v = v.replace(re, to);
  return v;
}

/** 找 Git for Windows 自带的 cygpath（权威映射），只查安装根，避免和 resolveCommand 递归。 */
function findCygpath(roots) {
  if (cache.cygpath !== undefined) return cache.cygpath;
  let found = null;
  for (const r of roots) {
    for (const rel of [["usr", "bin"], ["bin"]]) {
      const cand = path.join(r, ...rel, "cygpath.exe");
      if (isFile(cand)) {
        found = cand;
        break;
      }
    }
    if (found) break;
  }
  cache.cygpath = found;
  return found;
}

function runCygpath(exe, posix) {
  try {
    const r = spawnSync(exe, ["-w", posix], { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const out = String(r.stdout ?? "")
      .trim()
      .split(/\r?\n/)
      .pop()
      .trim();
    if (out && /^[A-Za-z]:[\\/]/.test(out) && fs.existsSync(out)) return out;
  } catch {
    /* 失败就退回手工映射 */
  }
  return null;
}

/**
 * Git Bash / MSYS 风格的路径 → Windows 真实路径。
 *   /c/Users/x        → C:\Users\x        （老行为，保持不回归）
 *   /usr/bin          → <Git 安装根>\usr\bin
 *   /mingw64/bin      → <Git 安装根>\mingw64\bin
 *   /bin/sleep        → <Git 安装根>\usr\bin\sleep
 * 映射不出来返回 **null**（不猜、不返回臆造的路径）。
 */
export function mapMsysPath(p, { env = process.env, platform = process.platform, roots = null, useCygpath = true } = {}) {
  if (platform !== "win32") return p;
  if (typeof p !== "string" || !p) return p;
  if (!p.startsWith("/")) return p; // 已经是 Windows 形式
  if (p.startsWith("//")) return p; // UNC \\server\share

  const drive = p.match(/^\/([A-Za-z])(?=\/|$)/);
  if (drive && isDir(`${drive[1].toUpperCase()}:\\`)) {
    return `${drive[1].toUpperCase()}:${p.slice(2).replace(/\//g, "\\") || "\\"}`;
  }

  const cached = cache.mapped.get(p);
  if (cached !== undefined) return cached;

  const rs = roots ?? deriveMsysRoots({ env, platform });
  const posix = msysAlias(p);
  let out = null;

  if (useCygpath) {
    const cp = findCygpath(rs);
    if (cp) out = runCygpath(cp, posix);
  }
  if (!out) {
    for (const r of rs) {
      const cand = path.join(r, posix.replace(/\//g, "\\"));
      if (fs.existsSync(cand)) {
        out = cand;
        break;
      }
    }
  }

  cache.mapped.set(p, out);
  return out;
}

// ──────────────────────────────────────────────────────────── 命令解析（P0-1）

function candidatesForPath(raw, env, platform) {
  const isWin = platform === "win32";
  const list = [];
  if (isWin && raw.startsWith("/")) {
    const mapped = mapMsysPath(raw, { env, platform });
    if (mapped) list.push(mapped);
  }
  list.push(raw);
  const exts = isWin && !path.extname(raw) ? extensionOrder(env, platform) : [""];
  const out = [];
  for (const base of list) for (const ext of exts) out.push(base + ext);
  return out;
}

/**
 * 在 PATH 里找真实命令（跳过指定目录，通常是 harness 自己的 bin —— 否则会自己调自己）。
 * 找不到返回 **null**。
 *
 * @param {string} tool        命令名（也接受绝对路径 / 带扩展名）
 * @param {object} [opts]
 * @param {string} [opts.pathValue]  覆盖 PATH（测试用）
 * @param {string[]} [opts.skipDirs] 要跳过的目录
 * @param {boolean} [opts.useMsys]   是否对 MSYS 风格的 PATH 条目做映射（默认 true）
 */
export function resolveCommand(tool, {
  env = process.env,
  platform = process.platform,
  skipDirs = [],
  pathValue = null,
  useMsys = true,
} = {}) {
  if (!tool) return null;
  const isWin = platform === "win32";
  const raw = String(tool);

  if (path.isAbsolute(raw) || raw.includes("/") || raw.includes("\\")) {
    for (const cand of candidatesForPath(raw, env, platform)) {
      if (isFile(cand) && !skipDirs.some((s) => sameDir(s, path.dirname(cand)))) return cand;
    }
    return null;
  }

  const exts = isWin && !path.extname(raw) ? extensionOrder(env, platform) : [""];
  const dirs = pathEntries(pathValue ?? env.PATH, platform);
  for (const entry of dirs) {
    const tryDirs = [];
    let allowRaw = true;
    if (isWin && useMsys && entry.startsWith("/")) {
      const mapped = mapMsysPath(entry, { env, platform });
      if (mapped) tryDirs.push(mapped);
      // 映射不出来就**不**拿原始 MSYS 条目去 join：Windows 会把 "/usr/bin\sleep.exe" 当相对路径，
      // 按 cwd 解析可能撞上碰巧同名的文件（假命中比找不到更危险）。
      allowRaw = !!mapped;
    }
    if (allowRaw) tryDirs.push(entry);
    for (const dir of tryDirs) {
      if (!dir || (isWin && !path.isAbsolute(dir))) continue;
      if (skipDirs.some((s) => sameDir(s, dir))) continue;
      for (const ext of exts) {
        const cand = path.join(dir, raw + ext);
        if (isFile(cand)) return cand;
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────── shebang / 子进程方案

/** 读文件头（判断 shebang 用）。读不到当没有。 */
export function readHead(file, bytes = 256) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * 解析 shebang。
 *   #!/usr/bin/env bash          → { prog: "bash", args: [] }
 *   #!/usr/bin/env -S python -u  → { prog: "python", args: ["-u"] }
 *   #!/bin/sh                    → { prog: "/bin/sh", args: [] }
 * 注意：旧实现把 `/usr/bin/env` 整个当成解释器去 spawn，Windows 上必然 ENOENT（P0-1 的第 2 个缺陷）。
 */
export function parseShebang(head) {
  const first = String(head ?? "").split(/\r?\n/)[0];
  if (!first.startsWith("#!")) return null;
  const rest = first.slice(2).trim();
  if (!rest) return null;
  const parts = rest.split(/\s+/);
  let prog = parts[0];
  let args = parts.slice(1);
  if (/(^|[\\/])env$/i.test(prog)) {
    let i = 0;
    if (args[i] === "-S" || args[i] === "--split-string") i++;
    while (i < args.length && args[i].startsWith("-")) i++;
    prog = args[i] ?? "";
    args = args.slice(i + 1);
  }
  if (!prog) return null;
  return { raw: rest, prog, args };
}

/** C:\Windows\System32\bash.exe 是 WSL 垫片，跑不了 Windows 路径的脚本（实测报 /bin/bash 不存在）。 */
function isWslBashStub(p) {
  const leaf = path.basename(p).toLowerCase();
  if (leaf !== "bash.exe") return false;
  const dir = path.dirname(p).toLowerCase().replace(/[\\/]+$/, "");
  return dir === "c:\\windows\\system32" || dir === "c:\\windows\\sysnative";
}

function interpreterCandidates(sb, { env, platform, roots }) {
  const out = [];
  const push = (v) => {
    if (v && !out.some((x) => sameDir(x, v))) out.push(v);
  };
  const base = path.basename(sb.prog).toLowerCase();
  const bare = base.endsWith(".exe") ? base.slice(0, -4) : base;

  if (platform === "win32") {
    // 真实 Git/MSYS 里的 bash 优先（它认识 Windows 路径的脚本）
    for (const r of roots ?? deriveMsysRoots({ env, platform })) {
      const cand = path.join(r, "usr", "bin", base.endsWith(".exe") ? base : `${base}.exe`);
      if (isFile(cand)) push(cand);
    }
  }
  const direct = resolveCommand(sb.prog, { env, platform, useMsys: false });
  if (direct && !isWslBashStub(direct)) push(direct);
  if (!direct) {
    // PATH 里没有（如 Git 的 usr\bin 不在 PATH 上）：按 MSYS 安装根试一把
    const mapped = mapMsysPath(`/usr/bin/${bare}`, { env, platform, roots });
    if (mapped && !isWslBashStub(mapped)) push(mapped);
  }
  return out;
}

/** 同目录下同名的 Windows 命令垫片（npm → npm.cmd），按 .exe → .cmd → .bat → .com。 */
export function siblingShims(file, env = process.env, platform = process.platform) {
  if (platform !== "win32") return [];
  const dir = path.dirname(file);
  const base = path.basename(file);
  if (path.extname(base)) return [];
  const exts = extensionOrder(env, platform).filter((e) => WIN_EXTS.includes(e));
  const out = [];
  for (const ext of exts) {
    const cand = path.join(dir, base + ext);
    if (isFile(cand)) out.push(cand);
  }
  return out;
}

function shimPlan(file, argv, env) {
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/c", file, ...argv],
    via: "cmd 垫片",
    file,
  };
}

/**
 * 给出"怎么把这个文件跑起来"的方案链（primary + fallbacks）。
 *
 * Windows 上无扩展名的文件的处理顺序（这是 P0-1 的核心修正）：
 *   ① 同目录同名的 .exe/.cmd/.bat/.com 垫片 —— **优先**。这正是 cmd.exe 自己的选择顺序，
 *      也是 node 自带 npm/npx 在 Windows 上的正确跑法（无扩展名那个是给 Git Bash 的）。
 *   ② shebang 解释器（真实 Git/MSYS 安装根里的优先，排除 WSL 垫片；把 shebang 自带参数带上）。
 *   ③ 直接执行该文件（最后兜底；失败就是 127，绝不返回 0）。
 *
 * 只在**进程根本没起来**（spawn 报错）时才走 fallback；已经跑起来（拿到退出码/信号）绝不重试，
 * 否则会重复执行有副作用的命令。
 */
export function planChild(file, argv = [], { env = process.env, platform = process.platform, roots = null } = {}) {
  const plans = [];
  const seen = new Set();
  const add = (plan) => {
    if (!plan || !plan.command) return;
    const key = `${normDir(plan.command)}\u0000${(plan.args ?? []).join("\u0000")}`;
    if (seen.has(key)) return;
    seen.add(key);
    plans.push(plan);
  };

  if (platform !== "win32") {
    add({ command: file, args: argv, via: "直接执行", file });
    return { primary: plans[0] ?? null, fallbacks: plans.slice(1) };
  }

  const ext = path.extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    add(shimPlan(file, argv, env));
  } else if (ext === ".exe" || ext === ".com") {
    add({ command: file, args: argv, via: "直接执行", file });
  } else {
    for (const sib of siblingShims(file, env, platform)) {
      const se = path.extname(sib).toLowerCase();
      if (se === ".cmd" || se === ".bat") add(shimPlan(sib, argv, env));
      else add({ command: sib, args: argv, via: "同名垫片直接执行", file: sib });
    }
    const sb = parseShebang(readHead(file));
    if (sb) {
      for (const interp of interpreterCandidates(sb, { env, platform, roots })) {
        add({ command: interp, args: [...sb.args, file, ...argv], via: `shebang:${sb.raw}`, file });
      }
    }
    add({ command: file, args: argv, via: "直接执行（最后兜底）", file });
  }

  return { primary: plans[0] ?? null, fallbacks: plans.slice(1) };
}

const SIGNALS = os.constants?.signals ?? {};

/**
 * spawnSync 的结果 → 明确的退出码。**绝不把 status===null 当成 0**（P0-1 的第 3 个缺陷）。
 */
export function childExit(r) {
  if (!r) return { exit: 127, reason: "没有拿到子进程结果" };
  if (r.error) {
    const code = r.error.code || r.error.name || "ERROR";
    return { exit: 127, reason: `${code}: ${r.error.message}` };
  }
  if (typeof r.status === "number") return { exit: r.status, reason: null };
  if (r.signal) {
    const n = SIGNALS[r.signal];
    return { exit: 128 + (typeof n === "number" ? n : 0), reason: `被信号 ${r.signal} 终止` };
  }
  return { exit: 127, reason: "子进程既没有退出码也没有信号（说明它没真正跑起来）" };
}

/**
 * 按方案链执行。返回 { result, plan, attempts, failure }。
 * result 为 null 表示**所有方案都没能启动**（调用方必须按失败处理，不能当成功）。
 */
export function runResolved(file, argv = [], {
  env = process.env,
  platform = process.platform,
  timeout = undefined,
  roots = null,
  stdio = "inherit",
} = {}) {
  const { primary, fallbacks } = planChild(file, argv, { env, platform, roots });
  const attempts = [];
  if (!primary) return { result: null, plan: null, attempts, failure: "没有任何可执行的方案" };

  for (const plan of [primary, ...fallbacks]) {
    let r;
    try {
      r = spawnSync(plan.command, plan.args, { stdio, windowsHide: false, env, timeout });
    } catch (err) {
      attempts.push({ ...plan, error: String(err?.message ?? err), status: null, signal: null });
      continue;
    }
    attempts.push({
      ...plan,
      error: r.error ? (r.error.code || r.error.message) : null,
      status: typeof r.status === "number" ? r.status : null,
      signal: r.signal ?? null,
    });
    if (!r.error) return { result: r, plan, attempts, failure: null };
  }
  const last = attempts[attempts.length - 1];
  return { result: null, plan: null, attempts, failure: last?.error ?? "全部方案都没能启动" };
}

export default {
  WIN_EXTS,
  pathEntries,
  extensionOrder,
  deriveMsysRoots,
  mapMsysPath,
  resolveCommand,
  readHead,
  parseShebang,
  siblingShims,
  planChild,
  childExit,
  runResolved,
  sameDir,
  normDir,
};
