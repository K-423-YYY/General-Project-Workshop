/**
 * log-center.mjs —— 日志中心的**唯一实现**（第 2 段 · 要求 A）
 * ============================================================
 * 为什么日志要挪出项目：项目文件夹是要交付给用户的，交付前必须"干净、可整体复制走"。
 * 运行日志属于 harness 自己的资产，留在项目里只有两个后果 —— 交付时要清，
 * 清不干净就留痕。所以日志统一写到**工作区根**的 `日志\` 下，项目里一个字节都不留。
 *
 * 布局（8 个分类，见 日志\README.md）：
 *   01-会话  启动词快照 / 上下文水位 / 结束摘要
 *   02-命令  逐条命令（工具、命令、放行-拦截、退出码、耗时）+ G10 长输出原始落盘
 *   03-验证  独立验收原始输出（只落盘、不可改写）
 *   04-拦截  G1–G8 每次 deny/warn：规则、命令、替代建议
 *   05-清理  "将删除/将保留"清单 + 纯净度自检结果
 *   06-引擎  引擎探测结果 / 本次实际引擎 / 机制层是否生效
 *   07-审计  audit.mjs 报告
 *   08-模型  自主学习轨迹（每次上调/下调 before→after 与依据）
 *
 * 四条硬规矩（本文件把它们落成代码，而不是靠各调用方自觉）：
 *   1. **只追加，不改写** —— 只用 appendFileSync，绝不 truncate 已存在的文件。
 *   2. **按日期分文件** —— 文件名带日期（见 FILES），便于事后按天检索。
 *   3. **单文件超 8 MB 轮转** —— 轮转是 rename，历史一个字节不丢。
 *   4. **写入失败绝不影响主流程** —— 任何异常都被吞掉，只在 stderr 出声（fail-open）。
 *
 * 日志根怎么定（顺序固定，不做第二种解释）：
 *   ① 环境变量 HARNESS_LOG_ROOT（启动器 run.ps1 / run.sh 会设）；
 *   ② 从 cwd 向上找含 `AI-Dev-Harness\` 的目录 → `<那个目录>\日志`；
 *   ③ 都找不到 → 返回 null，调用方按"没有日志中心"处理（仍然 fail-open）。
 *
 *   ★ 为什么**不**从本文件位置（<项目>\.claude\hooks\lib）反推：那会让"项目已被复制到工作区之外"
 *     这种正常场景也去写 harness 的日志中心 —— 交付出去的项目不该再和 harness 有任何联系，
 *     而且会让"本机路径"悄悄出现在无关会话里。宁可不写日志（只出声）。
 *
 * ★ 为什么这个文件放在 `.claude\hooks\lib\`：`scaffold-ext.mjs` 会把 `.claude\hooks\`
 *   （含 lib\）整体同步进项目，所以项目内会话的 hooks 也能直接静态 import 到它 ——
 *   机制层最不该出现"依赖某个外部路径还能不能用"的不确定性。
 *   harness 侧的脚本（_log.mjs / audit / probe-* / env-doctor）通过
 *   `AI-Dev-Harness\自定义\scripts\lib\log-center.mjs`（薄加载器）复用它，不重复实现。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 分类键 → 目录名。目录名同时是磁盘上的检索入口，改这里等于改布局。 */
export const CATEGORIES = {
  session: "01-会话",
  command: "02-命令",
  verify: "03-验证",
  block: "04-拦截",
  cleanup: "05-清理",
  engine: "06-引擎",
  audit: "07-审计",
  model: "08-模型",
};

/** 单文件轮转阈值（8 MB） */
export const ROTATE_BYTES = 8 * 1024 * 1024;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\.claude\hooks\lib
const HARNESS_DIR_NAME = "AI-Dev-Harness";
const LOG_DIR_NAME = "日志";

/** 已经出声过的目标（同一进程内不重复刷屏） */
const warned = new Set();

function speak(msg, key) {
  if (key) {
    if (warned.has(key)) return;
    warned.add(key);
  }
  try {
    process.stderr.write(`[harness] ⚠️ 日志中心：${msg}\n`);
  } catch {
    /* stderr 都写不了就只能算了 */
  }
}

/**
 * 「找不到日志根」这句话**每个目录每 6 小时只说一次**。
 * 为什么不一刀切静默：静默会让"日志根被配错"这种问题永远没人发现；
 * 为什么不死板每次都说：项目脱离工作区时（正常场景），hooks 每次调用都会走这条路，
 * 每次都出声会把终端刷掉，反而让人把提示当噪音。
 */
const MISSING_ROOT_REMIND_MS = 6 * 60 * 60 * 1000;
function speakMissingRootOnce() {
  const tag = String(process.cwd()).replace(/[^A-Za-z0-9]/g, "_").slice(-60) || "root";
  const marker = path.join(os.tmpdir(), `harness-log-center-absent-${tag}.txt`);
  try {
    const st = fs.statSync(marker);
    if (Date.now() - st.mtimeMs < MISSING_ROOT_REMIND_MS) return;
  } catch {
    /* 没有标记 → 该说 */
  }
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()} ${process.cwd()}\n`, "utf8");
  } catch {
    /* 写不了标记也无所谓，最多多说一次 */
  }
  speak(
    `找不到日志根（cwd 向上没有 AI-Dev-Harness\\，也没有 HARNESS_LOG_ROOT）—— 本次不写日志。` +
      `项目被复制到工作区之外时属正常；否则请检查 HARNESS_LOG_ROOT。`,
  );
}

// ─────────────────────────────────────────────── 时间戳 / 文件名

const p2 = (n) => String(n).padStart(2, "0");

/** `2026-09-12` */
export function dayStamp(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** `20260912-013045` */
export function stampCompact(d = new Date()) {
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/**
 * 各分类的标准文件名。**读写双方都必须用这里的函数**，
 * 否则 audit 读 `cmd-*.jsonl` 而 _log 写 `cmd_*.jsonl` 这种错配，会静默少读数据。
 */
export const FILES = {
  session: (d = new Date()) => `session-${dayStamp(d)}.md`,
  context: (d = new Date()) => `context-${dayStamp(d)}.jsonl`,
  injection: (d = new Date()) => `injection-${dayStamp(d)}.md`,
  stopStdin: (d = new Date()) => `stop-stdin-${dayStamp(d)}.jsonl`,
  command: (d = new Date()) => `cmd-${dayStamp(d)}.jsonl`,
  commandOutput: (key, d = new Date()) => `output-${stampCompact(d)}-${key || "cmd"}.log`,
  shapeDebug: (d = new Date()) => `shape-debug-${dayStamp(d)}.jsonl`,
  verify: (d = new Date()) => `verify-${stampCompact(d)}.log`,
  block: (d = new Date()) => `block-${dayStamp(d)}.jsonl`,
  cleanup: (d = new Date()) => `cleanup-${stampCompact(d)}.md`,
  engineSession: (d = new Date()) => `session-${stampCompact(d)}.md`,
  engineProbe: (d = new Date()) => `engine-probe-${dayStamp(d)}.jsonl`,
  envDoctor: (d = new Date()) => `env-doctor-${dayStamp(d)}.log`,
  audit: (d = new Date()) => `audit-${stampCompact(d)}.md`,
  model: (d = new Date()) => `model-${dayStamp(d)}.jsonl`,
};

/** 读侧用的 glob（写成函数，免得各处手抄通配符） */
export const GLOBS = {
  command: /^cmd-.*\.jsonl$/,
  verify: /^verify-.*\.log$/,
  commandOutput: /^output-.*\.log$/,
};

// ─────────────────────────────────────────────── 日志根解析

/** 从 dir 向上找「含 AI-Dev-Harness\ 的目录」（工作区根）。找不到返回 null。 */
export function findWorkRoot(startDir) {
  let cur;
  try {
    cur = path.resolve(String(startDir || process.cwd()));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 12; depth++) {
    try {
      const st = fs.statSync(path.join(cur, HARNESS_DIR_NAME));
      if (st.isDirectory()) return cur;
    } catch {
      /* 这一层没有，继续往上 */
    }
    const up = path.dirname(cur);
    if (!up || up === cur) break;
    cur = up;
  }
  return null;
}

/**
 * 解析日志根。返回值是**绝对路径**或 null（null = 找不到工作区根，调用方按无日志处理）。
 * 参数只给测试用：`{ cwd, env, from }`。
 */
export function resolveLogRoot({ cwd = process.cwd(), env = process.env, from = null } = {}) {
  const explicit = env && env.HARNESS_LOG_ROOT;
  if (explicit && String(explicit).trim()) {
    try {
      return path.resolve(String(explicit).trim());
    } catch {
      /* 值非法 → 继续按推导走 */
    }
  }
  const starts = [cwd, from];
  for (const s of starts) {
    if (!s) continue;
    const work = findWorkRoot(s);
    if (work) return path.join(work, LOG_DIR_NAME);
  }
  return null;
}

/** 分类名归一：既接受 'command' 这种键，也接受 '02-命令' 这种目录名 */
export function normalizeCategory(cat) {
  if (!cat) return null;
  const s = String(cat);
  if (Object.prototype.hasOwnProperty.call(CATEGORIES, s)) return CATEGORIES[s];
  return s;
}

/** 建出整个日志中心布局（幂等；失败返回 false） */
export function ensureLayout(logRoot = resolveLogRoot()) {
  if (!logRoot) return false;
  try {
    fs.mkdirSync(logRoot, { recursive: true });
    for (const dir of Object.values(CATEGORIES)) fs.mkdirSync(path.join(logRoot, dir), { recursive: true });
    return true;
  } catch (err) {
    speak(`建目录失败（不影响主流程）：${err?.message || err}`, `mkdir:${logRoot}`);
    return false;
  }
}

// ─────────────────────────────────────────────── 写入

/** 超过 8 MB 就改名轮转（rename 不丢数据）。返回轮转后的文件名或 null。 */
function rotateIfNeeded(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null; // 文件不存在 → 不用轮转
  }
  if (size < ROTATE_BYTES) return null;
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const dir = path.dirname(file);
  const stamp = stampCompact();
  for (let i = 0; i < 50; i++) {
    const target = path.join(dir, `${base}.${stamp}${i ? `-${i}` : ""}${ext}`);
    try {
      fs.renameSync(file, target);
      return target;
    } catch {
      /* 撞名就换一个后缀再试 */
    }
  }
  return null; // 轮转不动就继续往原文件追加，绝不因此丢日志
}

/**
 * 追加一条日志。**永远不抛异常**（fail-open）。
 * @returns {{ok:boolean, path:string|null, error:string|null, rotated?:string|null}}
 */
export function appendLog(cat, { file, text = "", lines = null, logRoot, quiet = false } = {}) {
  const dirName = normalizeCategory(cat);
  if (!dirName) return { ok: false, path: null, error: "缺少分类（category）" };

  const root = logRoot === undefined ? resolveLogRoot() : logRoot;
  if (!root) {
    if (!quiet) speakMissingRootOnce();
    return { ok: false, path: null, error: "找不到日志根" };
  }

  const name = file || `log-${dayStamp()}.log`;
  const dir = path.join(root, dirName);
  const target = path.join(dir, name);
  const body = lines ? lines.map((l) => `${l}\n`).join("") : String(text);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const rotated = rotateIfNeeded(target);
    fs.appendFileSync(target, body, "utf8");
    return { ok: true, path: target, error: null, rotated: rotated ? path.basename(rotated) : null };
  } catch (err) {
    const msg = String(err?.message || err);
    if (!quiet) speak(`${dirName}\\${name} 写入失败（不影响主流程）：${msg}`, `${dirName}:${name}:${msg}`);
    return { ok: false, path: target, error: msg };
  }
}

/** 追加一行 JSONL（命令日志 / 拦截日志 / 水位轨迹 / 模型轨迹都用它） */
export function appendJsonl(cat, file, record, opts = {}) {
  let line;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    return { ok: false, path: null, error: `序列化失败：${err?.message || err}` };
  }
  return appendLog(cat, { ...opts, file, text: `${line}\n` });
}

/** 追加一段带时间戳小标题的 Markdown（报告类用） */
export function appendSection(cat, file, title, body, opts = {}) {
  const text = `\n\n## ${title}\n\n${String(body ?? "").replace(/\s*$/, "")}\n`;
  return appendLog(cat, { ...opts, file, text });
}

/**
 * 读回某个分类下的文件（供 audit 用；只读，不改写）。
 * @returns {{dir:string|null, files:string[], texts:Array<{file:string,text:string}>}}
 */
export function readCategory(cat, { logRoot, filter = null, sinceDay = null, maxBytesPerFile = 8 * 1024 * 1024 } = {}) {
  const root = logRoot === undefined ? resolveLogRoot() : logRoot;
  const dirName = normalizeCategory(cat);
  const empty = { dir: null, files: [], texts: [] };
  if (!root || !dirName) return empty;
  const dir = path.join(root, dirName);
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return { ...empty, dir };
  }
  if (filter) names = names.filter((f) => filter.test(f));
  const texts = [];
  for (const f of names) {
    if (sinceDay) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] < sinceDay) continue;
    }
    try {
      const full = path.join(dir, f);
      if (fs.statSync(full).size > maxBytesPerFile) continue; // 超限的文件不整读，避免把内存吃光
      texts.push({ file: f, text: fs.readFileSync(full, "utf8") });
    } catch {
      /* 读不了就跳过 */
    }
  }
  return { dir, files: names, texts };
}

/** 可写性自检（返回 {writable, error}）—— 只在 doctor/自检台里用 */
export function probeWritable(logRoot = resolveLogRoot()) {
  if (!logRoot) return { writable: false, error: "找不到日志根" };
  const probe = path.join(logRoot, `.write-probe-${process.pid}`);
  try {
    fs.mkdirSync(logRoot, { recursive: true });
    fs.appendFileSync(probe, "probe\n", "utf8");
    fs.unlinkSync(probe);
    return { writable: true, error: null };
  } catch (err) {
    return { writable: false, error: String(err?.message || err) };
  }
}
