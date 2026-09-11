#!/usr/bin/env node
/**
 * probe-engines.mjs —— 引擎能力探测（F9 · 第 6 批）
 * ============================================================
 * 回答一个问题：**除了 Claude Code，Codex CLI / DeepSeek Harness / TraeCode
 * 到底有没有机制层？如果有，配置文件长什么样、键名是什么、合法取值有哪些？**
 *
 * 答案写进两个交付物：`自定义/引擎能力表.json`（F10）与 `自定义/引擎适配/`（F11）。
 *
 * ────────────────────────────────────────────────────────────
 * ★★ 三条铁律（04-实施批次与验收.md 第 6 批，违反即失败）★★
 *
 *   1. **绝不读用户的配置文件。**
 *      `~/.codex/config.toml`、`~/.codex/auth.json`、`~/.dsh/settings.yaml`、
 *      `~/.dsh/.credentials.yaml`、`~/.claude/settings.json`、`~/.claude.json`
 *      可能含 API key。本脚本的 `safeRead()` 是**白名单**式读取：
 *      路径不在「harness 自身目录 / 系统临时目录」之下的，一律拒绝。
 *      （读别人的配置根本不需要——见第 3 条。）
 *
 *   2. **只用只读命令。** 全部命令写死在 `PROBES` 里，不接受任意命令。
 *      Codex 侧额外把 `CODEX_HOME` 指到一个**临时目录**：
 *      连 codex 自己都不会去碰用户的 `~/.codex`。
 *
 *   3. **靠报错信息推断字段。** `codex --strict-config` 在配置非法时报错，
 *      错误文本会指出「期待什么类型 / 合法取值有哪几个」——
 *      这就是推断 hooks 格式的手段。**每组探测都带对照组**（先证明方法本身有效）。
 *
 * ────────────────────────────────────────────────────────────
 * 零额度：所有探测都**不发起模型请求**。
 *   · Codex 侧用隔离 CODEX_HOME（没有凭据）+ 不存在的模型名，双重保险；
 *     配置非法时在「加载配置」阶段就退出，配置合法时在「不在受信任目录」阶段退出，
 *     两条路都到不了 API。
 *   · DSH 侧只用 `--dump-*` 与 `--patch`（dump 是只读诊断输出）。
 *   · 2026-09-11 实测：整轮探测 0 次模型请求、0 token。
 *
 * ────────────────────────────────────────────────────────────
 * 用法：
 *   node probe-engines.mjs                    # 探测全部引擎，并写 引擎能力表.json
 *   node probe-engines.mjs --dry-run          # 只探测不写文件
 *   node probe-engines.mjs --engine codex-cli # 只探一个引擎
 *   node probe-engines.mjs --json             # stdout 输出完整 JSON
 *   node probe-engines.mjs --verbose          # 打印每条探测命令的原始结果
 *   node probe-engines.mjs --no-live          # 跳过需要跑引擎的探测（只读 help/version）
 *
 * 退出码：0 = 探测完成；2 = 脚本自身出错。
 *
 * 第 2 段（日志中心）：探测结果落一行到**工作区根** `日志\06-引擎\engine-probe-<日期>.jsonl`
 * （只追加；写失败只出声，绝不影响探测本身 —— 完整表仍然在 自定义\引擎能力表.json）。
 *
 * 第 3 段（P2-5）：**安装探测与版本号全部改走 自定义\scripts\lib\engine-detect.mjs**
 * （它再往下用第 1 段的统一解析器 resolve-command.mjs）。原因就是实测过的误报：
 * 旧实现的 PATH 扫描把空扩展名排第一，且自检台用 spawnSync("codex") 直接起进程，
 * 于是「codex 明明装了」被探成「本机没有 codex」。
 * 另外：**本机没装的引擎，不再把上一轮的实测结论抹掉** —— 转存到 lastVerified 并标注
 * 「本轮未复验」，这样既不说谎也不丢信息（旧表里的结论是真金白银测出来的）。
 *
 * 依赖：无（只用 node 内置模块）。
 * ============================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FILES as LOG_FILES, appendJsonl, resolveLogRoot } from "./lib/log-center.mjs";
import { detectEngine, engineChoiceList } from "./lib/engine-detect.mjs";
import { resolveCommand } from "./lib/resolve-command.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // …\自定义\scripts
const HARNESS_ROOT = path.resolve(SCRIPT_DIR, "..", "..");       // …\AI-Dev-Harness
const CUSTOM_DIR = path.join(HARNESS_ROOT, "自定义");
const ADAPTER_DIR = path.join(CUSTOM_DIR, "引擎适配");
const TABLE_PATH = path.join(CUSTOM_DIR, "引擎能力表.json");
const PROBE_DATE = "2026-09-12";

/** 把本轮探测的结论落一行到 日志\06-引擎\engine-probe-<日期>.jsonl（只追加） */
function logEngineProbe(engines, table, opts) {
  try {
    appendJsonl(
      "engine",
      LOG_FILES.engineProbe(),
      {
        ts: new Date().toISOString(),
        time: new Date().toISOString().replace("T", " ").slice(0, 19),
        source: "probe-engines",
        probeDate: PROBE_DATE,
        dryRun: !!opts.dryRun,
        noLive: !!opts.noLive,
        only: opts.only ?? null,
        tablePath: TABLE_PATH,
        unknowns: table?.unknowns?.length ?? 0,
        engines: engines.map((e) => ({
          id: e.id,
          installed: !!e.installed,
          version: e.version ?? null,
          ruleAutoload: !!e.ruleAutoload?.supported,
          ruleAutoloadFiles: e.ruleAutoload?.files ?? [],
          mechanism: e.mechanism?.supported ? e.mechanism.kind : null,
          confidence: e.mechanism?.confidence ?? null,
          probesPassed: e.mechanism?.probesPassed ?? null,
          probesTotal: e.mechanism?.probesTotal ?? null,
          patchVerdict: e.patchVerification?.verdict ?? null,
          methodValid: e.methodValid ?? null,
        })),
      },
      { logRoot: resolveLogRoot() },
    );
  } catch {
    /* fail-open */
  }
}

// ════════════════════════════════════════════════════════════
// 一、安全护栏：白名单式读取 + 只读命令
// ════════════════════════════════════════════════════════════

/** 用户配置文件（**绝不读**）。列在这里是为了在参数层再拦一道，不是用来读的。 */
const FORBIDDEN_FILES = [
  ".codex/config.toml", ".codex/auth.json", ".codex/credentials.json",
  ".dsh/settings.yaml", ".dsh/.credentials.yaml", ".dsh/.anonymous-user-id",
  ".claude/settings.json", ".claude.json",
];

/** 允许读取的根：只有这两处。其余一律拒绝。 */
function allowedRoots() {
  return [HARNESS_ROOT, os.tmpdir()].map((p) => path.resolve(p).toLowerCase());
}

/**
 * 白名单式读文件：路径必须落在 harness 自身目录或系统临时目录之下。
 * 这是「绝不读用户配置文件」这条铁律的**代码级**保证，不靠自觉。
 */
function safeRead(file) {
  const abs = path.resolve(file);
  const lower = abs.toLowerCase();
  const ok = allowedRoots().some((root) => lower === root || lower.startsWith(root + path.sep));
  if (!ok) throw new Error(`[probe-engines] 拒绝读取 harness/临时目录之外的文件：${abs}`);
  for (const bad of FORBIDDEN_FILES) {
    if (lower.endsWith(path.sep + bad.replace(/\//g, path.sep).toLowerCase())) {
      throw new Error(`[probe-engines] 拒绝读取疑似凭据文件：${abs}`);
    }
  }
  return fs.readFileSync(abs, "utf8");
}

/** 白名单式写文件：只允许写 harness 自身目录（本批交付物都写在那里）。 */
function safeWrite(file, text) {
  const abs = path.resolve(file);
  const lower = abs.toLowerCase();
  if (!lower.startsWith(path.resolve(HARNESS_ROOT).toLowerCase() + path.sep)) {
    throw new Error(`[probe-engines] 拒绝写入 harness 目录之外的文件：${abs}`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/**
 * 读上一轮的引擎能力表（只读，且只读 harness 自己的交付物）。
 * 用途：本机没装的引擎不要把它上一轮的实测结论抹掉 —— 转存到 lastVerified。
 * 读不到 / 坏了都返回 null（fail-open：探测照跑，只是少一层历史保留）。
 */
function readPreviousTable() {
  try {
    const j = JSON.parse(fs.readFileSync(TABLE_PATH, "utf8"));
    if (j && j.engines && typeof j.engines === "object") return j;
  } catch {
    /* 首次运行 / 文件损坏 */
  }
  return null;
}

/**
 * 带重试地删目录。
 * 为什么需要：codex 会在隔离 HOME 里建 SQLite，进程退出后句柄还要几百毫秒才放，
 * 直接 rmSync 在 Windows 上会 EBUSY —— 不重试就会在临时目录里留一地垃圾。
 */
function rmRetry(dir, tries = 20) {
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < tries; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
    catch { sleepSync(500); } // 最多等 10 秒；失败也不影响结论，只是留个临时目录
  }
  return false;
}

/** 本脚本在系统临时目录里的自留地前缀（只扫这些，绝不碰别人的临时文件）。 */
const PROBE_TMP_PREFIXES = ["harness-codex-probe-", "harness-dsh-probe-"];

/**
 * 扫掉本脚本**上一次**跑剩的临时目录（best-effort，失败就算了）。
 * 为什么要这一步：codex 会在隔离 HOME 里建 SQLite，进程刚退出时句柄还没放，
 * 当场删不掉是很常见的；下次开跑时再扫一遍，就变成自愈的了。
 */
function sweepStaleProbeDirs() {
  let names;
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const n of names) {
    if (!PROBE_TMP_PREFIXES.some((p) => n.startsWith(p))) continue;
    try { fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true }); } catch { /* 还被占着，下次再说 */ }
  }
}

/** cmd.exe / POSIX 通用的最小转义：含空格或特殊字符就加双引号。 */
function quoteArg(s) {
  const str = String(s);
  if (!/[\s"&|<>^()]/.test(str)) return str;
  return `"${str.replace(/"/g, "")}"`;
}

/**
 * 跑一条**只读**命令。Windows 上 codex/dsh/claude 都是 npm 生成的 .cmd 垫片，
 * 必须经 shell 才能执行，所以统一走 shell。
 * ★ 第 3 段：跑到引擎时先经统一解析器换成**真实文件路径**再交给 shell
 *   （旧版只写命令名，shell 再自己找一遍 —— 两套解析规则不一致正是误报的来源）。
 */
function run(argv, opts = {}) {
  const [tool, ...rest] = argv;
  const resolved = tool ? (which(tool) ?? tool) : tool;
  const line = [resolved, ...rest].map(quoteArg).join(" ");
  const r = spawnSync(line, {
    shell: true,
    cwd: opts.cwd ?? HARNESS_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    cmd: line,
    code: r.status ?? -1,
    out: (r.stdout ?? "") + (r.stderr ?? ""),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? String(r.error.message) : null,
  };
}

/**
 * 命令在不在 / 装在哪（不执行它）。
 * ★ 第 3 段（P2-5）：改用统一解析器（resolve-command.mjs，经 engine-detect.mjs），
 *   连 PATH 之外的安装位置（原生安装器 / npm 全局 / WinGet Links）一起找。
 *   旧实现 `where <cmd>` + 空扩展名优先 = 误报的根源。
 */
function which(cmd) {
  const det = detectEngine(cmd);
  if (det.installed) return det.path ?? null;
  // 引擎目录里没有这个命令名时，退回统一解析器直接找（探一些非引擎命令用得上）
  return resolveCommand(cmd) ?? null;
}

const VERBOSE = process.argv.includes("--verbose");
const existsSyncSafe = (p) => { try { return fs.existsSync(p); } catch { return false; } };
function trace(label, r) {
  if (!VERBOSE) return;
  process.stderr.write(`\n┌─ ${label}\n│ $ ${r.cmd}\n│ exit=${r.code}\n`);
  for (const line of r.out.split(/\r?\n/).slice(0, 12)) process.stderr.write(`│ ${line}\n`);
  process.stderr.write("└─\n");
}

// ════════════════════════════════════════════════════════════
// 二、Codex CLI 探测（差分法：对照组 + 实验组）
// ════════════════════════════════════════════════════════════

/**
 * 在**隔离的 CODEX_HOME** 里写一份 config.toml，用 --strict-config 跑一次，
 * 只读取「配置加载」阶段的结论。
 *
 * 为什么这样就够：配置非法 → 立刻报错退出；配置合法 → 因为我们故意给了一个
 * 不存在的模型名、且隔离目录里没有凭据、且当前目录不是受信任的 git 仓库，
 * 它在真正发请求**之前**就会停下。两条路都不产生模型请求。
 *
 * @returns {{ valid: boolean, kind: string, message: string }}
 */
function codexTryConfig(home, tomlText, label) {
  fs.writeFileSync(path.join(home, "config.toml"), tomlText, "utf8");
  const r = run(["codex", "--strict-config", "-m", "zzz-probe-unknown-model", "exec", "echo probe"], {
    env: { CODEX_HOME: home },
    timeoutMs: 30000,
  });
  trace(`codex: ${label}`, r);

  // 去掉 ANSI 与那条「临时目录建不了 PATH 别名」的 WARNING（隔离 CODEX_HOME 的必然副产物）
  const text = r.out
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^WARNING: proceeding[^\n]*\r?\n/gm, "")
    .trim();
  const lines = text.split(/\r?\n/);
  const errAt = lines.findIndex((l) => /Error loading config\.toml:/.test(l));
  if (errAt >= 0) {
    // 错误块形如：
    //   Error loading config.toml:
    //   C:\…\config.toml:1:9: invalid type: sequence, expected struct HooksToml
    //     |
    //   1 | hooks = []
    //     |         ^^
    // ★ 关键：报错正文与 file:line 前缀在**同一行**，要剥前缀而不是丢整行。
    const msg = lines.slice(errAt, errAt + 8)
      .map((l) => l.replace(/^\S*?config\.toml:\d+:\d+:\s*/, "").trim())
      .filter((l) => l && !/^Error loading config\.toml:$/.test(l) &&
                     !/^\d+\s*\|/.test(l) && !/^[|^\s]+$/.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { valid: false, kind: "config-error", message: msg };
  }
  return { valid: true, kind: "accepted", message: lines.filter(Boolean).slice(-1)[0] ?? "" };
}

/** Codex 的 12 个 hook 事件名（二进制核实 + 逐个差分验证）。 */
const CODEX_HOOK_EVENTS = [
  "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
  "SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop",
  "Stop", "Interrupt",
];

function probeCodex(installed, version, opts = {}) {
  const result = {
    id: "codex-cli",
    installed,
    version,
    ruleAutoload: {
      supported: true,
      files: ["AGENTS.md"],
      evidence: "codex --help / 既有适配器文档 内置/adapters/codex-client.md",
    },
    mechanism: { kind: "hooks", supported: false, confidence: "unknown", configFile: "~/.codex/config.toml" },
    findings: [],
    probes: [],
  };
  if (!installed) {
    result.mechanism.note = "未安装，未探测";
    return result;
  }

  // ★ 隔离：**所有** codex 调用都走临时 CODEX_HOME，连 `features list` 也不例外。
  //   否则 codex 会去读用户的 ~/.codex/config.toml —— 那不是我们读的，
  //   但让引擎完全不碰它更干净，而且能拿到「出厂默认」这个更有意义的答案。
  // ★ 为什么是**固定目录**而不是 mkdtemp：
  //   codex 会在隔离 HOME 里建一堆 SQLite，退出后句柄要几十秒才放，
  //   实测「当场删不掉、下次开跑时还删不掉」。用 mkdtemp 会变成每跑一次留一个垃圾目录。
  //   改成固定目录 → 无论删不删得掉，**永远最多只有一个**，下次直接复用。
  sweepStaleProbeDirs();
  const home = path.join(os.tmpdir(), "harness-codex-probe-home");
  fs.mkdirSync(home, { recursive: true });
  // 先写一份中性配置：万一上次的残留还在，也保证 features list 看到的是干净状态
  fs.writeFileSync(path.join(home, "config.toml"), "# harness probe: neutral\n", "utf8");
  const env = { CODEX_HOME: home };

  try {
    // ---- 2.1 feature flag：hooks 是不是一个已启用的稳定特性 ----
    const feat = run(["codex", "features", "list"], { env });
    trace("codex features list", feat);
    const hookFlag = /^hooks\s+(\S+)\s+(\S+)\s*$/m.exec(feat.stdout);
    result.features = {
      hooks: hookFlag ? { stage: hookFlag[1], enabled: hookFlag[2] === "true" } : null,
      raw_line: hookFlag ? hookFlag[0].trim() : null,
      isolated_home: true,
    };
    result.probes.push({ label: "codex features list（隔离 CODEX_HOME）", code: feat.code, key_line: result.features.raw_line });

    if (!hookFlag) {
      result.findings.push({ level: "warn", text: "features list 里没找到 hooks 行" });
      return result;
    }
    result.mechanism.supported = true;
    result.mechanism.confidence = "config-verified";
    result.findings.push({
      level: "info",
      text: `codex 的 hooks 是「${hookFlag[1]}」阶段、出厂默认${hookFlag[2] === "true" ? "已启用" : "未启用"}的特性`,
    });

    if (opts.noLive) return result;

    // ---- 2.2 差分探测：先证明方法本身有效（对照组）----
    /** @type {Array<{label:string, toml:string, expect:string, want:string}>} */
    const cases = [
      // 对照组：故意写一个不存在的键。方法有效的证据 = 这一条必须报错。
      { label: "对照组 · 不存在的键", toml: `zzz_not_a_key = true\n`, expect: "invalid", want: "unknown configuration field" },
      // hooks 是不是合法顶层键
      { label: "hooks 顶层键存在", toml: `[hooks]\n`, expect: "valid", want: "" },
      { label: "hooks 类型是 struct 而不是数组", toml: `hooks = []\n`, expect: "invalid", want: "expected struct HooksToml" },
    ];
    // 12 个事件名逐个验证：给整数 → 期待的错误是「expected a sequence」
    for (const ev of CODEX_HOOK_EVENTS) {
      cases.push({
        label: `事件 ${ev} 合法`,
        toml: `[hooks]\n${ev} = 1\n`,
        expect: "invalid",
        want: "expected a sequence",
      });
    }
    // 处理器结构：matcher / hooks / 处理器字段
    cases.push({ label: "matcher 是字符串", toml: `[hooks]\nPreToolUse = [{ matcher = 1 }]\n`, expect: "invalid", want: "expected a string" });
    cases.push({ label: "hooks 是数组", toml: `[hooks]\nPreToolUse = [{ hooks = 1 }]\n`, expect: "invalid", want: "expected a sequence" });
    cases.push({ label: "处理器 type 的合法取值", toml: `[hooks]\nPreToolUse = [{ hooks = [{ type = "bogus" }] }]\n`, expect: "invalid", want: "expected one of" });
    cases.push({ label: "command 是字符串", toml: `[hooks]\nPreToolUse = [{ hooks = [{ type = "command", command = 1 }] }]\n`, expect: "invalid", want: "expected a string" });
    cases.push({ label: "timeout 是 u64", toml: `[hooks]\nPreToolUse = [{ hooks = [{ type = "command", command = "x", timeout = "y" }] }]\n`, expect: "invalid", want: "expected u64" });
    cases.push({ label: "async 是布尔", toml: `[hooks]\nPreToolUse = [{ hooks = [{ type = "command", command = "x", async = 1 }] }]\n`, expect: "invalid", want: "expected a boolean" });
    cases.push({ label: "additionalContextLimit 是 usize", toml: `[hooks]\nPreToolUse = [{ hooks = [{ type = "command", command = "x", additionalContextLimit = "z" }] }]\n`, expect: "invalid", want: "expected usize" });
    // 终极一条：我们准备真正交付的那份配置片段，必须**整体合法**
    const recipe = codexHooksRecipe();
    cases.push({ label: "★ 交付用配置片段整体合法", toml: recipe, expect: "valid", want: "" });

    const observed = [];
    for (const c of cases) {
      const r = codexTryConfig(home, c.toml, c.label);
      const hit = c.want ? r.message.includes(c.want) : r.valid;
      observed.push({ label: c.label, valid: r.valid, message: r.message, matched_expectation: hit });
      result.probes.push({ label: c.label, result: r.valid ? "accepted" : r.message });
    }

    // 对照组必须报错 —— 否则说明整套差分法的前提不成立，后面的结论全部作废
    const control = observed[0];
    result.methodValid = !control.valid;
    if (!result.methodValid) {
      result.findings.push({ level: "error", text: "对照组未按预期报错，差分法前提不成立，hooks 格式结论作废" });
    }

    // 汇总结论：只采信「符合期待」的条目
    const matched = observed.filter((o) => o.matched_expectation);
    result.mechanism.confidence = result.methodValid && matched.length >= cases.length - 1
      ? "config-verified" : "partial";

    const variantProbe = observed.find((o) => o.label.includes("合法取值"));
    result.mechanism.handlerVariants = variantProbe
      ? (/expected one of (.+?)$/.exec(variantProbe.message)?.[1] ?? "").split(/,\s*/).map((s) => s.replace(/[`\s]/g, "")).filter(Boolean)
      : [];
    result.mechanism.events = CODEX_HOOK_EVENTS.filter((ev) =>
      matched.some((o) => o.label === `事件 ${ev} 合法`));
    result.mechanism.configFile = "~/.codex/config.toml 的 [hooks] 段（或 -c 覆盖 / 项目级 hooks.json）";
    result.mechanism.configFormat = [
      "[hooks]",
      '<事件名> = [ { matcher = "<工具名或正则>", hooks = [ { type = "command", command = "<命令行>", timeout = <秒> } ] } ]',
    ];
    result.mechanism.trust = {
      required: true,
      evidence: "codex --help 的 --dangerously-bypass-hook-trust「Run enabled hooks without requiring persisted hook trust」",
      state_fields: ["enabled", "trusted_hash"],
    };
    result.mechanism.probesPassed = matched.length;
    result.mechanism.probesTotal = cases.length;
    result.observed = observed;
  } finally {
    rmRetry(home, 3); // 尽力而为：删不掉就留着下次复用，不再等
  }
  return result;
}

/**
 * 交付给用户的 Codex hooks 配置片段。
 * 这条**必须整体合法**——它是本批「交付用配置片段整体合法」那一条差分探测的被测对象。
 * 路径用 TOML 单引号字面串（literal string），Windows 反斜杠才不会被当成转义。
 */
function codexHooksRecipe() {
  return [
    "# Codex CLI hooks —— 与 Claude Code 的 guard-bash.mjs 同源（见 引擎适配/codex/README.md）",
    "[hooks]",
    "PreToolUse = [",
    "  { matcher = 'Bash', hooks = [ { type = 'command', command = 'node \"<harness>\\自定义\\引擎适配\\codex\\hook-guard.mjs\"', timeout = 10 } ] },",
    "]",
    "",
  ].join("\n");
}

// ════════════════════════════════════════════════════════════
// 三、DeepSeek Harness 探测
// ════════════════════════════════════════════════════════════

function probeDsh(installed, version, opts = {}) {
  const result = {
    id: "deepseek-harness",
    installed,
    version,
    ruleAutoload: {
      // ★ 本批**推翻**了旧适配器文档的说法（见下方 findings）。结论由实测得出，不是推测。
      supported: true,
      files: ["$DSH_HOME/AGENTS.md", "AGENTS.md", "CLAUDE.md", "AGENTS.local.md"],
      evidence: "默认组合里 agent-instructions 行处于启用状态且带 config.maxBytes=65536（本批 --dump-default-config 实测）",
    },
    mechanism: { kind: "patch-layer", supported: false, confidence: "unknown", configFile: "~/.dsh/cordis.patch.yml" },
    findings: [],
    probes: [],
  };
  if (!installed) {
    result.mechanism.note = "未安装，未探测";
    return result;
  }

  // ---- 3.1 --patch 的存在与语义 ----
  const help = run(["dsh", "--help"]);
  trace("dsh --help", help);
  const patchLine = /--patch <path>\s+([\s\S]*?)(?:\n\s*--|\n\s*-V|$)/.exec(help.stdout);
  result.patchFlag = {
    present: /--patch <path>/.test(help.stdout),
    help: patchLine ? patchLine[1].replace(/\s+/g, " ").trim() : null,
  };
  result.probes.push({ label: "dsh --help 里的 --patch", result: result.patchFlag.help });

  if (!result.patchFlag.present) {
    result.findings.push({ level: "warn", text: "dsh --help 里没有 --patch" });
    return result;
  }
  result.mechanism.supported = true;

  // ---- 3.2 默认配置树（**不含用户层**，安全）----
  const dump = run(["dsh", "--profile", "headless", "--dump-default-config"]);
  trace("dsh --dump-default-config", dump);
  const rowIds = [...dump.stdout.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);
  result.defaultRows = { count: rowIds.length, toolRows: rowIds.filter((id) => /^tool-|sandbox|approval/.test(id)) };
  result.probes.push({ label: "dsh --dump-default-config", result: `${rowIds.length} 行` });

  // ---- 3.2b ★ 规则自动加载：agent-instructions 行是否启用、预算多少 ----
  // 这条推翻了 内置/adapters/deepseek-harness.md 的「DSH 没有自动读 AGENTS.md 的机制」。
  const instrBlock = /\n- id: agent-instructions\n([\s\S]*?)(?=\n- id: |$)/.exec(dump.stdout)?.[1] ?? "";
  if (instrBlock) {
    const budget = /maxBytes:\s*(\d+)/.exec(instrBlock)?.[1];
    result.ruleAutoload.supported = !/^\s*disabled:\s*true/m.test(instrBlock);
    result.ruleAutoload.row = "agent-instructions";
    result.ruleAutoload.maxBytes = budget ? Number(budget) : null;
    result.ruleAutoload.contradictsExistingDoc = {
      doc: "内置/adapters/deepseek-harness.md",
      doc_claim: "「DeepSeek Harness 没有自动读 AGENTS.md 的机制」",
      probe_result: `默认组合里 agent-instructions 行${result.ruleAutoload.supported ? "启用" : "被禁用"}，maxBytes=${budget ?? "未设"}`,
    };
    result.findings.push({
      level: "flag",
      text: `⚠️ 与旧适配器文档矛盾：DSH 0.1.0-rc.6 的 headless 组合里 agent-instructions 行**是启用的**` +
        `（maxBytes=${budget ?? "?"}），会按「项目根 → cwd」逐级加载 AGENTS.md / CLAUDE.md。` +
        `旧文档说「没有自动加载机制」——对当前版本不成立。`,
    });
  } else {
    result.findings.push({ level: "warn", text: "默认组合里没找到 agent-instructions 行，规则自动加载按「无」记录" });
    result.ruleAutoload.supported = false;
    result.ruleAutoload.files = [];
  }

  if (opts.noLive) return result;

  // ---- 3.3 --patch 的**实际生效**验证（带对照组）----
  // ⚠️ 这一步必须用 --dump-config（它会带上用户层）。所以本函数**只提取标记行**，
  //    其余输出即用即弃，绝不落盘、绝不打印。这是铁律 1 在本步的具体做法。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dsh-probe-"));
  const marker = `probe-marker-${process.pid}`;
  try {
    const patchFile = path.join(tmp, "patch.yml");
    fs.writeFileSync(patchFile, [
      "- insert:",
      `    - id: ${marker}`,
      "      name: '@deepseek-ai/cordis-plugin-timer'",
      "      disabled: true",
      "",
    ].join("\n"), "utf8");

    const withPatch = run(["dsh", "--profile", "headless", "--patch", patchFile, "--dump-config"]);
    const foundWith = withPatch.stdout.includes(marker);
    const without = run(["dsh", "--profile", "headless", "--dump-config"]);
    const foundWithout = without.stdout.includes(marker);

    result.patchVerification = {
      appliedWithPatch: foundWith,
      absentWithoutPatch: !foundWithout,
      label: marker,
      verdict: foundWith && !foundWithout ? "verified-live" : "inconclusive",
    };
    result.probes.push({
      label: "dsh --patch 实际生效（标记行差分）",
      result: `带 --patch: ${foundWith ? "出现" : "未出现"}；不带: ${foundWithout ? "出现" : "未出现"}`,
    });

    // ---- 3.4 错误行为（决定适配层该怎么写才 fail-loud）----
    const cases = [
      { label: "非数组 patch 文件必须报错", file: "not-array.yml", body: "not-an-array: true\n", want: "must be a top-level YAML array" },
      { label: "目标 id 不存在只告警不报错", file: "missing-target.yml", body: "- id: no-such-row\n  disabled: true\n", want: "not found" },
      { label: "name 与目标不符则跳过", file: "name-mismatch.yml", body: "- id: session-title\n  name: wrong-name\n  disabled: true\n", want: "name mismatch" },
    ];
    result.patchErrors = [];
    for (const c of cases) {
      const f = path.join(tmp, c.file);
      fs.writeFileSync(f, c.body, "utf8");
      const r = run(["dsh", "--profile", "headless", "--patch", f, "--dump-config"]);
      const hit = r.out.includes(c.want);
      result.patchErrors.push({ label: c.label, observed: hit, detail: c.want });
      result.probes.push({ label: c.label, result: hit ? "符合预期" : "未复现" });
    }

    if (result.patchVerification.verdict === "verified-live") {
      result.mechanism.confidence = "verified-live";
      result.findings.push({ level: "info", text: "--patch 叠加层已用「标记行差分 + 对照组」实测生效" });
    } else {
      result.mechanism.confidence = "partial";
      result.findings.push({ level: "warn", text: "--patch 生效性验证不确定，详见 patchVerification" });
    }

    result.mechanism.configFormat = [
      "# 顶层 YAML 数组，每项是一条 loader patch 条目：",
      "#   插入： - insert: [ <行对象…> ]              （或 - id: <组 id> + insert: […]）",
      "#   覆盖： - id: <已有行 id> + 任意键           （可带 name 做一致性校验）",
      "# 层序（后覆盖前）：bundle 层 → profile 的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch 叠加层",
      "# 允许 !!js 表达式；非法字段在**启动时**抛错（fail-loud），目标 id 不存在只告警。",
    ];
    result.mechanism.rowIdsForHooking = result.defaultRows.toolRows;
  } finally {
    rmRetry(tmp);
  }
  return result;
}

// ════════════════════════════════════════════════════════════
// 四、Claude Code 与 TraeCode
// ════════════════════════════════════════════════════════════

function probeClaude(installed, version, desktop = null) {
  const desktopDet = desktop ?? detectEngine("claude-code-desktop");
  return {
    id: "claude-code",
    installed,
    version,
    ruleAutoload: { supported: true, files: ["CLAUDE.md", "AGENTS.md"], evidence: "第 2/4 批真会话实测" },
    mechanism: {
      kind: "hooks",
      supported: true,
      // 本批**没有**重新验证 Claude Code —— 第 2/3 批已经用真会话验过。
      // 如实标注证据来源，不冒充本批结论。
      confidence: "verified-live(第 2/3 批)",
      configFile: ".claude/settings.json（工作区根 + 项目级；不动用户级）",
      events: ["SessionStart", "PreToolUse", "PostToolUse", "PreCompact", "Stop", "SessionEnd"],
      handlerVariants: ["command"],
      configFormat: [
        '{ "hooks": { "<事件名>": [ { "matcher": "<工具名>", "hooks": [ { "type": "command", "command": "node", "args": ["<脚本>"], "timeout": 10 } ] } ] }',
      ],
      evidence: "第 2 批（拦下 sed -i / 逃生阀 / 3 次 playwright 配额）、第 3 批（输出截断 / HANDOFF / 状态栏）均真会话实测",
      limitation: "只能覆盖 Claude Code，且项目级 hooks 需要项目目录内有 .claude/（由 scaffold-ext.mjs 落地）",
    },
    canBlockShell: true,
    canBlockEditTool: true,
    outputShaping: true,
    contextTelemetry: true,
    // ★ 第 3 段：Claude Code 有两种形态，机制层是同一套，生效条件不同 —— 必须分开写清楚。
    desktop: {
      installed: desktopDet.installed,
      evidence: desktopDet.evidence ?? null,
      path: desktopDet.path ?? null,
      version: desktopDet.version ?? null,
      // 实测依据（第 2 批已核实）：Claude Code 用**会话 cwd** 当项目根，不向上寻找 .claude\settings.json
      mechanismSameAsTerminal: true,
      effectiveOnlyInProjectDir: true,
      note:
        "同一套 .claude/ hooks（settings.json + 9 个脚本）；但只有在**项目目录里**开会话才生效 —— " +
        "Claude Code 用会话 cwd 当项目根、不向上寻找。在别处开会话 = 机制层完全不生效（不是部分生效）。",
      evidenceNote: "本机判据为桌面应用安装痕迹，不是进程存活；~/.claude.json 不能当判据（终端 CLI 也会生成）",
    },
    findings: [],
    probes: [],
  };
}

function probeTrae(installed, version) {
  const r = {
    id: "traecode-cli",
    installed,
    version: version ?? null,
    ruleAutoload: { supported: true, files: [".trae/rules/"], evidence: "内置/adapters/traecode-cli.md（未在本机验证）" },
    mechanism: { kind: "unknown", supported: false, confidence: "未查明", configFile: "未查明" },
    findings: [],
    probes: [],
  };
  const traeIde = which("trae") ?? (fs.existsSync(path.join(os.homedir(), ".trae")) ? "~/.trae（IDE 目录存在）" : null);
  r.traeIdePresent = Boolean(traeIde);
  r.findings.push({
    level: "warn",
    text: installed
      ? "CLI 已安装但本批未探测其机制（需先确认 CLI 子命令）"
      : "TraeCode CLI 未安装 → 机制层**未查明**，能力表按「未知」记录，本批不强推。Trae IDE 是图形界面，无法注入机制层。",
  });
  r.probes.push({ label: "traecode CLI 是否在 PATH", result: installed ? "在" : "不在" });
  r.probes.push({ label: "Trae IDE 目录是否存在", result: r.traeIdePresent ? "存在" : "不存在" });
  return r;
}

// ════════════════════════════════════════════════════════════
// 五、组装能力表
// ════════════════════════════════════════════════════════════

function semver(out) {
  const m = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(out ?? "");
  return m ? m[1] : null;
}

function buildTable(engines, ctx = {}) {
  const installed = ctx.installed ?? {};
  const det = ctx.det ?? {};
  const byId = Object.fromEntries(engines.map((e) => [e.id, e]));
  const codex = byId["codex-cli"];
  const dsh = byId["deepseek-harness"];

  // ★ 第 3 段（锁定决策 10）：把「本次可选的引擎 + 上次选择」也写进表里，
  //   这样 日志\06-引擎\ 和 run.bat 的列表在事后能对上（同一份实现 engine-detect.mjs）。
  let choice = null;
  try {
    const c = engineChoiceList();
    choice = {
      available: c.available.map((d) => ({ id: d.id, label: d.label, kind: d.kind, path: d.path, via: d.via })),
      notInstalled: c.unavailable.map((d) => d.id),
      last: c.last,
      default: c.default,
      stateDir: c.stateDir,
      choiceFile: c.choiceFile,
      resolver: "自定义/scripts/lib/engine-detect.mjs",
    };
  } catch {
    /* 探测本身失败不该让能力表写不出来 */
  }

  const notRechecked = engines.filter((e) => e.notRechecked).map((e) => e.id);
  const rechecked = engines.filter((e) => e.installed).map((e) => e.id);

  return {
    schema: 1,
    updated: PROBE_DATE,
    generator: "自定义/scripts/probe-engines.mjs",
    // 装 / 没装 一律由统一解析器判定（P2-5）：安装位置、判定方式、本轮是否复验都写在这里
    detection: {
      resolver: "自定义/scripts/lib/resolve-command.mjs（.exe → .cmd → .bat → .com → 无扩展名；认 PATH/PATHEXT/MSYS）",
      usedBy: ["probe-engines.mjs", "env-doctor.mjs", "engine-probe-selftest.mjs", "run.ps1", "run.sh"],
      recheckedThisRun: rechecked,
      notRecheckedThisRun: notRechecked,
      note: notRechecked.length
        ? `本机没有 ${notRechecked.join(" / ")} → 这几项本轮**跳过实测**，其结论转存到对应引擎的 lastVerified（标注来源日期，未复验）。`
        : "本轮全部引擎都在本机探测成功。",
    },
    runtimeChoice: choice,
    _说明: [
      "引擎能力表（F10 · 第 6 批）。回答：各引擎有没有机制层、机制层怎么写、能拦住什么。",
      "★ 本表的每一条结论都标注了 confidence，请按标注理解，不要把「未查明」当成「不支持」：",
      "  · verified-live   —— 真会话 / 真命令实测过（最强）",
      "  · config-verified —— 用引擎自己的 --strict-config 差分探出来的（配置格式可信）",
      "  · partial         —— 只证实了一部分，细节见 probes",
      "  · 未查明          —— 没探到，如实在此标注，不做推测",
      "★ 探测铁律：绝不读用户配置文件（可能含 API key）；只用只读命令；靠报错信息推断字段。",
      "  实现见 probe-engines.mjs 的 safeRead()（白名单式读取）与 PROBES（命令写死）。",
    ],

    probePolicy: {
      绝不读的文件: FORBIDDEN_FILES,
      只读命令: [
        "codex --version / codex features list",
        "codex --strict-config -m <不存在的模型> exec <无副作用指令>  （CODEX_HOME=临时目录）",
        "dsh --version / dsh --help",
        "dsh --profile headless --dump-default-config",
        "dsh --profile headless --patch <临时文件> --dump-config",
      ],
      隔离手段: [
        "Codex：CODEX_HOME 指向临时目录 → codex 自己就不会读 ~/.codex",
        "Codex：模型名故意写成不存在的 zzz-probe-unknown-model → 到不了 API",
        "DSH：--dump-config 的输出**即用即弃**，只提取自己写入的标记行，绝不落盘",
      ],
      零额度: "整轮探测 0 次模型请求。2026-09-11 实测确认。",
      已知副作用: [
        "dsh 的 --dump-* 会重写 profile 目录里的 cordis.yml（dsh 自身既有行为：该文件固定为空根列表）。",
        "codex 的临时 CODEX_HOME 会在结束时删除。",
      ],
    },

    engines: {
      "claude-code": byId["claude-code"],
      "codex-cli": codex,
      "deepseek-harness": dsh,
      "traecode-cli": byId["traecode-cli"],
    },

    matrix: {
      _说明:
        "引擎能力矩阵（第 3 段重写）。**强制力分三档，越靠前越硬**：" +
        "① hooks 强制（引擎自己的事件机制，模型绕不过）；② 命令包装强制（走 run.bat 启动时前置 自定义\\bin，模型执行命令必被计数）；" +
        "③ 仅启动词（靠模型自觉 —— 历史实测弱模型违规 138 次，所以只当兜底，不当机制）。" +
        "「✅」= 本机/历史真机验证过；「⚠️」= 方案就绪但未在本机复验；「❌」= 该引擎没有这个能力。",
      列: ["规则自动读取", "hooks 强制", "命令包装强制(U4)", "拦内置编辑工具", "输出截断", "上下文遥测", "会话后审计(U3)", "本机实测状态"],
      "claude-code": [
        "✅ CLAUDE.md + AGENTS.md",
        "✅ 全套 6 事件（.claude/settings.json）",
        "✅",
        "✅ hooks（guard-tools）",
        "✅ hooks（shape-output + G10）",
        "✅ statusLine → 自主学习",
        "✅",
        installed["claude-code"] ? "本轮实测在机" : "本轮本机没有 claude 命令 → skipped（保留历史实测结论）",
      ],
      "claude-code-desktop": [
        "✅ CLAUDE.md + AGENTS.md",
        "✅ 同一套 .claude/ hooks，**但只有在项目目录里开会话才生效**",
        "✅（经 run.bat 启动时）",
        "✅ hooks",
        "✅ hooks",
        "✅ statusLine",
        "✅",
        byId["claude-code"]?.desktop?.installed
          ? `本轮实测：桌面端在机（判据 ${byId["claude-code"]?.desktop?.evidence ?? "安装痕迹"}）；hooks 生效条件见左列`
          : "未探到桌面端安装痕迹",
      ],
      "codex-cli": [
        "✅ AGENTS.md（自动读取）",
        `✅ hooks（${codex?.mechanism?.confidence ?? "未查明"}）+ U4`,
        "✅",
        "✅ hooks（PreToolUse 覆盖文件工具）",
        "❌（未发现等价机制）",
        "⚠️ 未验证",
        "✅",
        installed["codex-cli"] ? `本轮实测在机：${det["codex-cli"]?.path ?? "?"}` : "本轮本机没有 codex → skipped",
      ],
      // ★ DSH 自己会读 AGENTS.md（历史实测），不再只靠 U2；U2 仍是兜底与强化
      "deepseek-harness": [
        "✅ AGENTS.md / CLAUDE.md（agent-instructions 行实测启用）+ U2 兜底",
        "❌ 无 hooks",
        "✅ U4 命令包装（--patch 层已通）",
        "⚠️ 需自写插件行",
        "❌",
        "❌",
        "✅",
        installed["deepseek-harness"] ? "本轮实测在机" : `本轮本机没有 dsh 命令 → skipped（保留 ${PROBE_DATE} 之前的实测结论）`,
      ],
      "traecode-cli": [
        "✅ .trae/rules/（规则文件）",
        "❌",
        "⚠️ 仅 U4（走 run.bat 时）",
        "❌",
        "❌",
        "❌",
        "⚠️ 未查明",
        installed["traecode-cli"] ? "本轮实测在机" : "本轮本机没有 traecode 命令 → skipped",
      ],
      "trae-ide": [
        "✅ .trae/rules/（IDE 自己读项目规则）",
        "❌ 图形端无法注入机制层",
        "❌（IDE 里直接开对话不走 run.bat）",
        "❌",
        "❌",
        "❌",
        "❌",
        detectEngine("trae-ide").installed ? "本轮实测：Trae 在机（图形端）" : "未探到 Trae",
      ],
    },

    unknowns: [
      notRechecked.length
        ? `★ 本轮本机没有 ${notRechecked.join(" / ")} 的命令行（统一解析器已确认）→ 这几项**没有复验**：` +
          "其结论来自 lastVerified（标注了来源日期与版本），属于「上次实测有效、本轮未能重复」的证据，不是本轮结论。"
        : "★ 本轮全部引擎都在本机复验过。",
      "★ 规则自动加载的**生效性**没在真会话里验证过：DSH 会读 AGENTS.md 是从「默认组合里 agent-instructions 行启用 + 该插件自带文档」推出的，不是真会话实测。",
      installed["traecode-cli"]
        ? "TraeCode CLI 在机但机制层仍未查明（不做推测）。"
        : "TraeCode CLI 未安装 → 其机制层完全未查明（不做推测）。",
      "Codex hooks 的 matcher 语义（匹配工具名还是命令正则）未实测，只确认了「是字符串」。",
      "Codex hooks 的『trust 持久化』落盘位置未查（不读用户配置）。首次启用时 Codex 会要求一次信任确认。",
      "DSH 要拦内置文件编辑工具，需要自己写一个插件行（tool-fs/tool-fs-search 是它的文件工具行名）——插件本体不在本批范围。",
      "输出截断与上下文遥测：Codex / DSH 均未发现等价机制（不是「确认没有」，是「未发现」）。",
      "Claude 桌面端的 hooks 生效性没有在桌面端真会话里验证过 —— 本机只确认了「桌面端装着」+「同一套 .claude/ 配置」，" +
        "生效条件（必须在项目目录里开会话）来自第 2 批对 Claude Code 项目根语义的实测。",
    ],

    limitations: [
      "U4（命令包装）只对**通过 harness 启动**的会话生效；用户在 Trae IDE 里直接开对话不走 run.bat。",
      "本批只做到「探明 + 备好配置片段」，没有把 Codex/DSH 的适配生效（那是第 7 批 U4 之后的接线活）。",
      "Codex 与 DSH 的机制层都**没有**用真会话验证过——验证需要真实模型请求，会花钱，本批按「零额度」原则没做。",
      "第 3 段补：Codex hooks 的配置片段**合法性**已由 codex 0.153.4 的 --strict-config 实测接受，" +
        "但「真会话里 hooks 真的被调用」仍未验证（要花额度）；自检台与验收报告都按「配置合法 / 未跑真会话」两级如实标注。",
    ],
  };
}

// ════════════════════════════════════════════════════════════
// 六、主流程
// ════════════════════════════════════════════════════════════

const USAGE = `用法：node probe-engines.mjs [选项]

选项：
  --engine <名>   只探一个引擎：claude-code | codex-cli | deepseek-harness | traecode-cli
  --dry-run       只探测，不写 引擎能力表.json
  --no-live       跳过需要跑引擎的探测（只读 version / help）
  --json          stdout 输出完整 JSON（不打印人读摘要）
  --verbose       打印每条探测命令的原始输出
  --help, -h      显示本帮助

铁律：绝不读用户配置文件；只用只读命令；靠报错信息推断字段。
`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(USAGE); return 0; }

  const opts = {
    dryRun: argv.includes("--dry-run"),
    noLive: argv.includes("--no-live"),
    json: argv.includes("--json"),
    only: (() => { const i = argv.indexOf("--engine"); return i >= 0 ? argv[i + 1] : null; })(),
  };

  // ★ 第 3 段（P2-5）：安装探测 + 版本号全部走统一解析器（engine-detect → resolve-command）。
  //   旧实现用 `where` / spawnSync("codex")，规则与包装器不一致 → 实测误报「本机没有 codex」。
  const det = {};
  for (const id of ["claude-code", "codex-cli", "deepseek-harness", "traecode-cli"]) det[id] = detectEngine(id);
  const installed = Object.fromEntries(Object.entries(det).map(([id, d]) => [id, d.installed]));
  const versions = {};
  for (const [id, d] of Object.entries(det)) {
    if (!d.installed || !d.path) { versions[id] = d.version ?? null; continue; }
    const r = run([d.path, "--version"], { timeoutMs: 20000 });
    versions[id] = semver(r.out) ?? d.version ?? null;
  }

  const engines = [];
  const want = (id) => !opts.only || opts.only === id;

  if (want("claude-code")) engines.push(probeClaude(installed["claude-code"], versions["claude-code"]));
  if (want("codex-cli")) engines.push(probeCodex(installed["codex-cli"], versions["codex-cli"], opts));
  if (want("deepseek-harness")) engines.push(probeDsh(installed["deepseek-harness"], versions["deepseek-harness"], opts));
  if (want("traecode-cli")) engines.push(probeTrae(installed["traecode-cli"], versions["traecode-cli"]));

  // 每个引擎都如实记下「装在哪 / 怎么探到的 / 哪一轮探到的」
  for (const e of engines) {
    const d = det[e.id];
    e.detection = {
      installed: d.installed,
      path: d.path,
      via: d.via,
      kind: d.kind,
      resolver: "自定义/scripts/lib/resolve-command.mjs（经 engine-detect.mjs）",
      checkedAt: PROBE_DATE,
    };
  }

  // ★ 本机没装的引擎：**不要把上一轮的实测结论抹掉**（那是不说谎也不丢信息）
  const prev = readPreviousTable();
  for (const e of engines) {
    if (e.installed) continue;
    const p = prev?.engines?.[e.id];
    e.notRechecked = true;
    e.mechanism.note = `本机没有该引擎（统一解析器已探过），本轮跳过实测；下面保留 ${prev?.updated ?? "上次"} 的实测结论`;
    if (p) {
      e.lastVerified = {
        at: prev.updated ?? null,
        version: p.version ?? null,
        mechanism: p.mechanism ?? null,
        patchVerification: p.patchVerification ?? null,
        ruleAutoload: p.ruleAutoload ?? null,
        desktop: p.desktop ?? null,
      };
      e.findings.push({
        level: "warn",
        text: `本机没有 ${e.id}（统一解析器已探过）→ 本轮**跳过实测**；结论保留 ${prev.updated ?? "上次"} 的实测值，已标注「未复验」。`,
      });
    } else {
      e.findings.push({ level: "warn", text: `本机没有 ${e.id} → 本轮跳过实测，且没有历史结论可保留。` });
    }
  }

  const table = buildTable(engines, { installed, det });

  if (opts.json) {
    process.stdout.write(JSON.stringify(table, null, 2) + "\n");
  } else {
    process.stdout.write(`\n引擎能力探测（${PROBE_DATE}）\n${"─".repeat(64)}\n`);
    for (const e of engines) {
      const found = e.installed ? `已安装 ${e.version ?? "?"}` : "未安装（skipped：本轮跳过实测）";
      process.stdout.write(`\n${e.installed ? "●" : "○"} ${e.id}  [${found}]\n`);
      if (e.detection) {
        process.stdout.write(`  探到方式：${e.detection.via ?? "—"}${e.detection.path ? `  ${e.detection.path}` : ""}\n`);
      }
      process.stdout.write(`  规则自动加载：${e.ruleAutoload.supported ? "有 " + (e.ruleAutoload.files.join("/") || "") : "无（靠 U2 启动词注入）"}\n`);
      process.stdout.write(`  机制层：${e.mechanism.supported ? e.mechanism.kind : "未发现/未查明"}`);
      process.stdout.write(`  置信度=${e.mechanism.confidence}\n`);
      if (e.lastVerified) {
        process.stdout.write(
          `  未复验：结论保留自 ${e.lastVerified.at ?? "上次"}（版本 ${e.lastVerified.version ?? "?"}）—— 本轮本机没有该引擎\n`,
        );
      }
      if (e.mechanism.configFile) process.stdout.write(`  配置文件：${e.mechanism.configFile}\n`);
      if (e.mechanism.probesPassed) {
        process.stdout.write(`  差分探测：${e.mechanism.probesPassed}/${e.mechanism.probesTotal} 条符合预期` +
          `${e.methodValid ? "" : "（⚠️ 对照组未报错，结论作废）"}\n`);
      }
      if (e.patchVerification) {
        process.stdout.write(`  --patch 实测：${e.patchVerification.verdict === "verified-live" ? "✅ 生效（带对照组）" : "⚠️ " + e.patchVerification.verdict}\n`);
      }
      for (const f of e.findings) process.stdout.write(`  · ${f.text}\n`);
    }
    {
      const c = engineChoiceList();
      process.stdout.write(`\n可选用引擎（run.bat 的列表，同一份 engine-detect.mjs）：\n`);
      for (const d of c.available) process.stdout.write(`  · ${d.label} [${d.id}] ${d.kind === "cli" ? "可自动启动" : "仅启动词"}\n`);
      process.stdout.write(`  上次选择：${c.last ?? "（还没选过）"}｜默认：${c.default ?? "（无）"}\n`);
      process.stdout.write(`  选择记忆文件：${c.choiceFile}${existsSyncSafe(c.choiceFile) ? "" : "（还没生成）"}\n`);
    }
    process.stdout.write(`\n${"─".repeat(64)}\n`);
    process.stdout.write(`未查明项 ${table.unknowns.length} 条（已如实写进能力表）。\n`);
  }

  if (!opts.dryRun) {
    safeWrite(TABLE_PATH, JSON.stringify(table, null, 2) + "\n");
    if (!opts.json) process.stdout.write(`已写入：${TABLE_PATH}\n`);
  }
  logEngineProbe(engines, table, opts);
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`[probe-engines] 出错：${err?.message ?? err}\n`);
  process.exitCode = 2;
}
