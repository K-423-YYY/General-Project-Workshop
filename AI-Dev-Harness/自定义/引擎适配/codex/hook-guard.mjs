#!/usr/bin/env node
/**
 * hook-guard.mjs —— Codex CLI 的 PreToolUse 处理器（第 6 批 · F11）
 * ============================================================
 * 干的活：拦下 `sed -i` / `perl -i` / `cat > 源文件` / `python -c 改码` / `sleep 长等待`，
 *         让 Codex 侧也有和 Claude Code 的 `guard-bash.mjs` 同源的机制层。
 *
 * ────────────────────────────────────────────────────────────
 * ★★ 诚实声明：**本脚本没有在真实 Codex 会话里跑过。★★
 *
 * 原因：跑真会话要花钱，第 6 批遵守 04 文档「零额度优先」原则，没有发起任何模型请求。
 * 因此它是按**两条证据**推断着写的，而不是实测着写的：
 *   ① 二进制字符串里出现过 hookEventName / permissionDecision / hook_event_name
 *      ——与 Claude Code 同形；
 *   ② Codex 自己的报错串：「PermissionRequest hook exited with code 2 but did not
 *      write a denial reason to stderr」——即 **退出码 2 = 拒绝，stderr = 拒绝理由**。
 *
 * 所以本脚本的第一职责不是拦截，而是**协议侦察**：
 *   ★ 每次被调用都把 stdin 原样追加到 **harness 的状态目录**下的
 *     `state\codex-probe\stdin.jsonl`（或 $HARNESS_STATE_DIR\codex-probe\stdin.jsonl）。
 *   ★ 第一次启用后请先看这个文件，确认字段名之后再依赖它的拦截结论。
 *     （这是第 2 批验证 `stop_hook_active` 时用过的同一套办法。）
 *
 *   ★ 第 3 段（P2-6）把这个落盘点从「交付目录（引擎适配\codex\）」搬到了「状态目录」：
 *     ① 交付目录是**要分发的东西**，不该越用越脏（旧位置会攒出一个不断增长的 jsonl）；
 *     ② 交付目录可能是只读的（复制/解压后），写不进去就让自检台红一项 —— 那是假失败；
 *     ③ 状态目录本来就有 HARNESS_STATE_DIR 这个开关，正好用来做「状态写临时目录」的验收。
 *
 * 行为：
 *   命中禁用命令 → stderr 写教学信息，exit 2（拒绝）
 *   未命中       → exit 0（放行）
 *   任何异常     → exit 0（fail-open：机制层坏了不该把引擎卡死）
 *
 * 逃生阀：工作区根或 cwd 存在 `.harness\bypass` → 一律放行。
 * ============================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_MAX_BYTES = 4 * 1024 * 1024;

/** 落盘点（按优先级）：HARNESS_STATE_DIR\codex-probe → <harness>\state\codex-probe → 系统临时目录。 */
function probeFile() {
  const override = String(process.env.HARNESS_STATE_DIR || "").trim();
  if (override) return path.join(path.resolve(override), "codex-probe", "stdin.jsonl");
  // HERE = <harness>\自定义\引擎适配\codex → 往上三级 = <harness>
  return path.join(path.resolve(HERE, "..", "..", ".."), "state", "codex-probe", "stdin.jsonl");
}

/** 读 stdin（同步，hook 场景下够用）。 */
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * 原样落盘，供协议侦察。带大小上限，不自建日志轮转。
 * ★ 失败一律**静默吞掉**（不写 stderr）：Codex 把 stderr 当拒绝理由，
 *   这里多吐一行就会污染真正的拦截信息。侦察数据丢一次不是事故，污染拦截理由是。
 */
function logStdin(raw) {
  const line = raw.replace(/\r?\n/g, " ") + "\n";
  const targets = [probeFile(), path.join(os.tmpdir(), "harness-codex-probe", "stdin.jsonl")];
  for (const LOG of targets) {
    try {
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX_BYTES) fs.rmSync(LOG, { force: true });
      fs.appendFileSync(LOG, line, "utf8");
      return true;
    } catch {
      /* 换下一个落点 */
    }
  }
  return false;
}

/** 逃生阀：与 Claude Code 侧同一约定。 */
function bypassActive(cwd) {
  for (const base of [cwd, process.cwd()]) {
    if (!base) continue;
    try {
      if (fs.existsSync(path.join(base, ".harness", "bypass"))) return true;
    } catch { /* 忽略 */ }
  }
  return false;
}

/** 从任意形状的 hook 载荷里尽力挖出「要执行的命令」。字段名未实测，所以多试几个。 */
function extractCommand(ev) {
  const cands = [
    ev?.tool_input?.command,
    ev?.toolInput?.command,
    ev?.input?.command,
    ev?.tool?.input?.command,
    ev?.arguments?.command,
    typeof ev?.command === "string" ? ev.command : null,
  ];
  for (const c of cands) if (typeof c === "string" && c.trim()) return c;
  return "";
}

/** 禁用命令规则（与 Claude Code 的 guard-bash.mjs 同源，教学信息一致）。 */
const RULES = [
  {
    id: "sed-inplace",
    test: (c) => /\bsed\b[^\n|;]*\s-i(\s|$|[.'"])/.test(c),
    why: "`sed -i` 在 Windows 上会静默失配（退出码 0 但文件没改），改坏了你还不知道。",
    how: "改用 Edit 工具做替换，或用 Write 工具整文件重写。",
  },
  {
    id: "perl-inplace",
    test: (c) => /\bperl\b[^\n|;]*\s-i(\s|$|[.'"])/.test(c),
    why: "同 `sed -i`：原地编辑在 Windows 上不可靠。",
    how: "改用 Edit / Write 工具。",
  },
  {
    id: "heredoc-write",
    test: (c) => /\bcat\s*>\s*\S/.test(c) || /\btee\s+\S/.test(c),
    why: "用 shell 重定向写源文件会绕过编辑工具的 diff 与校验。",
    how: "改用 Write 工具写文件。",
  },
  {
    id: "python-inline-write",
    test: (c) => /\bpython[0-9.]*\b[^\n]*\s-c\s/.test(c) && /(open\s*\(|\.write\s*\(|pathlib|shutil)/.test(c),
    why: "Python 内联改码是 G3 明令禁止的写文件方式，且无法审计。",
    how: "改用 Edit / Write 工具；需要跑脚本就用 `python 脚本.py` 而不是 `-c`。",
  },
  {
    id: "long-sleep",
    test: (c) => /\bsleep\s+(\d{3,})\b/.test(c) || /\b(Start-Sleep|timeout)\s+.*\b(\d{3,})\b/.test(c),
    why: "长等待会白烧上下文，且通常说明在用轮询等一件本该同步做的事。",
    how: "把等待改成同步检查；确实需要就拆成短命令逐个确认。",
  },
];

function teaching(rule, cmd) {
  return [
    `[harness/codex] 已拦截禁用命令（规则 ${rule.id}）：`,
    "",
    `  ${cmd.length > 200 ? cmd.slice(0, 200) + " …" : cmd}`,
    "",
    `为什么：${rule.why}`,
    `怎么做：${rule.how}`,
    "",
    "被拦下不等于碰到障碍——换工具做同一件事即可，**不要换种写法绕过**。",
    "确实需要临时放行：在工作区根建 `.harness\\bypass` 文件，用完立即删除。",
  ].join("\n");
}

function main() {
  const raw = readStdin();
  logStdin(raw);

  let ev = {};
  try { ev = JSON.parse(raw || "{}"); } catch { return 0; } // 载荷非法 → 放行

  const cwd = ev?.cwd ?? ev?.workspace ?? null;
  if (bypassActive(cwd)) return 0;

  const cmd = extractCommand(ev);
  if (!cmd) return 0;

  const hit = RULES.find((r) => r.test(cmd));
  if (!hit) return 0;

  process.stderr.write(teaching(hit, cmd) + "\n");
  return 2; // Codex 的约定：退出码 2 = 拒绝，stderr = 理由
}

try {
  process.exit(main());
} catch {
  // fail-open：机制层自身出错时绝不把引擎卡死
  process.exit(0);
}
