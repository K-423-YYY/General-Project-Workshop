#!/usr/bin/env node
/**
 * verify-gate.mjs —— 独立验收（G11）
 * 第 3 批 · 上下文治理 · 交付物 A10
 *
 * 它**不是 hook**，是给模型用的命令行工具（所以不注册进 settings.json 的 hooks）。
 *
 * 为什么需要它：
 *   事故快结束时用户问「现在还有什么没做的吗」—— 说明**用户已经无法信任模型自述的完成度**。
 *   根因是：模型的「已全部通过」是自己总结的，而自己总结的东西没有证据链。
 *   本脚本把「跑验收」和「读结果」这两件事从模型手里拿走：
 *     原始输出 → 落盘到**工作区根** 日志\03-验证\（不可篡改的证据；第 2 段从项目内 .harness\logs\ 迁出）
 *     摘要     → 由脚本按固定规则从原始输出里**摘录**，不是复述
 *   模型只能引用这份输出。想声称「通过」，就得引用脚本的退出码。
 *
 * 第 2 段（日志中心）的落实方式：**每次运行新建一个文件**（文件名带时间戳，撞名加序号），
 *   全程只写一次、只追加不改写；日志中心不可用（项目被复制到工作区外）时退回系统临时目录，
 *   并在摘要里如实说明落在哪里 —— 验收证据宁可在别处，也不能悄悄丢。
 *
 * 用法：
 *   node .claude/hooks/verify-gate.mjs                       # 读 .harness/verify.json 里的清单
 *   node .claude/hooks/verify-gate.mjs --cmd "npx vitest run"
 *   node .claude/hooks/verify-gate.mjs -- npx vitest run     # -- 之后的都当命令
 *   node .claude/hooks/verify-gate.mjs --list                # 只看清单，不跑
 *   node .claude/hooks/verify-gate.mjs --json                # 机器可读
 *
 * .harness/verify.json 格式：
 *   { "commands": [ { "name": "L1 定向单测", "cmd": "npx vitest run" } ] }
 *
 * 退出码：全部通过 → 0；任一失败 → 1；用法错误 → 2。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  harnessPaths,
  ensureDir,
  readJsonFile,
  clip,
  stamp,
  FAIL_RE,
} from "./lib/policy.mjs";
import { FILES as LOG_FILES, appendLog, resolveLogRoot } from "./lib/log-center.mjs";

/** 同秒内重跑时换个名字，保证"每次运行一个文件"，绝不覆盖上一份证据 */
function uniqueLogName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 0; i < 50; i++) {
    const cand = i ? `${base}-${i + 1}${ext}` : name;
    try {
      if (!fs.existsSync(path.join(dir, cand))) return cand;
    } catch {
      return cand;
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_LINES = 25;
const MAX_FAIL_LINES = 40;

// ───────────────────────────────────────────── 参数

function parseArgs(argv) {
  const out = { commands: [], listOnly: false, json: false, timeoutMs: DEFAULT_TIMEOUT_MS, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.listOnly = true;
    else if (a === "--json") out.json = true;
    else if (a === "--cmd") out.commands.push({ name: null, cmd: String(argv[++i] ?? "") });
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i] ?? 0) * 1000 || DEFAULT_TIMEOUT_MS;
    else if (a === "--root") out.root = String(argv[++i] ?? "");
    else if (a === "--") {
      const rest = argv.slice(i + 1).join(" ").trim();
      if (rest) out.commands.push({ name: null, cmd: rest });
      break;
    } else if (!a.startsWith("-")) out.commands.push({ name: null, cmd: a });
  }
  return out;
}

function usage() {
  return [
    "verify-gate —— 独立验收（G11）",
    "",
    "用法：",
    '  node .claude/hooks/verify-gate.mjs                      # 跑 .harness/verify.json 里的清单',
    '  node .claude/hooks/verify-gate.mjs --cmd "npx vitest run"',
    "  node .claude/hooks/verify-gate.mjs -- npx vitest run",
    "  node .claude/hooks/verify-gate.mjs --list",
    "",
    ".harness/verify.json 格式：",
    '  { "commands": [ { "name": "L1 定向单测", "cmd": "npx vitest run" } ] }',
  ].join("\n");
}

// ───────────────────────────────────────────── 执行

function runOne(entry, root, timeoutMs) {
  return new Promise((resolve) => {
    const cmd = entry.cmd;
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let child;

    try {
      child = spawn(cmd, {
        shell: process.env.HARNESS_SHELL || true,
        cwd: root,
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        name: entry.name || cmd,
        cmd,
        code: null,
        error: String(err?.message || err),
        stdout: "",
        stderr: "",
        durationMs: 0,
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        name: entry.name || cmd,
        cmd,
        code: null,
        error: String(err?.message || err),
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        name: entry.name || cmd,
        cmd,
        code,
        signal: signal || null,
        timedOut: Date.now() - started >= timeoutMs,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

// ───────────────────────────────────────────── 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root || process.cwd();
  const { verifyConfig } = harnessPaths(root);

  // ── 清单来源
  if (!args.commands.length) {
    const cfg = readJsonFile(verifyConfig);
    const list = Array.isArray(cfg?.commands) ? cfg.commands : [];
    if (!list.length) {
      process.stderr.write(
        `${usage()}\n\n没有传命令，也没有找到可用的 ${verifyConfig}。\n` +
          `先在项目里建这个文件，把你的验收命令写进去（每条一个 {name, cmd}）。\n`,
      );
      process.exit(2);
    }
    for (const e of list) {
      if (e && typeof e.cmd === "string" && e.cmd.trim()) {
        args.commands.push({ name: e.name ?? null, cmd: e.cmd.trim() });
      }
    }
  }

  if (args.listOnly) {
    process.stdout.write(
      `将要执行的验收命令（cwd=${root}）：\n` +
        args.commands.map((c, i) => `  ${i + 1}. ${c.name ? `[${c.name}] ` : ""}${c.cmd}`).join("\n") +
        "\n",
    );
    return 0;
  }

  // ── 原始输出落盘位置：工作区根 日志\03-验证\（第 2 段从项目内迁出）
  //    找不到工作区根时退回系统临时目录，并在摘要里说明 —— 证据不能因为路径问题丢。
  let logRoot = resolveLogRoot({ cwd: root });
  let logRootNote = "工作区根\\日志\\03-验证\\";
  if (!logRoot) {
    logRoot = path.join(os.tmpdir(), "harness-log-center");
    logRootNote = `系统临时目录（找不到工作区根，退回 ${logRoot}）`;
  }
  const verifyDir = path.join(logRoot, "03-验证");
  ensureDir(verifyDir);
  const logName = uniqueLogName(verifyDir, LOG_FILES.verify());
  const logPath = path.join(verifyDir, logName);

  const results = [];
  const chunks = [`# verify-gate 原始输出 · ${stamp()}\ncwd: ${root}\n`];

  for (const entry of args.commands) {
    chunks.push(`\n${"=".repeat(78)}\n## $ ${entry.cmd}\n${"=".repeat(78)}\n`);
    const r = await runOne(entry, root, args.timeoutMs);
    results.push(r);
    chunks.push(`--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
    chunks.push(`--- exit=${r.code}${r.timedOut ? " (超时被杀)" : ""} 用时 ${r.durationMs}ms ---\n`);
  }

  const rawLog = chunks.join("");
  const written = appendLog("verify", { file: logName, text: rawLog, logRoot });
  const wroteLog = !!written.ok;

  const failed = results.filter((r) => r.code !== 0 || r.error || r.timedOut);

  // ── 机器可读
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: failed.length === 0,
          cwd: root,
          logPath: wroteLog ? logPath : null,
          commands: results.map((r) => ({
            name: r.name,
            cmd: r.cmd,
            exitCode: r.code,
            timedOut: !!r.timedOut,
            error: r.error ?? null,
            durationMs: r.durationMs,
            stdoutBytes: Buffer.byteLength(r.stdout, "utf8"),
            stderrBytes: Buffer.byteLength(r.stderr, "utf8"),
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return failed.length ? 1 : 0;
  }

  // ── 给人 / 给模型看的摘要
  const out = [];
  out.push(`[harness] 独立验收（G11）· ${stamp()}`);
  out.push(`总结论：${failed.length === 0 ? "全部命令退出码为 0" : `${failed.length}/${results.length} 条命令未通过`}`);
  out.push(`原始输出（未截断）：${wroteLog ? logPath : `落盘失败！${written.error ?? ""}`}`);
  if (wroteLog && logRootNote !== "工作区根\\日志\\03-验证\\") out.push(`（落盘位置说明：${logRootNote}）`);
  out.push("");
  out.push("逐条结果：");
  for (const r of results) {
    const mark = r.code === 0 && !r.timedOut && !r.error ? "PASS" : "FAIL";
    out.push(
      `  [${mark}] ${r.name ? `${r.name} — ` : ""}${r.cmd}\n` +
        `         退出码 ${r.code ?? "null"}${r.timedOut ? "（超时被杀）" : ""}${r.error ? ` 启动失败：${r.error}` : ""}` +
        ` · ${(r.durationMs / 1000).toFixed(1)}s · stdout ${Buffer.byteLength(r.stdout, "utf8")}B / stderr ${Buffer.byteLength(r.stderr, "utf8")}B`,
    );
  }

  // ── 失败项摘录（★ 只摘录，不复述；这是 G11 的立身之本）
  if (failed.length) {
    out.push("");
    out.push("--- 失败项原文摘录（脚本从日志里摘的，不是模型总结的）---");
    for (const r of failed) {
      const text = `${r.stdout}\n${r.stderr}`;
      const lines = text.split(/\r?\n/);
      const hits = lines.filter((l) => FAIL_RE.test(l)).slice(0, MAX_FAIL_LINES);
      out.push(`\n### $ ${r.cmd}`);
      if (hits.length) for (const l of hits) out.push(l);
      else out.push("（没有匹配到错误关键词，下面是末尾 25 行原文）");
      const tail = lines.filter(Boolean).slice(-TAIL_LINES);
      out.push("--- 末尾 ---");
      for (const l of tail) out.push(l);
    }
  }

  out.push("");
  out.push(
    "注意（G11 的规矩）：引用本结果时必须原文引用上面的退出码与失败行，" +
      "不要改写成「已全部通过」。有失败就是有失败，如实报告。",
  );

  process.stdout.write(clip(out.join("\n"), 36000) + "\n");
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[harness] verify-gate 自身异常：${err?.message || err}\n`);
    process.exit(2);
  });
