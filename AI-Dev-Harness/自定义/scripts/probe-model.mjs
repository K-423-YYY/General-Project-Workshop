#!/usr/bin/env node
/**
 * probe-model.mjs —— 模型能力感知（A12 · L0 第②③档）
 * ============================================================
 * 三档策略，默认路径零成本：
 *   ① 静态表   读 模型能力表.json 模式匹配          —— 默认，0 成本
 *   ② 被动学习 从会话实际发生的事反推（--record）    —— 默认，0 成本
 *   ③ 主动探测 二分法打端点（--probe）              —— 可选，花额度，必须显式确认
 *
 * ★ 用户第一优先级：没有 `--probe` 就绝对不发任何网络请求。
 *   `--probe` 且没有 `--yes` 时，只打印预估请求数与 token 量然后退出。
 *
 * ★ 待实测项 #3（真支持 vs 静默截断）的实现：
 *   探针 = <32 字符随机串> + <填充> + "请重复开头那串字符"
 *   判定：
 *     请求报错（4xx 且报超长）        → HARD_LIMIT（明确不支持）
 *     成功但复述不出随机串            → SILENT_TRUNCATION（假支持，前面被丢了）
 *     成功且复述出随机串              → SUPPORT（真支持）
 *   第 0 步必须先做一次小尺寸「校准」：模型在小尺寸下都复述不出随机串，
 *   说明该模型根本不适合做这个探针，此时**终止探测并如实报告**，不写入任何值。
 *
 * 凭据来源：只从进程环境变量取（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY），
 *          或显式 --token。**绝不读用户 settings.json 里的密钥，绝不打印密钥。**
 *
 * 用法：
 *   node probe-model.mjs                          # 零成本：打印当前解析结果
 *   node probe-model.mjs --json                   # 机器可读（供 hooks / policy.mjs 用）
 *   node probe-model.mjs --list                   # 列出全部画像
 *   node probe-model.mjs --record prompt-too-long # 被动学习：下调 25%
 *   node probe-model.mjs --record session-ok --turns 42
 *   node probe-model.mjs --record context-size --window 131072
 *   node probe-model.mjs --probe                  # 只打印预估请求数，不联网
 *   node probe-model.mjs --probe --yes            # 真的探测（消耗额度）
 *
 * 依赖：无（只用 node 内置模块 + 全局 fetch，Node ≥ 18）。
 * ============================================================
 */

import path from "node:path";
import {
  DEFAULT_HARNESS_ROOT,
  applySignal,
  autoCompactWindowFor,
  compactionThreshold,
  conservativeCap,
  raiseAllowed,
  endpointHost,
  listProfiles,
  loadTable,
  resolveCapability,
  sanitizeModelId,
  writeProfile,
  inspectUserSettings,
} from "./lib/model-capability.mjs";
import { FILES as LOG_FILES, appendJsonl, resolveLogRoot } from "./lib/log-center.mjs";

/**
 * 自主学习轨迹：每次上调 / 下调都记一行到**工作区根** `日志\08-模型\model-<日期>.jsonl`。
 * 为什么必须留：模型画像会随运行自动调参，事后必须能回答
 * 「这次窗口为什么变了、依据是什么、改前改后各是多少」—— 画像文件只有"现在"，没有"为什么"。
 */
function logModelSignal(args, r) {
  try {
    appendJsonl("model", LOG_FILES.model(), {
      ts: new Date().toISOString(),
      time: new Date().toISOString().replace("T", " ").slice(0, 19),
      source: "probe-model --record",
      signal: args.record,
      model: r?.profile?.model ?? null,
      endpoint: r?.profile?.endpoint ?? null,
      action: r?.action ?? null,
      windowBefore: r?.window ?? null,
      windowAfter: r?.profile?.effectiveWindow ?? null,
      autoCompactWindow: r?.profile?.autoCompactWindow ?? null,
      turns: args.turns ?? null,
      requestedWindow: args.window ?? null,
      profileFile: r?.file ?? null,
      changed: !!r?.file,
    }, { logRoot: resolveLogRoot() });
  } catch {
    /* fail-open */
  }
}

// ────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    json: false, list: false, help: false,
    model: null, endpoint: null, harnessRoot: DEFAULT_HARNESS_ROOT,
    record: null, turns: 0, window: null,
    estimate: false, probe: false, yes: false,
    start: null, max: null, bisect: null, maxOutput: 1024, timeout: 120000,
    baseUrl: null, token: null, insecureNoCache: false, allowRaise: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少值`);
      return v;
    };
    switch (a) {
      case "--json":            o.json = true; break;
      case "--list":            o.list = true; break;
      case "--model": case "-m":    o.model = next(); break;
      case "--endpoint": case "-e": o.endpoint = next(); break;
      case "--harness-root":        o.harnessRoot = path.resolve(next()); break;
      case "--record":              o.record = next(); break;
      case "--turns":               o.turns = Number(next()); break;
      case "--window":              o.window = Number(next()); break;
      case "--estimate": case "--dry-run": o.estimate = true; break;
      case "--probe":               o.probe = true; break;
      case "--calibrate":           o.calibrate = true; break;
      case "--yes": case "-y":      o.yes = true; break;
      case "--start":               o.start = Number(next()); break;
      case "--max":                 o.max = Number(next()); break;
      case "--bisect":              o.bisect = Number(next()); break;
      case "--max-output":          o.maxOutput = Number(next()); break;
      case "--timeout":             o.timeout = Number(next()); break;
      case "--base-url":            o.baseUrl = next(); break;
      case "--token":               o.token = next(); break;
      case "--no-cache-prefix":     o.insecureNoCache = true; break;
      case "--allow-raise":         o.allowRaise = true; break;
      case "--help": case "-h":     o.help = true; break;
      default: throw new Error(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  return o;
}

const USAGE = `probe-model.mjs —— 模型能力感知（默认零成本，只有 --probe 才会联网）

查看（不发请求）：
  node probe-model.mjs [--json] [--model <名>] [--endpoint <URL>]
  node probe-model.mjs --list

被动学习（不发请求，零成本）：
  node probe-model.mjs --record prompt-too-long
  node probe-model.mjs --record session-ok --turns 42
  node probe-model.mjs --record context-size --window 131072

主动探测（★ 消耗额度，必须显式 --yes）：
  node probe-model.mjs --probe                 # 只打印预估请求数，不联网
  node probe-model.mjs --probe --yes           # 真的打端点
  node probe-model.mjs --calibrate --yes       # 诊断：只发 1 次最小请求，打印原始响应结构
    可选：--start 65536  --max 524288  --bisect 4  --max-output 1024
          --base-url <URL>  --token <TOKEN>  --timeout 120000
          --allow-raise   允许探测结果把上限抬到保守值（102400）之上
    说明：--max-output 默认 1024，因为 thinking 型模型（如 deepseek-v4-flash）
          会先用思考块吃掉输出预算，给太小会导致正文一个字都吐不出来。
          --allow-raise 默认关闭：探测只证明「端点吞得下」，不证明「模型还清醒」。

凭据：默认从环境变量 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 取，绝不读取、绝不打印用户 settings.json 里的密钥。
`;

// ────────────────────────────────────────────────────────────
// 当前模型 / 端点推断
// ────────────────────────────────────────────────────────────

/** 只写了主机名时补协议：本机回环用 http，其余用 https。 */
function normalizeBaseUrl(raw) {
  const s = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(s) ? `http://${s}` : `https://${s}`;
}

function deriveContext(args) {
  const env = process.env;
  const user = inspectUserSettings();

  let model = args.model || env.ANTHROPIC_MODEL || null;
  let modelSource = args.model ? "--model" : (env.ANTHROPIC_MODEL ? "env.ANTHROPIC_MODEL" : null);
  if (!model && user.modelFields.length) {
    model = user.modelFields[0].value;
    modelSource = `~/.claude/settings.json (${user.modelFields[0].key})`;
  }
  if (!model) { model = "unknown-model"; modelSource = "未找到（按未知模型处理）"; }

  // --base-url 优先（它是"请求地址基址"），--endpoint 其次（可能只写了主机名）
  const endpointUrl = normalizeBaseUrl(args.baseUrl || args.endpoint || env.ANTHROPIC_BASE_URL || user.baseUrl || "");
  const ep = endpointHost(endpointUrl);

  const token = args.token
    || env.ANTHROPIC_AUTH_TOKEN
    || env.ANTHROPIC_API_KEY
    || null;
  const tokenSource = args.token ? "--token"
    : env.ANTHROPIC_AUTH_TOKEN ? "env.ANTHROPIC_AUTH_TOKEN"
    : env.ANTHROPIC_API_KEY ? "env.ANTHROPIC_API_KEY" : null;

  return { model, modelSource, endpointUrl, endpointHost: ep, token, tokenSource, user };
}

// ────────────────────────────────────────────────────────────
// 默认（零成本）输出
// ────────────────────────────────────────────────────────────

function renderResolve(ctx, r) {
  const c = r.capabilities;
  const srcLabel = {
    conservative: "③ 保守兜底（未知模型）",
    static: "① 静态表",
    profile: "② 画像文件（已学到）",
    "banned-override": "⚠️ 保守覆盖（[1M] 后缀的声明值不可信）",
    "banned-override+profile": "⚠️ 保守覆盖（有画像，但声明值不可信）",
    observed: "② 画像文件（引擎上报过窗口）",
  }[r.source] ?? r.source;
  const lines = [];
  lines.push("─".repeat(64));
  lines.push(`模型        ${r.declaredName}${c.hasBannedSuffix ? "   ⚠️ 带 [1M] 后缀" : ""}`);
  lines.push(`模型名归一化 ${r.modelId}`);
  lines.push(`端点        ${r.endpoint}`);
  lines.push(`能力来源    ${srcLabel}`);
  lines.push(`采信窗口    ${c.window} token`);
  if (c.declaredWindow !== c.window) {
    lines.push(`（引擎声明   ${c.declaredWindow} token —— 不可信，未采信）`);
  }
  lines.push("");
  lines.push(`★ autoCompactWindow = ${c.autoCompactWindow}`);
  lines.push(`   → 实际压缩阈值 ≈ ${c.compactionThreshold} token（= 窗口 − 33000）`);
  lines.push("");
  lines.push(`严格度      ${c.hookStrictness}  (instructionFollowing=${c.instructionFollowing})`);
  lines.push(`            ${c.hookStrictnessMeaning}`);
  lines.push(`能力位      toolUse=${c.supportsToolUse}  parallelTools=${c.supportsParallelTools}  ` +
             `cacheControl=${c.supportsCacheControl}  systemPrompt=${c.supportsSystemPrompt}  maxOutput=${c.maxOutputTokens}`);
  if (r.profileFile) lines.push(`画像文件    ${r.profileFile}${r.profile ? "" : "（不存在，尚未学习）"}`);
  if (r.notes.length) {
    lines.push("");
    lines.push("说明：");
    for (const n of r.notes) lines.push(`  · ${n}`);
  }
  lines.push("─".repeat(64));
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// 主动探测
// ────────────────────────────────────────────────────────────

const WORDS = ("harness probe context window token budget conservative baseline snapshot " +
  "prefix suffix needle marker echo repeat verify boundary bisect floor ceiling " +
  "stream buffer chunk offset stride anchor lattice quartz vector matrix delta " +
  "kernel policy guard quota shape compact handoff journal verify render").split(" ");

/** 惰性增长的确定性填充串（同一个字符串按长度切片 → 前缀可复用 → 命中端点前缀缓存）。 */
function makeFiller() {
  let s = "";
  let i = 0;
  return function ensure(nChars) {
    while (s.length < nChars) {
      s += `${WORDS[i % WORDS.length]}${i % 977} `;
      i++;
    }
    return s;
  };
}

function randomNeedle(len) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const normalize = (s) => String(s ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * 一次探测请求。
 *
 * ★ 探针为什么放「三个针」而不是一个（2026-09-11 补强）：
 *   只放开头一个针，只能测出「掐头」（把前面的内容丢掉）。
 *   如果端点是「丢中间」——head 和 tail 都留着、只砍中间那段 —— 一个针的探针
 *   会**误报成真支持**。这正是待实测确认 #3 要防的误判，所以把头/中/尾都放上。
 *
 * 内容布局：HEAD \n 填充上半 \n MID \n 填充下半 \n TAIL \n 指令
 * 指令要求模型**依次复述这三个标记**，缺哪个就说明哪一段被丢了。
 *
 * @returns {{kind, missing, truncationKind, ...}}
 */
async function probeOnce(cfg, targetTokens, filler, needle) {
  const chars = Math.max(64, Math.ceil(targetTokens / cfg.ratio));
  const mid = cfg.midNeedle;
  const tailNeedle = cfg.tailNeedle;
  const half = Math.floor(chars / 2);
  const buf = cfg.noCache ? makeFiller()(chars) : filler(chars);

  const content =
    `${needle}\n` +
    `${buf.slice(0, half)}\n${mid}\n${buf.slice(half)}\n` +
    `${tailNeedle}\n` +
    `请依次复述上面出现的三个标记（开头、中间、结尾各一个），用逗号分隔，` +
    `只输出这三个标记本身，不要输出别的任何内容。` +
    `如果某个位置你完全看不到标记，就在那个位置写 MISSING。`;

  const body = {
    model: cfg.requestModel,
    max_tokens: cfg.maxOutput,
    messages: [{ role: "user", content }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout);
  let res;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": cfg.token,
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === "AbortError" ? `请求超时（${cfg.timeout}ms）` : `网络错误：${err.message}`;
    return { kind: "TRANSPORT", detail: msg, targetTokens, chars };
  }
  clearTimeout(timer);

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 非 JSON 响应 */ }

  if (!res.ok) {
    const snippet = raw.slice(0, 300).replace(/\s+/g, " ");
    const looksLikeLength = /context|too\s*long|too\s*large|maximum|exceed|length|token/i.test(raw);
    return {
      kind: looksLikeLength ? "HARD_LIMIT" : "ERROR",
      status: res.status,
      detail: `HTTP ${res.status}：${snippet}`,
      targetTokens, chars,
    };
  }

  const ch = extractChannels(data, raw);
  const u = data?.usage ?? {};
  const inputTokens = Number(u.input_tokens ?? u.prompt_tokens ?? NaN);
  const cacheRead = Number(u.cache_read_input_tokens ?? 0) || 0;
  const cacheCreate = Number(u.cache_creation_input_tokens ?? 0) || 0;
  // Anthropic 协议里 input_tokens **不含**缓存命中部分，总量要三个加起来
  const totalInputTokens = Number.isFinite(inputTokens) ? inputTokens + cacheRead + cacheCreate : null;

  // ★ 判定"模型到底看到了哪几段"：
  //   正文里复述出来 → 最理想；
  //   只在 thinking 块里复述出来 → 同样证明它**看到了**（思考是模型自己生成的），算支持。
  //   这很重要：thinking 型模型会先吐思考块，正文可能被 max_tokens 挤掉。
  const haystack = normalize(ch.text) + "|" + normalize(ch.thinking);
  const seen = {
    head: haystack.includes(normalize(needle)),
    mid: haystack.includes(normalize(mid)),
    tail: haystack.includes(normalize(tailNeedle)),
  };
  const missing = Object.entries(seen).filter(([, v]) => !v).map(([k]) => k);
  const echoed = missing.length === 0;

  // 失败细分：丢开头 / 丢中间（最阴险）/ 只丢结尾
  let truncationKind = null;
  if (!echoed) {
    if (!seen.head && seen.mid && seen.tail) truncationKind = "HEAD_DROPPED";
    else if (seen.head && seen.tail && !seen.mid) truncationKind = "MIDDLE_DROPPED";
    else if (seen.head && !seen.tail) truncationKind = "TAIL_DROPPED";
    else truncationKind = "PARTIAL";
  }

  // 独立交叉验证：token 密度 = 服务端报的总输入 token ÷ 我方字符数。
  //
  // ⚠️ 这里踩过一次坑（2026-09-11 实测发现）：**不能**拿"校准请求算出的比例"去比大请求。
  //    小请求里那条中文指令占比很大，密度被抬到 0.245；大请求里它可忽略，真实密度 0.203。
  //    两者本来就不一样，拿它们相比会把正常情况误报成"截断证据"。
  //    真正能反映截断的信号是**密度相对上一个请求突然垮掉**（服务端开始丢内容），
  //    所以这里只算密度，比值交给调用方跟上一次比。
  const density = totalInputTokens ? totalInputTokens / chars : null;
  const expectedTokens = Math.round(chars * cfg.ratio);

  return {
    kind: echoed ? "SUPPORT" : "TRUNCATION",
    truncationKind,
    seen,
    missing,
    status: res.status,
    text: ch.text,
    thinking: ch.thinking,
    viaThinking: echoed && !normalize(ch.text).includes(normalize(needle)),
    stopReason: data?.stop_reason ?? data?.choices?.[0]?.finish_reason ?? null,
    rawSnippet: raw.slice(0, 800),
    bodyShape: data
      ? `顶层键：${Object.keys(data).join(", ")}` +
        (Array.isArray(data.content) ? `；content[].type = ${data.content.map((b) => b?.type ?? typeof b).join("/")}` : "") +
        `；stop_reason=${data.stop_reason ?? "-"}`
      : "（响应不是 JSON）",
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    cacheRead, cacheCreate, totalInputTokens,
    expectedTokens, density,
    targetTokens, chars,
    needle, midNeedle: mid, tailNeedle,
  };
}

/**
 * 把响应拆成「正文」与「思考」两个通道。
 * 实测（2026-09-11，api.deepseek.com/anthropic）：deepseek-v4-flash 会先吐
 * `content[].type === "thinking"` 的思考块；只读 text 会把回复看成空串。
 */
function extractChannels(data, raw) {
  if (!data) return { text: raw.slice(0, 2000), thinking: "" };
  if (Array.isArray(data.content)) {
    const pick = (t) => data.content
      .filter((b) => (b?.type ?? "text") === t)
      .map((b) => (typeof b === "string" ? b : b?.text ?? b?.thinking ?? ""))
      .join("");
    return { text: pick("text"), thinking: pick("thinking") };
  }
  const choice = data.choices?.[0];
  if (choice) {
    return {
      text: String(choice.message?.content ?? choice.text ?? ""),
      thinking: String(choice.message?.reasoning_content ?? ""),
    };
  }
  return { text: "", thinking: "" };
}

async function runProbe(args, ctx) {
  const { table } = loadTable(args.harnessRoot);
  const p = table.probe ?? {};
  const startTokens = args.start ?? Number(p.startTokens ?? 65536);
  const maxTokens = args.max ?? Number(p.maxTokens ?? 1048576);
  const bisectRounds = args.bisect ?? Number(p.bisectRounds ?? 4);
  const needleLen = Number(p.needleLength ?? 32);
  const safety = Number(p.safetyFactor ?? 0.8);
  // 扩张循环的硬上限（正常会提前 break，这只是防死循环）
  const expansions = Math.ceil(Math.log2(maxTokens / startTokens)) + 2;

  // ---- 1. 预估（--probe 且没有 --yes 时只做这一步，绝不联网）----
  /** 按「假设真实窗口 = w」估算：扩张阶段打到 w 之后失败，再在 [w, 2w] 里二分。 */
  function estimateFor(w) {
    const sizes = [];
    let s = startTokens;
    for (let i = 0; i < 24; i++) {
      sizes.push(s);
      if (s >= w) break;
      s = Math.min(maxTokens, s * 2);
      if (s >= maxTokens) { sizes.push(maxTokens); break; }
    }
    const hitCeiling = sizes[sizes.length - 1] >= maxTokens && w >= maxTokens;
    const bisect = hitCeiling ? 0 : bisectRounds;
    const input = sizes.reduce((a, b) => a + b, 0) + bisect * Math.round(w * 1.5);
    return {
      requests: 1 /*校准*/ + sizes.length + bisect + 1 /*余量*/,
      inputTokens: Math.round(input),
      hitCeiling,
    };
  }

  const staticEntry = resolveCapability({
    harnessRoot: args.harnessRoot, modelName: ctx.model,
    endpoint: ctx.endpointUrl || ctx.endpointHost,
  });
  const typicalWindow = Math.max(startTokens, Number(staticEntry.resolvedWindow || 131072));
  const typical = estimateFor(typicalWindow);
  const worst = estimateFor(maxTokens);
  const soft = Math.round(typical.inputTokens * 0.4);
  const hard = Math.round(worst.inputTokens * 0.4);

  if (args.estimate || !args.yes) {
    const out = [];
    out.push("主动探测预估（尚未发出任何请求）");
    out.push("─".repeat(64));
    out.push(`模型        ${ctx.model}（请求时用 ${ctx.model.replace(/\[1m\]/gi, "").trim()}）`);
    out.push(`端点        ${ctx.endpointUrl || "(未配置)"} → ${ctx.url}`);
    out.push(`凭据        ${ctx.tokenSource ? `已取到（${ctx.tokenSource}，长度 ${ctx.token.length}，不打印）` : "⚠️ 未找到凭据，无法执行"}`);
    out.push("");
    out.push(`预估请求数  ${Math.min(typical.requests, worst.requests)}–${Math.max(typical.requests, worst.requests)} 次`);
    out.push(`  · 1 次校准（小尺寸，先验证模型能复述随机串，不通过就终止）`);
    out.push(`  · 逐级翻倍扩张：${startTokens} → ${Math.min(maxTokens, typicalWindow * 2)} 左右`);
    out.push(`  · ${bisectRounds} 次二分收窄 + 1 次余量`);
    out.push(`输入规模    典型 ≈ ${(typical.inputTokens / 10000).toFixed(0)} 万 token；` +
             `最坏 ≈ ${(worst.inputTokens / 10000).toFixed(0)} 万 token`);
    out.push(`输出规模    每次 max_tokens=${args.maxOutput}（很小）`);
    out.push(`计费提示    填充串前缀在各次请求间复用 → 端点若支持前缀缓存，实际计费约 ${(soft / 10000).toFixed(0)}–${(hard / 10000).toFixed(0)} 万 token 的量级`);
    out.push("");
    out.push("这只是预估，本命令**没有发出任何网络请求**。");
    out.push("要真的执行，请确认预估后加 --yes 重跑：");
    out.push(`  node probe-model.mjs --probe --yes`);
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  }

  if (!ctx.token) {
    process.stderr.write("[probe] 未找到凭据。请设置 ANTHROPIC_AUTH_TOKEN，或用 --token 传入。\n" +
      "[probe] 注意：本工具不会读取也不会打印你 settings.json 里的密钥。\n");
    return 1;
  }

  // ---- 2. 真正探测 ----
  const cfg = {
    url: ctx.url,
    token: ctx.token,
    requestModel: ctx.model.replace(/\[1m\]/gi, "").trim() || ctx.model,
    maxOutput: args.maxOutput,
    timeout: args.timeout,
    ratio: 0.25,           // 先按 ASCII 经验值，校准后修正
    noCache: args.insecureNoCache,
  };
  const filler = makeFiller();
  const needle = randomNeedle(needleLen);
  cfg.midNeedle = randomNeedle(needleLen);
  cfg.tailNeedle = randomNeedle(needleLen);
  const log = [];
  let requests = 0;

  const say = (s) => { log.push(s); process.stderr.write(s + "\n"); };
  const tagOf = (r) => {
    if (r.kind === "SUPPORT") return "真支持（头/中/尾三个针都复述出来了）";
    if (r.kind === "TRUNCATION") {
      const m = { HEAD_DROPPED: "掐头（开头被丢）", MIDDLE_DROPPED: "★丢中间（最阴险）",
                  TAIL_DROPPED: "丢结尾", PARTIAL: "部分丢失" }[r.truncationKind] ?? r.truncationKind;
      return `静默截断：${m} —— 缺失 [${r.missing.join(",")}]`;
    }
    return r.kind;
  };

  // --- 第 0 步：校准（验证「模型在小尺寸下能复述三个针」）---
  say(`[probe] 第 0 步：校准探针（3 个随机串，各 ${needleLen} 字符：头 ${needle.slice(0, 6)}… 中 ${cfg.midNeedle.slice(0, 6)}… 尾 ${cfg.tailNeedle.slice(0, 6)}…）`);
  const calChars = 4000;
  const cal = await probeOnce(cfg, Math.ceil(calChars * cfg.ratio), filler, needle);
  requests++;
  if (cal.kind !== "SUPPORT") {
    process.stderr.write(
      `\n[probe] ❌ 校准失败：模型在 ${calChars} 字符的小尺寸下都没能复述出全部三个针（${tagOf(cal)}）。\n` +
      `[probe] 这说明「探针设计在该模型上不成立」——按 06-待实测确认.md 的要求，此时必须终止，\n` +
      `[probe] 不能把结果当成窗口值写进画像。\n` +
      `[probe] 三个针（模型本应复述出来的）：头=${needle} 中=${cfg.midNeedle} 尾=${cfg.tailNeedle}\n` +
      `[probe] HTTP 状态：${cal.status ?? "-"}\n` +
      `[probe] 响应结构：${cal.bodyShape ?? "-"}\n` +
      `[probe] 抽出的文本：${JSON.stringify(String(cal.text ?? "").slice(0, 300))}\n` +
      `[probe] 原始响应片段：${String(cal.rawSnippet ?? cal.detail ?? "").slice(0, 800)}\n` +
      `[probe] 想看完整诊断（只花 1 次最小请求）：node probe-model.mjs --calibrate --yes\n`
    );
    return 1;
  }
  if (cal.totalInputTokens) {
    // 用服务端报的真实 token 数修正「token/字符」比例（input_tokens 不含缓存命中，要三个加起来）
    cfg.ratio = Math.max(0.05, cal.totalInputTokens / cal.chars);
    say(`[probe] 校准通过：三个针全部复述正确。服务端报 total input=${cal.totalInputTokens}` +
        `（new ${cal.inputTokens ?? "-"} + cache_read ${cal.cacheRead} + cache_create ${cal.cacheCreate}）` +
        ` / ${cal.chars} 字符 → 比例 ${cfg.ratio.toFixed(3)}`);
  } else {
    say("[probe] 校准通过：三个针全部复述正确。（端点未返回 usage，沿用经验比例 0.25）");
  }

  // --- 第 1 步：扩张，找到「好/坏」的上下界 ---
  let lowerOk = null;   // 最大的「真支持」尺寸
  let upperBad = null;  // 最小的「不支持」尺寸
  let failureMode = null; // HARD_LIMIT | TRUNCATION
  let truncationKind = null;
  let lastOkTokens = null;
  let prevDensity = null;   // 上一次请求的 token 密度（二级截断网的参照）
  let size = startTokens;
  let first = true;

  for (let i = 0; i < expansions + 2; i++) {
    const r = await probeOnce(cfg, size, filler, needle);
    requests++;
    // 二级网：密度相对上一个请求明显垮掉 = 服务端开始丢内容（即便针侥幸还在）
    const densityDrop = (r.density !== null && prevDensity !== null) ? r.density / prevDensity : null;
    const cross = densityDrop !== null && densityDrop < 0.85
      ? `  ⚠️ token 密度从上一次的 ${prevDensity.toFixed(3)} 掉到 ${r.density.toFixed(3)}（比值 ${densityDrop.toFixed(2)}）—— 疑似截断`
      : "";
    if (r.density !== null) prevDensity = r.density;
    say(`[probe]   ${size} token → ${tagOf(r)}` +
        (r.totalInputTokens ? `（total input=${r.totalInputTokens}，密度 ${r.density?.toFixed(3)}）` : "") + cross);

    if (r.kind === "TRANSPORT" || r.kind === "ERROR") {
      process.stderr.write(`\n[probe] ❌ 探测中断：${r.detail}\n[probe] 不写入任何画像值（避免把错误当成能力结论）。\n`);
      return 1;
    }
    if (r.kind === "SUPPORT") {
      lowerOk = size;
      lastOkTokens = r.totalInputTokens;
      first = false;
      if (size >= maxTokens) { say(`[probe]   已达探测上限 ${maxTokens}，停止扩张`); break; }
      size = Math.min(maxTokens, size * 2);
      continue;
    }
    // 不支持（硬报错或静默截断）
    upperBad = size;
    failureMode = r.kind;
    truncationKind = r.truncationKind ?? null;
    if (first) {
      // 起始点就已经不支持 → 往下退
      if (size <= 4096) {
        process.stderr.write(`\n[probe] ❌ 连 ${size} token 都不支持，无法给出可信结论。\n`);
        return 1;
      }
      size = Math.max(4096, Math.floor(size / 2));
      first = false;
      continue;
    }
    break;
  }

  // --- 第 2 步：二分收窄 ---
  if (lowerOk !== null && upperBad !== null && upperBad > lowerOk + 4096) {
    let lo = lowerOk, hi = upperBad;
    for (let i = 0; i < bisectRounds; i++) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid <= lo || mid >= hi) break;
      const r = await probeOnce(cfg, mid, filler, needle);
      requests++;
      say(`[probe]   二分 ${mid} token → ${tagOf(r)}` +
          (r.totalInputTokens ? `（total input=${r.totalInputTokens}）` : ""));
      if (r.kind === "SUPPORT") { lo = mid; lastOkTokens = r.totalInputTokens; }
      else { hi = mid; failureMode = r.kind; truncationKind = r.truncationKind ?? null; }
      lowerOk = lo; upperBad = hi;
    }
  }

  if (lowerOk === null) {
    process.stderr.write("\n[probe] ❌ 没有找到任何「真支持」的尺寸，无法给出结论。\n");
    return 1;
  }

  // --- 第 3 步：安全系数 + 落盘 ---
  const measured = lowerOk;
  const effective = Math.max(32768, Math.round(measured * safety));
  const mapped = autoCompactWindowFor(effective, table);
  const cap = conservativeCap(table);
  const allowRaise = raiseAllowed(table, args.allowRaise);
  const autoCompact = allowRaise ? mapped : Math.min(mapped, cap);
  const withheld = autoCompact < mapped;
  const now = new Date().toISOString();

  const modelId = sanitizeModelId(ctx.model);
  const profile = {
    model: modelId,
    declaredName: ctx.model,
    endpoint: ctx.endpointHost,
    declaredWindow: /\[1m\]/i.test(ctx.model) ? Number(table?.bannedSuffix?.declaredWindow ?? 1000000) : null,
    measuredWindow: measured,
    effectiveWindow: effective,
    autoCompactWindow: autoCompact,
    // 钉住：免得被动学习事后按弱证据把它抬上去
    autoCompactWindowPinned: withheld,
    maxOutputTokens: table?.defaults?.maxOutputTokens ?? 8192,
    supportsToolUse: table?.defaults?.supportsToolUse ?? true,
    supportsParallelTools: table?.defaults?.supportsParallelTools ?? false,
    supportsCacheControl: table?.defaults?.supportsCacheControl ?? true,
    supportsSystemPrompt: table?.defaults?.supportsSystemPrompt ?? true,
    instructionFollowing: table?.defaults?.instructionFollowing ?? 0.4,
    hookStrictness: "strict",
    probeResult: {
      measuredWindow: measured,
      upperBadWindow: upperBad,
      failureMode,
      truncationKind,
      failureModeMeaning: failureMode === "TRUNCATION"
        ? `静默截断（${{
            HEAD_DROPPED: "掐头：丢掉了开头那段",
            MIDDLE_DROPPED: "丢中间：头尾都在，中间被砍 —— 只放一个开头针的探针测不出来这种",
            TAIL_DROPPED: "丢结尾",
            PARTIAL: "部分内容丢失",
          }[truncationKind] ?? truncationKind}）：超限不报错，直接丢内容`
        : failureMode === "HARD_LIMIT"
          ? "硬报错：超限时端点明确返回错误"
          : "未触达上限（探测封顶，未观测到失败）",
      probeDesign: "三针探针（头/中/尾各一个 32 字符随机串），三个都复述正确才算真支持；缺哪个会报出 HEAD_DROPPED / MIDDLE_DROPPED / TAIL_DROPPED",
      observedTotalInputTokens: lastOkTokens,
      mappingWouldSuggest: mapped,
      conservativeCap: cap,
      raiseWithheld: withheld,
      raiseWithheldReason: withheld
        ? "探测只证明端点吞得下，不证明模型在该尺寸下还保持清醒（事故表症是 78 万时模型退化，端点并不报错）。" +
          "按 conservative.raiseRequiresOptIn=true 夹在保守值；要放开用 --probe --allow-raise 或改表。"
        : null,
      requests,
      safetyFactor: safety,
      probeDate: now,
    },
    evidence: [
      {
        date: now.slice(0, 10),
        signal: `主动探测 ${requests} 次请求（三针探针）`,
        action: `真支持到 ${measured} token；${upperBad ?? "未触达上限"} 处失败（${failureMode ?? "无"}）` +
                `${truncationKind ? `/${truncationKind}` : ""}` +
                `→ 乘安全系数 ${safety} 得 ${effective} → 映射建议 ${mapped}` +
                (withheld ? `，但被保守上限 ${cap} 夹住 → autoCompactWindow=${autoCompact}` : `→ autoCompactWindow=${autoCompact}`),
      },
    ],
    source: "probe",
    lastUpdated: now,
  };

  const file = writeProfile(args.harnessRoot, profile);

  const out = [];
  out.push("");
  out.push("主动探测完成");
  out.push("─".repeat(64));
  out.push(`真支持窗口    ${measured} token（二分下界，头/中/尾三个针都复述正确才算数）`);
  out.push(`失败位置      ${upperBad ?? "未触达（探测封顶）"} token —— ${profile.probeResult.failureModeMeaning}`);
  out.push(`   ★ 这一行就是「待实测项 #3」的结论来源：失败是报错、掐头、还是丢中间，看这里。`);
  out.push(`安全系数      ×${safety}  →  采信窗口 ${effective} token`);
  if (withheld) {
    out.push(`映射会建议    autoCompactWindow = ${mapped}`);
    out.push(`★ 但按保守上限夹住 → autoCompactWindow = ${autoCompact}（阈值 ≈ ${compactionThreshold(autoCompact, table)}）`);
    out.push(`   理由：探测只证明「端点吞得下」，不证明「模型还清醒」。测量值已存进画像备查。`);
    out.push(`   要放开这一夹：在 模型能力表.json 里把 conservative.raiseRequiresOptIn 改成 false，`);
    out.push(`                 或重跑 node probe-model.mjs --probe --yes --allow-raise`);
  } else {
    out.push(`★ autoCompactWindow = ${autoCompact}（压缩阈值 ≈ ${compactionThreshold(autoCompact, table)}）`);
  }
  out.push(`请求数        ${requests} 次`);
  out.push(`画像已写入    ${file}`);
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

// ────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + "\n"); return 0; }

  // ---- --list ----
  if (args.list) {
    const { dir, profiles } = listProfiles(args.harnessRoot);
    process.stdout.write(`画像目录：${dir}\n`);
    if (!profiles.length) {
      process.stdout.write("（还没有任何画像 —— 未探测过的模型一律走保守值 102400）\n");
      return 0;
    }
    for (const p of profiles) {
      process.stdout.write(
        `· ${p.endpoint}-${p.model}  source=${p.source ?? "?"}  window=${p.effectiveWindow ?? "?"}  ` +
        `autoCompactWindow=${p.autoCompactWindow ?? "?"}  strictness=${p.hookStrictness ?? "?"}\n`
      );
    }
    return 0;
  }

  const ctx = deriveContext(args);
  // 端点 URL → 请求地址（Anthropic 兼容端点：<base>/v1/messages）
  ctx.url = ctx.endpointUrl
    ? `${String(ctx.endpointUrl).replace(/\/+$/, "")}/v1/messages`
    : "(未配置)";

  // ---- --calibrate：只发 1 次最小请求的诊断（默认也需要 --yes）----
  if (args.calibrate) {
    if (!args.yes) {
      process.stdout.write(
        "诊断模式会发出 1 次最小请求（约 4000 字符填充 ≈ 1000 token 输入 + 少量输出）。\n" +
        "确认后加 --yes 重跑：node probe-model.mjs --calibrate --yes\n"
      );
      return 0;
    }
    if (!ctx.token) {
      process.stderr.write("[probe] 未找到凭据（设置 ANTHROPIC_AUTH_TOKEN 或用 --token）。\n");
      return 1;
    }
    const model = ctx.model.replace(/\[1m\]/gi, "").trim() || ctx.model;
    const cfg = {
      url: ctx.url, token: ctx.token, requestModel: model,
      maxOutput: args.maxOutput, timeout: args.timeout, ratio: 0.25, noCache: false,
      midNeedle: randomNeedle(32), tailNeedle: randomNeedle(32),
    };
    const needle = randomNeedle(32);
    const filler = makeFiller();
    const r = await probeOnce(cfg, Math.ceil(4000 * cfg.ratio), filler, needle);
    process.stdout.write([
      "主动探测 · 校准诊断（只发了这 1 次请求）",
      "─".repeat(64),
      `请求地址     ${ctx.url}`,
      `请求模型     ${model}（max_tokens=${args.maxOutput}）`,
      `三针        头=${needle}`,
      `            中=${cfg.midNeedle}`,
      `            尾=${cfg.tailNeedle}`,
      `HTTP 状态    ${r.status ?? "-"}`,
      `判定结果     ${r.kind}${r.truncationKind ? `（${r.truncationKind}）` : ""}`,
      `各针是否复述 头=${r.seen?.head} 中=${r.seen?.mid} 尾=${r.seen?.tail}`,
      `响应结构     ${r.bodyShape ?? "-"}`,
      `服务端用量   new=${r.inputTokens ?? "-"} cache_read=${r.cacheRead} cache_create=${r.cacheCreate} total=${r.totalInputTokens ?? "-"}`,
      `             chars=${r.chars}（我方估算 ≈${r.expectedTokens} token，实际/估算 = ${r.shortfallRatio?.toFixed(3) ?? "-"}）`,
      `抽出文本     ${JSON.stringify(String(r.text ?? "").slice(0, 400))}`,
      "",
      "原始响应（前 800 字符）：",
      String(r.rawSnippet ?? r.detail ?? "(空)"),
      "─".repeat(64),
    ].join("\n") + "\n");
    return r.kind === "SUPPORT" ? 0 : 1;
  }

  // ---- --record：被动学习（零成本，不发请求）----
  if (args.record) {
    const r = applySignal({
      harnessRoot: args.harnessRoot,
      modelName: ctx.model,
      endpoint: ctx.endpointUrl || ctx.endpointHost,
      signal: args.record,
      turns: args.turns,
      window: args.window ?? undefined,
    });
    process.stdout.write(
      `[probe] 被动学习 · 模型 ${r.profile.model} · 端点 ${r.profile.endpoint}\n` +
      `[probe] 动作：${r.action}\n` +
      `[probe] 采信窗口 ${r.window} → autoCompactWindow ${r.profile.autoCompactWindow}\n` +
      (r.file ? `[probe] 画像已更新：${r.file}\n` : `[probe] 无变化，未写盘。\n`)
    );
    logModelSignal(args, r); // 第 2 段（日志中心 · 08-模型）
    return 0;
  }

  // ---- --probe / --estimate ----
  if (args.probe || args.estimate) {
    return await runProbe(args, ctx);
  }

  // ---- 默认：零成本解析报告 ----
  const r = resolveCapability({
    harnessRoot: args.harnessRoot,
    modelName: ctx.model,
    endpoint: ctx.endpointUrl || ctx.endpointHost,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify({
      model: r.modelId,
      declaredName: r.declaredName,
      endpoint: r.endpoint,
      source: r.source,
      resolvedWindow: r.resolvedWindow,
      autoCompactWindow: r.autoCompactWindow,
      capabilities: r.capabilities,
      notes: r.notes,
      profileFile: r.profileFile,
      modelFrom: ctx.modelSource,
      endpointUrl: ctx.endpointUrl || null,
      tableFile: r.tableFile,
    }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(renderResolve(ctx, r) + "\n");
  process.stdout.write(
    `模型来源    ${ctx.modelSource}\n` +
    `端点来源    ${ctx.endpointUrl || "(未配置)"}\n` +
    `本命令零成本，未发出任何网络请求。要主动探测请用 --probe（会先报预估）。\n`
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  process.stderr.write(`[probe-model] 出错：${err.message}\n`);
  process.exitCode = 1;
}
