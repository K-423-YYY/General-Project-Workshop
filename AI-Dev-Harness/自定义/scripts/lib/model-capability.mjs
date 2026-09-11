/**
 * lib/model-capability.mjs —— 模型能力解析层（L0 共享模块）
 * ============================================================
 * 谁在用：
 *   - env-doctor.mjs   （A11 体检主入口）
 *   - probe-model.mjs  （A12 能力探测）
 *   （第 2/3 批的 .claude/hooks/lib/policy.mjs 也会读本模块的 resolveCapability()）
 *
 * 它解决什么问题（用户第一优先级）：
 *   换任何新模型时，"压缩上限"必须自动落到安全值，用户什么都不用做。
 *   本模块保证：解析不出来的模型，一律回落到 autoCompactWindow = 102400。
 *
 * 三档来源（优先级从高到低）：
 *   ① 画像文件 state/model-profiles/<端点>-<模型>.json  —— 学习/探测得到的真实值
 *   ② 静态表 自定义/模型能力表.json 的模式匹配         —— 已知模型
 *   ③ 保守兜底（表里的 conservative 段）               —— 未知模型，102400
 *
 * 依赖：无（只用 node 内置模块）。
 * ============================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));      // ...\自定义\scripts\lib
export const DEFAULT_HARNESS_ROOT = path.resolve(LIB_DIR, "..", "..", "..");
// → ...\AI-Dev-Harness          （lib → scripts → 自定义 → AI-Dev-Harness）
export const DEFAULT_WORK_ROOT = path.resolve(DEFAULT_HARNESS_ROOT, "..");
// → ...\General-Project-Workshop（工作区根）

export const TABLE_REL_PATH = path.join("自定义", "模型能力表.json");
export const PROFILE_REL_DIR = path.join("state", "model-profiles");

// ────────────────────────────────────────────────────────────
// 基础工具
// ────────────────────────────────────────────────────────────

/** 读 JSON；失败返回 {ok:false, error}，不抛。 */
export function readJsonSafe(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 把模型能力表.json 里的 glob 模式转成正则（只支持 `*` 和 `?`）。 */
export function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * 去掉模型名的 `[1M]` 后缀并归一化 —— `[1M]` 是客户端记账用的虚构后缀，
 * 不是真实模型名，写进文件/请求前必须剥掉。
 */
export function sanitizeModelId(name) {
  return String(name ?? "")
    .replace(/\[1m\]/gi, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 模型名是否带 `[1M]` 后缀（陷阱判定）。 */
export function hasBannedSuffix(name, table) {
  const re = bannedSuffixRegex(table);
  return re.test(String(name ?? ""));
}

/** 是否原生 Anthropic 模型（只有它们写 [1M] 才是真的，第三方写 [1M] 只是本地记账）。 */
export function isNativeAnthropicModel(modelId) {
  return /^claude-/.test(String(modelId ?? "").toLowerCase());
}

function bannedSuffixRegex(table) {
  const b = table?.bannedSuffix;
  const pattern = b?.pattern ?? "\\[1m\\]";
  const flags = b?.flags ?? "i";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return /\[1m\]/i;
  }
}

/** 从 base URL 取端点主机名（画像文件名要用，只保留域名，不带路径与查询串）。 */
export function endpointHost(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "unknown-endpoint";
  try {
    return new URL(raw).hostname || "unknown-endpoint";
  } catch {
    // 不是合法 URL（例如只是 "api.deepseek.com"）
    return raw.replace(/^https?:\/\//i, "").split("/")[0].split("?")[0] || "unknown-endpoint";
  }
}

// ────────────────────────────────────────────────────────────
// 静态表
// ────────────────────────────────────────────────────────────

export function tablePath(harnessRoot = DEFAULT_HARNESS_ROOT) {
  return path.join(harnessRoot, TABLE_REL_PATH);
}

/** 读静态表；缺文件时返回内置兜底表（保证脚本永远能跑，绝不因缺表而放行大窗口）。 */
export function loadTable(harnessRoot = DEFAULT_HARNESS_ROOT) {
  const file = tablePath(harnessRoot);
  const res = readJsonSafe(file);
  if (res.ok) return { table: res.value, path: file, ok: true };

  return {
    ok: false,
    path: file,
    error: res.error,
    table: {
      schema: 0,
      conservative: { autoCompactWindow: 102400, measuredWindow: 102400, hookStrictness: "strict" },
      defaults: {
        window: 131072, autoCompactWindow: 102400, maxOutputTokens: 8192,
        supportsToolUse: true, supportsParallelTools: false,
        supportsCacheControl: true, supportsSystemPrompt: true,
        instructionFollowing: 0.4, hookStrictness: "strict",
      },
      mapping: {
        windowToAutoCompact: [
          { maxWindow: 131072, autoCompactWindow: 102400 },
          { maxWindow: 262144, autoCompactWindow: 160000 },
          { maxWindow: null, autoCompactWindow: 200000 },
        ],
        strictness: { strictBelow: 0.7, standardAtOrAbove: 0.85 },
        cacheControlPenalty: 0.6,
        outputThresholdPenalty: 0.5,
      },
      hardCeiling: { autoCompactWindow: 200000 },
      passiveLearning: {
        promptTooLongFactor: 0.75, promptTooLongFloor: 32768,
        sessionOkTurns: 30, sessionOkFactor: 1.1,
      },
      bannedSuffix: { pattern: "\\[1m\\]", flags: "i", suffix: "[1M]", declaredWindow: 1000000 },
      models: [],
    },
  };
}

/** 在 models 里按顺序找第一个匹配的模式（先写先赢，所以具体模式要写在通配前面）。 */
export function matchModelEntry(table, modelId) {
  const models = Array.isArray(table?.models) ? table.models : [];
  for (const entry of models) {
    if (!entry?.pattern) continue;
    if (globToRegExp(entry.pattern).test(modelId)) return entry;
  }
  return null;
}

/** 静态表能给出的能力（defaults + 命中的模式条目）。 */
export function staticCapabilities(table, modelId) {
  const defaults = table?.defaults ?? {};
  const entry = matchModelEntry(table, modelId);
  return {
    matched: Boolean(entry),
    entry,
    window: entry?.window ?? defaults.window ?? 131072,
    maxOutputTokens: entry?.maxOutputTokens ?? defaults.maxOutputTokens ?? 8192,
    supportsToolUse: entry?.supportsToolUse ?? defaults.supportsToolUse ?? true,
    supportsParallelTools: entry?.supportsParallelTools ?? defaults.supportsParallelTools ?? false,
    supportsCacheControl: entry?.supportsCacheControl ?? defaults.supportsCacheControl ?? true,
    supportsSystemPrompt: entry?.supportsSystemPrompt ?? defaults.supportsSystemPrompt ?? true,
    instructionFollowing: entry?.instructionFollowing ?? defaults.instructionFollowing ?? 0.4,
    note: entry?.note ?? null,
  };
}

// ────────────────────────────────────────────────────────────
// 映射：窗口 → autoCompactWindow / 严格度
// ────────────────────────────────────────────────────────────

/** 压缩阈值 = 窗口 − 预留（两个常量 20000 + 13000）。 */
export function compactionThreshold(window, table) {
  const reserve = Number(table?.compactionReserve ?? 33000);
  return Math.max(0, Number(window || 0) - reserve);
}

/**
 * 『实测/声明窗口 → autoCompactWindow』映射（见 01-总方案.md 的能力映射表）。
 * 结果一定 ≤ hardCeiling，这是防爆的最后一夹。
 */
export function autoCompactWindowFor(window, table) {
  const steps = table?.mapping?.windowToAutoCompact ?? [];
  const w = Number(window || 0);
  let chosen = table?.conservative?.autoCompactWindow ?? 102400;
  for (const s of steps) {
    if (s?.maxWindow === null || s?.maxWindow === undefined) { chosen = s.autoCompactWindow; break; }
    if (w <= Number(s.maxWindow)) { chosen = s.autoCompactWindow; break; }
  }
  const ceiling = Number(table?.hardCeiling?.autoCompactWindow ?? 200000);
  return Math.min(Number(chosen), ceiling);
}

/**
 * 保守上限：不允许任何自动机制把 autoCompactWindow 抬到这个值之上。
 * 见 模型能力表.json 的 conservative.raiseRequiresOptIn 说明
 * —— 探测测的是「端点吞得下」，不是「模型还清醒」。
 */
export function conservativeCap(table) {
  return Number(table?.conservative?.autoCompactWindow ?? 102400);
}

/** 是否允许把上限抬到保守值之上（默认不允许，必须显式放开）。 */
export function raiseAllowed(table, explicit = false) {
  if (explicit) return true;
  return table?.conservative?.raiseRequiresOptIn === false;
}

/** instructionFollowing → hookStrictness。永远由分数推导，避免读到一个过期的固定值。 */
export function strictnessFor(instructionFollowing, table) {
  const st = table?.mapping?.strictness ?? {};
  const strictBelow = Number(st.strictBelow ?? 0.7);
  const standardAt = Number(st.standardAtOrAbove ?? 0.85);
  const score = Number(instructionFollowing);
  if (!Number.isFinite(score)) return "strict";
  if (score >= standardAt) return "standard";
  if (score < strictBelow) return "strict";
  return "strict"; // 中间地带（0.7–0.85）仍按严格 —— 弱模型不赌
}

/** 严格度对 hooks 的实际含义（给报告用）。 */
export function strictnessMeaning(level) {
  return level === "standard"
    ? "标准模式：G3（Python 内联改码）降为 warn，其余规则照常"
    : "严格模式：G1/G2/G3 全部直接 deny（用户已确认决策 2）";
}

// ────────────────────────────────────────────────────────────
// 画像文件（state/model-profiles/）
// ────────────────────────────────────────────────────────────

export function profilesDir(harnessRoot = DEFAULT_HARNESS_ROOT) {
  // ★ 第 3 段 · 锁定决策 4：HARNESS_STATE_DIR 一旦设定，画像也整体搬过去。
  // 不设时行为与以前完全一样（<harness>\state\model-profiles）。
  // 用途：跑验收 / 自检时可以「状态写临时目录，项目与工作区都不受污染」。
  const override = String(process.env.HARNESS_STATE_DIR || "").trim();
  if (override) return path.join(path.resolve(override), "model-profiles");
  return path.join(harnessRoot, PROFILE_REL_DIR);
}

export function profileFileName(endpoint, modelId) {
  return `${endpointHost(endpoint)}-${sanitizeModelId(modelId)}.json`;
}

export function profilePath(harnessRoot, endpoint, modelId) {
  return path.join(profilesDir(harnessRoot), profileFileName(endpoint, modelId));
}

export function listProfiles(harnessRoot = DEFAULT_HARNESS_ROOT) {
  const dir = profilesDir(harnessRoot);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { dir, files: [], profiles: [] };
  }
  const files = names.filter((n) => n.endsWith(".json")).sort();
  const profiles = [];
  for (const n of files) {
    const res = readJsonSafe(path.join(dir, n));
    if (res.ok) profiles.push({ file: path.join(dir, n), ...res.value });
  }
  return { dir, files, profiles };
}

export function readProfile(harnessRoot, endpoint, modelId) {
  const file = profilePath(harnessRoot, endpoint, modelId);
  const res = readJsonSafe(file);
  return res.ok ? { ok: true, file, profile: res.value } : { ok: false, file, error: res.error };
}

/** 原子写画像（先写临时文件再 rename，避免半截 JSON 让下次体检读崩）。 */
export function writeProfile(harnessRoot, profile) {
  const dir = profilesDir(harnessRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = profilePath(harnessRoot, profile.endpoint, profile.model);
  const tmp = `${file}.tmp`;
  const body = JSON.stringify(profile, null, 2) + "\n";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

// ────────────────────────────────────────────────────────────
// 解析：把上面三档合成一个结论
// ────────────────────────────────────────────────────────────

/**
 * 解析一个模型最终该用的能力值。
 *
 * @param {object} opts
 * @param {string} opts.modelName  模型名（允许带 [1M]）
 * @param {string} opts.endpoint   端点 URL 或主机名（可空）
 * @param {string} [opts.harnessRoot]
 * @returns {{modelId,declaredName,endpoint,source,autoCompactWindow,capabilities,notes,profile,profileFile,tableFile}}
 */
export function resolveCapability(opts = {}) {
  const harnessRoot = opts.harnessRoot ?? DEFAULT_HARNESS_ROOT;
  const declaredName = String(opts.modelName ?? "").trim() || "unknown-model";
  const modelId = sanitizeModelId(declaredName) || "unknown-model";
  const endpoint = endpointHost(opts.endpoint);

  const { table, path: tableFile, ok: tableOk, error: tableError } = loadTable(harnessRoot);
  const staticCaps = staticCapabilities(table, modelId);
  const notes = [];
  if (!tableOk) notes.push(`静态表读取失败（${tableFile}：${tableError}），已用内置兜底表`);

  const marked = hasBannedSuffix(declaredName, table);
  const native = isNativeAnthropicModel(modelId);
  const bannedDeclaredWindow = Number(table?.bannedSuffix?.declaredWindow ?? 1000000);

  // ---- 三档来源 ----
  const prof = readProfile(harnessRoot, endpoint, modelId);
  let source = "conservative";
  let profile = null;
  let resolvedWindow = Number(table?.conservative?.measuredWindow ?? 102400);

  if (prof.ok) {
    profile = prof.profile;
    source = "profile";
    resolvedWindow = Number(
      profile.measuredWindow ?? profile.declaredWindow ?? resolvedWindow
    );
    notes.push(`画像文件已加载（source=${profile.source ?? "未知"}，lastUpdated=${profile.lastUpdated ?? "未知"}）`);
  } else if (staticCaps.matched) {
    source = "static";
    resolvedWindow = Number(staticCaps.window);
  } else {
    notes.push("静态表未匹配到该模型 —— 使用保守值（这是设计行为，不是错误）");
  }

  // ---- 关键安全规则：第三方模型的 [1M] 声明不可信 ----
  // 例外：画像是**实测**出来的窗口（--probe 的 measuredWindow），那个可信，不覆盖。
  const trustedMeasured =
    profile != null && Number.isFinite(Number(profile.measuredWindow)) && Number(profile.measuredWindow) > 0;
  const bannedOverride = marked && !native && !trustedMeasured;
  if (bannedOverride) {
    resolvedWindow = Number(table?.conservative?.measuredWindow ?? 102400);
    notes.push(
      `模型名带 ${table?.bannedSuffix?.suffix ?? "[1M]"} 后缀且不是原生 Anthropic 模型 → ` +
      `声明的 ${bannedDeclaredWindow} 窗口一律视为虚构，按保守值 ${resolvedWindow} 处理`
    );
  }

  // ---- 合成能力 ----
  const instructionFollowing = Number(
    profile?.instructionFollowing ?? staticCaps.instructionFollowing
  );
  const hookStrictness = strictnessFor(instructionFollowing, table);

  const mappedWindow = autoCompactWindowFor(resolvedWindow, table);
  const cap = conservativeCap(table);
  let autoCompactWindow = raiseAllowed(table, false) ? mappedWindow : Math.min(mappedWindow, cap);
  if (autoCompactWindow < mappedWindow) {
    notes.push(
      `映射结果 ${mappedWindow} 高于保守上限 ${cap} → 已夹到 ${autoCompactWindow}` +
      `（模型能力表.json 的 conservative.raiseRequiresOptIn=true 在起作用）`
    );
  }
  if (Number.isFinite(Number(profile?.autoCompactWindow)) && profile?.autoCompactWindowPinned) {
    autoCompactWindow = Math.min(
      Number(profile.autoCompactWindow),
      Number(table?.hardCeiling?.autoCompactWindow ?? 200000)
    );
    notes.push("画像里显式钉住了 autoCompactWindow（autoCompactWindowPinned=true，仍受 hardCeiling 夹取）");
  }

  // 被 [1M] 规则覆盖过的话，来源要如实标注成「保守覆盖」，不能谎称来自静态表
  if (bannedOverride) {
    source = profile ? "banned-override+profile" : "banned-override";
  }

  const capabilities = {
    window: resolvedWindow,
    declaredWindow: marked ? bannedDeclaredWindow : resolvedWindow,
    autoCompactWindow,
    compactionThreshold: compactionThreshold(autoCompactWindow, table),
    maxOutputTokens: Number(profile?.maxOutputTokens ?? staticCaps.maxOutputTokens),
    supportsToolUse: profile?.supportsToolUse ?? staticCaps.supportsToolUse,
    supportsParallelTools: profile?.supportsParallelTools ?? staticCaps.supportsParallelTools,
    supportsCacheControl: profile?.supportsCacheControl ?? staticCaps.supportsCacheControl,
    supportsSystemPrompt: profile?.supportsSystemPrompt ?? staticCaps.supportsSystemPrompt,
    instructionFollowing,
    hookStrictness,
    hookStrictnessMeaning: strictnessMeaning(hookStrictness),
    hasBannedSuffix: marked,
    isNativeAnthropic: native,
    bannedOverride,
  };

  return {
    modelId,
    declaredName,
    endpoint,
    source,
    resolvedWindow,
    autoCompactWindow,
    capabilities,
    notes,
    profile,
    profileFile: prof.file,
    tableFile,
    table,
  };
}

// ────────────────────────────────────────────────────────────
// 被动学习（L0 第②档：零成本，越用越准）
// ────────────────────────────────────────────────────────────

/**
 * 被动学习能上调到的最高值。
 * 默认被 conservativeCap 夹住（raiseRequiresOptIn=true 时），
 * 免得"连续 30 轮没事"这种弱证据把上限一路抬到 20 万。
 */
export function learnCeiling(harnessRoot, modelId, profile, table) {
  const t = table ?? loadTable(harnessRoot).table;
  const cap = conservativeCap(t);
  const probed = Number(profile?.probeResult?.measuredWindow);
  const fromProbe = Number.isFinite(probed) && probed > 0 ? probed : null;
  const entry = matchModelEntry(t, modelId);
  const fromStatic = entry?.window ? Number(entry.window) : null;
  const raw = fromProbe ?? fromStatic ?? Number(t?.conservative?.measuredWindow ?? 102400);
  return raiseAllowed(t, false) ? raw : Math.min(raw, cap);
}

/**
 * 把一个观测信号写进画像。信号：
 *   - `prompt-too-long`  API 报超长 → 立即下调 25%
 *   - `session-ok`       连续 ≥30 轮无异常 → 谨慎上调 10%
 *   - `context-size`     观测到引擎报出的 context_window_size → 记为声明上界
 *
 * @returns {{profile:object, action:string, window:number}}
 */
export function applySignal(opts = {}) {
  const harnessRoot = opts.harnessRoot ?? DEFAULT_HARNESS_ROOT;
  const modelName = String(opts.modelName ?? "").trim() || "unknown-model";
  const modelId = sanitizeModelId(modelName);
  const endpoint = endpointHost(opts.endpoint);
  const { table } = loadTable(harnessRoot);

  const existing = readProfile(harnessRoot, endpoint, modelId);
  const now = new Date().toISOString();

  const profile = existing.ok
    ? JSON.parse(JSON.stringify(existing.profile))
    : {
        model: modelId,
        declaredName: modelName,
        endpoint,
        declaredWindow: null,
        measuredWindow: null,
        effectiveWindow: Number(table?.conservative?.measuredWindow ?? 102400),
        autoCompactWindow: Number(table?.conservative?.autoCompactWindow ?? 102400),
        maxOutputTokens: table?.defaults?.maxOutputTokens ?? 8192,
        supportsToolUse: table?.defaults?.supportsToolUse ?? true,
        supportsParallelTools: table?.defaults?.supportsParallelTools ?? false,
        supportsCacheControl: table?.defaults?.supportsCacheControl ?? true,
        supportsSystemPrompt: table?.defaults?.supportsSystemPrompt ?? true,
        instructionFollowing: table?.defaults?.instructionFollowing ?? 0.4,
        hookStrictness: "strict",
        evidence: [],
        source: "passive",
      };

  profile.model = modelId;
  profile.declaredName = modelName;
  profile.endpoint = endpoint;

  const pl = table?.passiveLearning ?? {};
  let action = "";

  if (!Array.isArray(profile.evidence)) profile.evidence = [];
  const base = Number(profile.effectiveWindow ?? table?.conservative?.measuredWindow ?? 102400);

  switch (opts.signal) {
    case "prompt-too-long": {
      const factor = Number(pl.promptTooLongFactor ?? 0.75);
      const floor = Number(pl.promptTooLongFloor ?? 32768);
      const next = Math.max(floor, Math.round(base * factor));
      profile.effectiveWindow = next;
      action = `遇到 API 超长报错 → 窗口下调 ${Math.round((1 - factor) * 100)}%：${base} → ${next}`;
      profile.evidence.push({ date: now.slice(0, 10), signal: "prompt-too-long", action });
      break;
    }
    case "session-ok": {
      const turns = Number(opts.turns ?? 0);
      const need = Number(pl.sessionOkTurns ?? 30);
      if (turns < need) {
        // 无变化 → 不写盘，如实返回 file=null，免得调用方以为更新了文件
        return { profile, action: `轮次 ${turns} < ${need}，不触发上调（无变化）`, window: base, file: null };
      }
      const ceiling = learnCeiling(harnessRoot, modelId, profile, table);
      const factor = Number(pl.sessionOkFactor ?? 1.1);
      const next = Math.min(ceiling, Math.round(base * factor));
      profile.effectiveWindow = next;
      action = next === base
        ? `连续 ${turns} 轮无异常，但窗口已到上限 ${ceiling}（无变化）`
        : `连续 ${turns} 轮无异常 → 窗口上调 ${Math.round((factor - 1) * 100)}%：${base} → ${next}（上限 ${ceiling}）`;
      profile.evidence.push({ date: now.slice(0, 10), signal: `session-ok x${turns}`, action });
      break;
    }
    case "context-size": {
      const w = Number(opts.window ?? 0);
      if (!Number.isFinite(w) || w <= 0) throw new Error("--record context-size 需要 --window <token 数>");
      profile.declaredWindow = w;
      action = `记录引擎报出的窗口上界：${w}（阈值 ≈ ${compactionThreshold(w, table)}）`;
      profile.evidence.push({ date: now.slice(0, 10), signal: `context_window_size=${w}`, action });
      profile.source = "observed";
      break;
    }
    default:
      throw new Error(
        `未知信号「${opts.signal}」。可用：prompt-too-long | session-ok | context-size`
      );
  }

  const win = Number(profile.effectiveWindow ?? base);
  const ceil = learnCeiling(harnessRoot, modelId, profile, table);
  const mapped = autoCompactWindowFor(Math.min(win, ceil), table);
  // 被动学习永远不许越过保守上限（除非表里显式放开了 raiseRequiresOptIn）
  profile.autoCompactWindow = raiseAllowed(table, false)
    ? mapped
    : Math.min(mapped, conservativeCap(table));
  profile.hookStrictness = strictnessFor(profile.instructionFollowing, table);
  profile.lastUpdated = now;
  if (profile.source === "passive" && opts.signal !== "context-size") {
    profile.source = existing.ok ? profile.source + "+passive" : "passive";
  }

  const file = writeProfile(harnessRoot, profile);
  return { profile, action, window: win, file };
}

// ────────────────────────────────────────────────────────────
// 用户级配置的只读侦察（绝不写、绝不打印任何密钥值）
// ────────────────────────────────────────────────────────────

/**
 * 只读扫描 ~/.claude/settings.json，回答两件事：
 *   1. 哪些模型名带 [1M] 后缀（陷阱来源）
 *   2. 有没有明文密钥字段（只报字段名，绝不返回值）
 *
 * 本函数**绝不可以**把任何值写进报告。
 */
export function inspectUserSettings(settingsFile = path.join(os.homedir(), ".claude", "settings.json")) {
  const out = {
    file: settingsFile,
    exists: fs.existsSync(settingsFile),
    modelFields: [],   // {key, value}  —— 只放模型名，模型名不是密钥
    suffixHits: [],
    secretFields: [],  // 只有字段名
    baseUrl: null,
    error: null,
  };
  if (!out.exists) return out;

  const res = readJsonSafe(settingsFile);
  if (!res.ok) { out.error = res.error; return out; }

  const j = res.value ?? {};
  if (typeof j.model === "string") out.modelFields.push({ key: "model", value: j.model });

  const env = j.env && typeof j.env === "object" ? j.env : {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (/TOKEN|KEY|SECRET|PASSWORD/i.test(k)) { out.secretFields.push(k); continue; }
    if (/MODEL/.test(k)) out.modelFields.push({ key: `env.${k}`, value: v });
    if (k === "ANTHROPIC_BASE_URL") out.baseUrl = v;
  }

  for (const { key, value } of out.modelFields) {
    if (/\[1m\]/i.test(value)) out.suffixHits.push({ key, value });
  }
  return out;
}
