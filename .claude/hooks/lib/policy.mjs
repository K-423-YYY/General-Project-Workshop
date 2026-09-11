/**
 * policy.mjs —— 所有 harness hook 共享的策略层
 * 第 2 批 · 机制层（核心）
 *
 * 职责：
 *   1. 规则表（G1–G8）的匹配逻辑
 *   2. 配额读写（.claude/state/quota.json）
 *   3. 逃生阀判断（.harness/bypass 或 HARNESS_BYPASS=1）
 *   4. 模型画像 / 严格度判定（strict | standard）
 *   5. 输出截断工具函数（供第 3 批 shape-output 复用）
 *
 * 设计铁律（见 Harness整改包/02-改进方案/03-技术要点与陷阱.md）：
 *   - 所有 hook 只走 stdin JSON，不依赖当前工作目录
 *   - 任何异常都必须 fail-open（exit 0 放行），绝不因为 hook 崩了把用户锁死
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────── 常量

export const LIMITS = {
  e2ePerSession: 2,        // G4：全量 E2E「成功」次数上限（失败不计数）
  ciPerSession: 3,         // G5：全量 CI 上限
  sleepSeconds: 30,        // G6：sleep ≥ 30 秒一律拦（应改用 run_in_background）
  bigFileLines: 400,       // G7：超过这个行数算「大文件」
  editRepeat: 8,           // G8：同一文件第 8 次编辑起警告
  outputShapeBytes: 8192,  // G10：Bash 输出超过这个大小就整形
  // Claude Code 硬限制（二进制核实：permissionDecisionReason 2000 / additionalContext 8000 / systemMessage 4000）
  maxReasonChars: 2000,
  maxContextChars: 8000,
  maxOutputShapeChars: 40000,
};

/** 源码 / 配置类扩展名：shell 重定向写这些一律拦（G2） */
export const SRC_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|markdown|css|scss|less|html|htm|vue|svelte|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift|sh|bash|zsh|ps1|bat|cmd|yml|yaml|toml|ini|sql)$/i;

export const E2E_RE = /\bplaywright\b/i;
export const L1_RE = /\b(vitest|jest|mocha|pytest|rspec)\b|\bnpm\s+run\s+(?:test:unit|unit|l1)\b/i;
export const CI_RE = /\bnpm\s+(?:run\s+)?(?:ci|test)\b/i;
export const PY_INLINE_RE = /\bpython[0-9.]*\s*(?:-c\b|-\s*<{1,2}|<{1,2}\s*['"]?[A-Za-z_])/i;
export const PY_WRITE_RE =
  /open\s*\([^)]*['"][wa]\+?['"]|writeFile|write_text|writelines|\.write\s*\(|to_csv|to_json|\.replace\s*\(|shutil\.(?:copy|move|rmtree)|os\.(?:remove|rename|unlink|makedirs)|Path\s*\([^)]*\)\s*\.\s*write/i;
export const SED_INPLACE_RE = /\bsed\b[^\n]*\s(?:-[A-Za-z]*i[A-Za-z]*\b|--in-place\b)/i;
export const PERL_INPLACE_RE = /\bperl\b[^\n]*\s-[A-Za-z]*i[A-Za-z]*\b/i;

// ─────────────────────────────────────────────────────────── stdin

/** 读完 stdin 并解析为事件对象；空输入或坏 JSON 返回 null */
export async function readEvent() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 会话工作目录（项目根）。hook 的 cwd 由 Claude Code 传进来，不依赖进程 cwd */
export function projectRoot(ev) {
  return (ev && ev.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// ─────────────────────────────────────────────────────────── 逃生阀

/**
 * 逃生阀：命中即全部放行。
 *   1. 环境变量 HARNESS_BYPASS=1
 *   2. 项目根存在 .harness/bypass 文件
 * 返回命中原因字符串，未命中返回 null。
 */
export function bypassReason(ev) {
  if (process.env.HARNESS_BYPASS === "1") return "环境变量 HARNESS_BYPASS=1";
  const root = projectRoot(ev);
  const p = path.join(root, ".harness", "bypass");
  try {
    if (fs.existsSync(p)) return p;
  } catch {
    /* 读不到就当没命中 */
  }
  return null;
}

// ─────────────────────────────────────────────────────────── 配额状态

/**
 * ★ 第 3 段 · 锁定决策 4：HARNESS_STATE_DIR
 *
 * 这是「状态文件临时落点」开关。**不设时行为与以前完全一样**（都写在项目内 `.claude/state/`）。
 * 设了就整体搬走 —— 让「跑一次验证」不再往项目目录里留任何运行态文件（验收要用）。
 *
 * 为什么每个项目还要再分一个子目录：一个进程里可能先后处理多个项目（自检台就是这么干的），
 * 共用一个 quota.json 会让配额互相串味。用项目绝对路径的哈希做 key，长度固定、无非法字符。
 */
export function stateDirFor(root) {
  const override = String(process.env.HARNESS_STATE_DIR || "").trim();
  if (override) {
    let abs = root;
    try { abs = path.resolve(String(root ?? ".")); } catch { abs = String(root ?? "."); }
    const key = crypto.createHash("sha1").update(abs.toLowerCase()).digest("hex").slice(0, 12);
    return path.join(path.resolve(override), "project-state", key);
  }
  return path.join(root, ".claude", "state");
}

/** harness 自身的目录（默认 <项目/工作区根>\AI-Dev-Harness；HARNESS_ROOT 可覆盖）。 */
export function harnessRootFor(root) {
  const override = String(process.env.HARNESS_ROOT || "").trim();
  if (override) return path.resolve(override);
  return path.join(root, "AI-Dev-Harness");
}

/** harness 状态目录（模型画像等）：HARNESS_STATE_DIR 优先，否则 <harness>\state。 */
export function harnessStateDirFor(root) {
  const override = String(process.env.HARNESS_STATE_DIR || "").trim();
  if (override) return path.resolve(override);
  return path.join(harnessRootFor(root), "state");
}

export function stateFile(root) {
  return path.join(stateDirFor(root), "quota.json");
}

export function loadState(root) {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    if (j && typeof j === "object" && j.sessions && typeof j.sessions === "object") return j;
  } catch {
    /* 首次运行 / 文件损坏 → 全新状态 */
  }
  return { version: 1, sessions: {} };
}

/** 原子写：先写临时文件再 rename，避免多个 hook 并发写坏 JSON */
export function saveState(root, st) {
  // 只保留最近 20 个会话，避免文件无限增长
  const keys = Object.keys(st.sessions);
  if (keys.length > 20) {
    keys.sort((a, b) => (st.sessions[a]?.updatedAt || 0) - (st.sessions[b]?.updatedAt || 0));
    for (const k of keys.slice(0, keys.length - 20)) delete st.sessions[k];
  }
  writeJsonAtomic(stateFile(root), st);
}

/** 取（或初始化）本会话的状态块 */
export function sessionState(ev, st) {
  const key = (ev && (ev.session_id || ev.sessionId)) || "unknown-session";
  let s = st.sessions[key];
  if (!s || typeof s !== "object") {
    s = { startedAt: Date.now() };
    st.sessions[key] = s;
  }
  // 向后兼容：补齐缺失字段（老版本状态文件 / 手工清过）
  s.updatedAt ??= Date.now();
  s.e2e ??= { ok: 0, blocked: 0 };
  s.ci ??= { ok: 0, blocked: 0 };
  s.pending ??= {};
  s.l1 ??= { sinceEdit: 0 };
  s.reads ??= {};
  s.edits ??= {};
  s.updatedAt = Date.now();
  return s;
}

/** 命令指纹：PostToolUse 里未必有 tool_use_id，用命令内容当 key 更稳 */
export function cmdKey(cmd) {
  let h = 5381;
  const s = String(cmd || "");
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `h${h.toString(36)}`;
}

// ─────────────────────────────────────────────────────────── 真实 bash 探测（G10 的 shell 守卫）

/**
 * ★ 第 3 段 · P2-2：G10 改写出来的命令是 **bash 语法**（`{ … ; } > log 2>&1; exit $?`）。
 *   如果这台机器根本没有可用的 bash（或只有 WSL 垫片），那条命令必然跑不通 ——
 *   与其产出一条注定失败的命令，不如**放弃包装**（退化成不干预，命令原样执行）。
 *
 * 为什么不能直接 spawnSync("bash")：Windows 上 C:\Windows\System32\bash.exe 是 WSL 垫片，
 * 用它跑 `bash -c '<含 Windows 路径的命令>'` 会报 /bin/bash 不存在（实测）。
 * 判定规则与 harness 侧的统一解析器（自定义\scripts\lib\resolve-command.mjs）保持一致：
 * 先 PATH，再常见 Git/MSYS 安装根；跳过 WSL 垫片。可用 HARNESS_BASH 显式指定。
 */
let _bashCache;
export function bashCommand() {
  if (_bashCache !== undefined) return _bashCache;
  // HARNESS_BASH=none/off：明确声明「本机没有可用 bash」。
  // 用途有两个：① 自检台要断言「非 bash 环境下 G10 放弃包装」这条分支（否则在装了 Git 的机器上永远走不到）；
  //              ② 极端环境下愿意用不干预的方式跑（比 HARNESS_NO_REWRITE=1 更贴近「这台机器没有 bash」的事实）。
  if (/^(none|off|0)$/i.test(String(process.env.HARNESS_BASH || "").trim())) { _bashCache = null; return null; }
  const isFileLocal = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const isWslStub = (p) => {
    const leaf = path.basename(p).toLowerCase();
    if (leaf !== "bash.exe") return false;
    const dir = path.dirname(p).toLowerCase().replace(/[\\/]+$/, "");
    return dir === "c:\\windows\\system32" || dir === "c:\\windows\\sysnative" || dir === "c:\\windows\\wsl";
  };
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  const cands = [];
  const push = (p) => { if (p && !cands.some((x) => same(x, p))) cands.push(p); };
  if (process.env.HARNESS_BASH) push(process.env.HARNESS_BASH);
  for (const d of String(process.env.PATH ?? "").split(path.delimiter)) {
    const dir = d.trim().replace(/^"+|"+$/g, "");
    if (!dir) continue;
    push(path.join(dir, "bash.exe"));
    push(path.join(dir, "bash"));
  }
  // Git for Windows 优先（Claude Code 与本 harness 的文档都以它为准），再是 MSYS2 / Cygwin
  const roots = ["C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git", "C:\\msys64", "C:\\cygwin64"];
  for (const r of roots) {
    push(path.join(r, "bin", "bash.exe"));
    push(path.join(r, "usr", "bin", "bash.exe"));
  }

  for (const c of cands) {
    if (isWslStub(c)) continue;
    if (isFileLocal(c)) { _bashCache = c; return c; }
  }
  _bashCache = null;
  return null;
}

/** 这台机器有没有可用的 bash（G10 用它决定「包装 or 放弃」）。 */
export function hasBash() {
  return Boolean(bashCommand());
}

// ─────────────────────────────────────────────────────────── 严格度

/**
 * strict  → G3（Python 内联改码）直接 deny（决策 2）
 * standard → G3 降级为 warn
 * 未知模型一律 strict（与「未知模型一律保守」一致）。
 */
export function hookStrictness(root) {
  const env = String(process.env.HARNESS_STRICTNESS || "").toLowerCase();
  if (env === "strict" || env === "standard") return env;

  // 恰好只有一个能力画像时用它 —— hook 的 stdin 里没有模型名，多画像无法判断当前是哪个
  try {
    const dir = path.join(harnessStateDirFor(root), "model-profiles");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 1) {
      const p = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
      if (p.hookStrictness === "strict" || p.hookStrictness === "standard") return p.hookStrictness;
    }
  } catch {
    /* 目录不存在 → 回落静态表 */
  }

  try {
    const t = JSON.parse(
      fs.readFileSync(path.join(harnessRootFor(root), "自定义", "模型能力表.json"), "utf8"),
    );
    const v = t?.conservative?.hookStrictness ?? t?.defaults?.hookStrictness;
    if (v === "strict" || v === "standard") return v;
  } catch {
    /* 表读不到 → strict */
  }
  return "strict";
}

// ─────────────────────────────────────────────────────────── 输出构造

export function clip(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const dropped = s.length - max + 24;
  return `${s.slice(0, max - 24)}…[已截断 ${dropped} 字符]`;
}

/**
 * 构造 deny 决定。
 * ★ 铁律 1：必须带 hookSpecificOutput.hookEventName，否则静默失效。
 * ★ deny 消息必须「教学」：拦了什么 / 为什么 / 怎么做 / 怎么解除 —— 四段缺一不可。
 */
export function deny(reason, why, howTo) {
  const msg = [
    `[harness] 已拦截：${reason}`,
    `为什么：${why}`,
    `怎么做：${howTo}`,
    "怎么解除（确实需要时）：在项目根创建 .harness/bypass 文件，或让本次会话带上环境变量 HARNESS_BYPASS=1。",
    "（逃生阀是记录在案的：用了它就是自己承担，事后可查 .claude/state/quota.json）",
  ].join("\n");
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny", // ★ 铁律 3：用 deny，不用 ask（headless 下 ask 等于拒绝）
      permissionDecisionReason: clip(msg, LIMITS.maxReasonChars),
    },
  };
}

/** 只警告、不打断：additionalContext 注入模型上下文（不设 permissionDecision，走正常权限流程） */
export function warn(text) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: clip(`[harness] ${text}`, LIMITS.maxContextChars),
    },
  };
}

/** 把决定写进 stdout。传 null / undefined 表示「不干预」 */
export function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
}

// ─────────────────────────────────────────────────────────── 规则工具函数

/**
 * 剥掉 fd 重定向（2>&1 / &> / 1>&2），再取出所有 shell 重定向的目标路径。
 * 用于 G2；同时也能识别 heredoc 写法 `cat > src/a.ts <<EOF`。
 */
export function redirectTargets(cmd) {
  const cleaned = String(cmd || "")
    .replace(/\d?>>?\s*&\s*\d/g, " ") // 2>&1 / 1>&2
    .replace(/&>>?/g, " ");           // &> / &>>
  const out = [];
  const re = /(?:^|[\s;&|()])(>>?)\s*("([^"]*)"|'([^']*)'|([^\s;&|()<>]+))/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const t = m[3] ?? m[4] ?? m[5];
    if (t) out.push(t);
  }
  return out;
}

/** G6：解析 sleep 的秒数；解析不出或不是 sleep 返回 null */
export function parseSleepSeconds(cmd) {
  const m = String(cmd || "").match(/\bsleep\s+([0-9]+(?:\.[0-9]+)?)\s*([smhd]?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "s").toLowerCase();
  const mul = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mul;
}

/**
 * G5 只针对「全量 CI」。
 * `npx vitest run src/foo.spec.ts`（L1 定向单测）必须放行 —— 那是方案鼓励的做法。
 */
export function isFullCI(cmd) {
  const s = String(cmd || "");
  if (!CI_RE.test(s)) return false;
  if (s.includes("--")) return false; // 带参数的一律当定向测试放行
  if (/\.(?:spec|test)\.[cm]?[jt]sx?\b/i.test(s)) return false; // 指定了测试文件
  return true;
}

/** 数文件行数（最多扫 8 MB，超大文件只给近似值，避免 hook 卡住） */
export function countLines(file, capBytes = 8 * 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return { lines: 0, bytes: st.size, truncated: false };
    const limit = Math.min(capBytes, st.size);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(limit);
      let read = 0;
      let lines = 0;
      while (read < limit) {
        const n = fs.readSync(fd, buf, read, limit - read, read);
        if (n <= 0) break;
        for (let i = read; i < read + n; i++) if (buf[i] === 10) lines++;
        read += n;
      }
      // 文件最后一行没有换行符时补一行
      if (read >= st.size && buf[read - 1] !== 10) lines += 1;
      return { lines, bytes: st.size, truncated: st.size > limit };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────── 输出整形（G10 工具函数，第 3 批接入）

/**
 * 把超长输出整形为「失败项 + 末尾 N 行」。
 * ★ 方案硬要求：必须保留失败项，不能只保留末尾。
 */
export function shapeOutput(text, { maxBytes = LIMITS.outputShapeBytes, tailLines = 40, maxFailures = 30 } = {}) {
  const s = String(text ?? "");
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return null;
  const lines = s.split("\n");
  const failRe = FAIL_RE;
  const failures = lines.filter((l) => failRe.test(l)).slice(0, maxFailures);
  const tail = lines.slice(-tailLines);
  return {
    totalLines: lines.length,
    failures,
    tail,
    summary:
      `[harness] 输出已整形：原始 ${lines.length} 行 → ${failures.length + tail.length} 行\n` +
      `--- 失败项（${failures.length} 条，优先看这里）---\n${failures.join("\n")}\n` +
      `--- 末尾 ${tail.length} 行 ---\n${tail.join("\n")}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 第 3 批 · 上下文治理共享工具
// 由 shape-output / on-stop / inject-rules / statusline / compact-instructions 复用。
// ═══════════════════════════════════════════════════════════════════════

/** 失败行特征（shapeOutput 与 verify-gate 共用同一条，避免两处判定不一致） */
export const FAIL_RE = /\bFAIL|ERROR|✗|✘|failed|Error:|Exception|Traceback|panic:|assert\b/i;

/**
 * 把工具响应（字符串 / {stdout,stderr} / content 数组）统一成纯文本。
 *
 * ★ `PostToolUseFailure` **没有 `tool_response`**，输出以字符串塞在 `error` 里，
 *   形如 `"Exit code 1\n<stdout>…"`（本批实测）。所以这里兜底读 `error`，
 *   免得每个消费方都自己判一次事件类型。
 */
export function toolResponseText(ev) {
  const r = ev?.tool_response;
  if (r == null) {
    if (typeof ev?.error === "string") return ev.error.replace(/^Exit code -?\d+\r?\n/, "");
    return "";
  }
  if (typeof r === "string") return r;
  if (typeof r === "string") return r;
  if (Array.isArray(r)) {
    return r.map((b) => (typeof b === "string" ? b : (b?.text ?? b?.content ?? ""))).join("");
  }
  if (typeof r === "object") {
    const parts = [];
    if (typeof r.stdout === "string" && r.stdout) parts.push(r.stdout);
    if (typeof r.stderr === "string" && r.stderr) parts.push(r.stderr);
    if (!parts.length) {
      for (const k of ["output", "content", "result", "text", "message"]) {
        if (typeof r[k] === "string" && r[k]) {
          parts.push(r[k]);
          break;
        }
      }
    }
    if (!parts.length) {
      try {
        return JSON.stringify(r);
      } catch {
        return "";
      }
    }
    return parts.join("");
  }
  return String(r);
}

/** 工具响应的退出码（拿不到返回 null） */
export function toolExitCode(ev) {
  const r = ev?.tool_response;
  if (!r || typeof r !== "object") return null;
  for (const k of ["exit_code", "exitCode", "code", "status"]) {
    if (typeof r[k] === "number") return r[k];
  }
  return null;
}

/**
 * .harness/ 下各产物的规范路径。
 *
 * ★ 第 2 段变更（日志中心）：这里**故意没有 `logs`**。
 *   项目内 `.harness\logs\` 已取消 —— 命令日志、验收原始输出、长输出落盘全部搬到
 *   **工作区根**的 `日志\`（见 lib/log-center.mjs）。项目里只留运行态必需的文件，
 *   它们随 cleanup.ps1 归档后删除，交付项目里不留痕。
 *   任何还想去项目内写 logs 的调用方，改 import lib/log-center.mjs（不要在这里补回来）。
 */
export function harnessPaths(root) {
  const base = path.join(root, ".harness");
  return {
    base,
    handoff: path.join(base, "HANDOFF.md"),
    journal: path.join(base, "JOURNAL.md"),
    bypass: path.join(base, "bypass"),
    verifyConfig: path.join(base, "verify.json"),
    // 审计的"最新一份"仍然留在项目里：下一次启动要由 build-prompt.mjs 注入（闭环），
    // 而且它属于运行态、随清理删除 —— 日志中心那份是只追加的历史报告，不做覆盖写。
    auditLatestMd: path.join(base, "audit-latest.md"),
    auditLatestJson: path.join(base, "audit-latest.json"),
  };
}

/** 建目录；失败返回 false（调用方一律 fail-open） */
export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readTextFile(file, capBytes = 256 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size <= capBytes) return fs.readFileSync(file, "utf8");
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(capBytes);
      const n = fs.readSync(fd, buf, 0, capBytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 原子写 JSON：先写临时文件再 rename */
export function writeJsonAtomic(file, obj) {
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 追加写文本（失败静默） */
export function appendText(file, text) {
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, text);
    return true;
  } catch {
    return false;
  }
}

/** 覆盖写文本（失败静默） */
export function writeText(file, text) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text);
    return true;
  } catch {
    return false;
  }
}

/** 本地时间戳 `2026-09-11 20:15:03` */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 文件名安全的时间戳 `20260911-201503` */
export function stampCompact(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 上下文水位（statusline.mjs 写入，hooks 只读） */
export function readCtx(root) {
  const j = readJsonFile(path.join(stateDirFor(root), "ctx.json"));
  if (!j || typeof j !== "object") return null;
  return j;
}

/** ctx.json 的真实路径（statusline 写入用；与 readCtx 同源，保证两边永远一致） */
export function ctxFile(root) {
  return path.join(stateDirFor(root), "ctx.json");
}

/** 会话级其它状态文件（stop-guard 等）的落点 —— 与 quota.json 同一个状态目录 */
export function stateFileNamed(root, name) {
  return path.join(stateDirFor(root), name);
}

/**
 * ctx.json 是否可信。statusline 只在渲染时更新，
 * 太旧的数据（默认 30 分钟）不足以支撑「拒绝结束会话」这种重决定。
 */
export function ctxIsFresh(ctx, maxAgeMs = 30 * 60 * 1000) {
  if (!ctx || typeof ctx.ts !== "number") return false;
  const age = Date.now() - ctx.ts;
  return age >= 0 && age <= maxAgeMs;
}

/** 读 HANDOFF.md，取前 n 行（用于注入，避免把整个文件灌进上下文） */
export function handoffHead(root, n = 20) {
  const txt = readTextFile(harnessPaths(root).handoff);
  if (!txt) return null;
  return txt.split(/\r?\n/).slice(0, n).join("\n").trim() || null;
}

/** 本会话已跑过多少次 L1/E2E（状态栏与 HANDOFF 用） */
export function sessionCounters(s) {
  const countObj = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);
  return {
    edits: countObj(s?.edits),
    reads: countObj(s?.reads),
    editTotal: s?.edits ? Object.values(s.edits).reduce((a, b) => a + b, 0) : 0,
    e2eOk: s?.e2e?.ok ?? 0,
    e2eBlocked: s?.e2e?.blocked ?? 0,
    ciOk: s?.ci?.ok ?? 0,
  };
}
