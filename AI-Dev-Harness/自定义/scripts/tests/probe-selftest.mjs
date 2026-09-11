#!/usr/bin/env node
/**
 * tests/probe-selftest.mjs —— 待实测项 #3 的自检台
 * ============================================================
 * 06-待实测确认.md 的待确认项 #3 问的是：
 *   「怎么区分模型『真支持长上下文』和『静默截断』？」
 *
 * 这个自检台**不花一分钱**（全是本机回环），用一个假端点分别扮演三种真实世界的行为，
 * 然后看 probe-model.mjs 能不能把它们区分开：
 *
 *   模式 A  hard-limit          超过上限 → 端点明确报错 400
 *                              ⇒ 期望 probe 判定 failureMode = "HARD_LIMIT"
 *   模式 B  silent-truncation   超过上限 → 端点照样 200 OK，但**丢掉开头**（模型看不到随机串）
 *                              ⇒ 期望 probe 判定 failureMode = "TRUNCATION"
 *                              ⇒ 且**绝不能**把它当成"真支持"（这正是二分法会踩的坑）
 *   模式 C  broken              连小尺寸都复述不出随机串（模型坏 / 探针不适用）
 *                              ⇒ 期望 probe 直接终止，且**不写任何画像**
 *
 * 三种模式测出来的 measuredWindow 应该一致（同一个物理上限），
 * 而失败原因必须被分成 HARD_LIMIT / TRUNCATION —— 这就是 #3 的结论。
 *
 * 用法：node tests/probe-selftest.mjs
 * 依赖：无（node 内置 http + fetch）。
 * ============================================================
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));       // ...\scripts\tests
const SCRIPTS = path.dirname(HERE);                              // ...\scripts
const PROBE = path.join(SCRIPTS, "probe-model.mjs");
const REAL_TABLE = path.join(SCRIPTS, "..", "模型能力表.json");

// 假端点的"物理上限"：32768 字符 ≈ 8192 token（按 0.25 token/字符）
const LIMIT_CHARS = 32768;
const CHARS_PER_TOKEN = 4;

/** 从 Anthropic 兼容请求体里取出用户那段文本。 */
function extractUserText(body) {
  const blocks = body?.messages ?? [];
  const first = blocks[0]?.content;
  if (typeof first === "string") return first;
  if (Array.isArray(first)) return first.map((b) => b?.text ?? "").join("");
  return "";
}

const norm = (s) => String(s ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * 造一个假端点。它会扮演真实世界超限时的各种行为：
 *   hard-limit        超限 → 400 报错
 *   silent-truncation 超限 → 200 OK，但**掐头**（模型只剩尾部）
 *   middle-drop       超限 → 200 OK，头尾都留、**只砍中间**（单针探针测不出来的那种）
 *   broken            模型根本不复述随机串（探针不适用）
 *
 * 探针把三个随机串分别放在 开头 / 中间 / 结尾，假端点负责按模式决定哪个能"看见"，
 * 然后像真模型一样：看得见就复述，看不见就说找不到。
 *
 * @param {"hard-limit"|"silent-truncation"|"middle-drop"|"broken"} mode
 */
function makeMock(mode) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 忽略 */ }
      const content = extractUserText(body);
      const chars = content.length;
      const overLimit = chars > LIMIT_CHARS;

      // 探针的三个针：头（第一行）/ 中（半程处独立一行）/ 尾（指令前一行）
      const lines = content.split("\n");
      const head = lines[0] ?? "";
      const tailNeedle = lines[lines.length - 2] ?? "";
      const midIdx = lines.findIndex((l, i) => i > 1 && /^[A-Za-z0-9]{32}$/.test(l.trim()));
      const mid = midIdx > 0 ? lines[midIdx].trim() : "";

      const send = (status, payload) => {
        const out = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(out);
      };

      if (mode === "hard-limit" && overLimit) {
        return send(400, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `This model's maximum context length is ${LIMIT_CHARS} characters. ` +
                     `However, your messages resulted in ${chars} characters.`,
          },
        });
      }
      if (mode === "broken") {
        return send(200, {
          content: [{ type: "text", text: "抱歉，我无法完成这个请求。" }],
          usage: { input_tokens: Math.ceil(chars / CHARS_PER_TOKEN), output_tokens: 12 },
        });
      }

      // 模型"实际看得见"的内容
      let visible = content;
      if (overLimit) {
        if (mode === "silent-truncation") visible = content.slice(-LIMIT_CHARS);        // 掐头
        if (mode === "middle-drop") {
          // 头留 1/4、尾留 1/4，中间 1/2 被砍掉
          const q = Math.floor(content.length / 4);
          visible = content.slice(0, q) + content.slice(content.length - q);
        }
      }
      const seenText = norm(visible);
      const echo = (n) => (seenText.includes(norm(n)) ? n : "MISSING");
      const reply = `${echo(head)}, ${echo(mid)}, ${echo(tailNeedle)}`;

      return send(200, {
        content: [{ type: "text", text: reply }],
        usage: { input_tokens: Math.ceil(chars / CHARS_PER_TOKEN), output_tokens: 16 },
      });
    });
  });
}

function tmpHarnessRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-probe-test-"));
  fs.mkdirSync(path.join(dir, "自定义"), { recursive: true });
  fs.copyFileSync(REAL_TABLE, path.join(dir, "自定义", "模型能力表.json"));
  return dir;
}

/**
 * 必须用异步 spawn —— spawnSync 会阻塞本进程的事件循环，
 * 让同一个进程里的假端点永远收不到请求（表现为探针超时）。
 */
function runProbe(mockPort, harnessRoot, model) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      PROBE, "--probe", "--yes",
      "--model", model,
      "--base-url", `http://127.0.0.1:${mockPort}`,
      "--harness-root", harnessRoot,
      "--token", "mock-token-not-a-secret",
      "--start", "4096",
      "--max", "65536",
      "--bisect", "3",
      "--max-output", "64",
      "--timeout", "10000",
    ], {
      env: { ...process.env, ANTHROPIC_AUTH_TOKEN: "mock-token-not-a-secret" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function readProfile(harnessRoot, model) {
  const dir = path.join(harnessRoot, "state", "model-profiles");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => n.includes(model));
  if (!f) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
}

// ────────────────────────────────────────────────────────────

let failures = 0;
const results = [];
function check(name, cond, detail) {
  results.push(`  ${cond ? "✅ 通过" : "❌ 失败"}  ${name}${detail ? `\n         ${detail}` : ""}`);
  if (!cond) failures++;
}

async function caseFor(mode, model, expectations) {
  const server = makeMock(mode);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const harnessRoot = tmpHarnessRoot();
  try {
    const r = await runProbe(port, harnessRoot, model);
    const profile = readProfile(harnessRoot, model);
    expectations({ r, profile, harnessRoot, results });
  } finally {
    server.close();
    // 自己造的东西自己收走 —— 否则每跑一次就在 %TEMP% 留一个目录（实测积过 32 个）
    try { fs.rmSync(harnessRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

async function main() {
  console.log("待实测项 #3 自检台 —— 静默截断 vs 真支持（零成本，全本机回环）");
  console.log(`假端点物理上限：${LIMIT_CHARS} 字符 ≈ ${LIMIT_CHARS / CHARS_PER_TOKEN} token`);
  console.log("=".repeat(64));

  // ---- A. 端点明确报错 ----
  console.log("\n【A】模式 hard-limit：超限 → 400 报错");
  await caseFor("hard-limit", "mock-hard", ({ profile, results: out }) => {
    check("A1 写入了画像", profile !== null);
    if (!profile) return;
    check("A2 failureMode = HARD_LIMIT",
      profile.probeResult?.failureMode === "HARD_LIMIT",
      `实际：${profile.probeResult?.failureMode}`);
    check("A3 measuredWindow 落在上限附近（8192 ± 30%）",
      profile.measuredWindow >= 8192 * 0.7 && profile.measuredWindow <= 8192 * 1.3,
      `实际：${profile.measuredWindow}`);
    check("A4 安全系数已生效（effectiveWindow = measured × 0.8）",
      profile.effectiveWindow === Math.max(32768, Math.round(profile.measuredWindow * 0.8)),
      `measured=${profile.measuredWindow} effective=${profile.effectiveWindow}`);
  });
  console.log(results.splice(0).join("\n"));

  // ---- B. 端点静默截断（关键：二分法最容易在这里误判）----
  console.log("\n【B】模式 silent-truncation：超限 → 200 OK 但丢掉开头");
  await caseFor("silent-truncation", "mock-silent", ({ profile }) => {
    check("B1 写入了画像", profile !== null);
    if (!profile) return;
    check("B2 ★ failureMode = TRUNCATION（不是 ERROR、也不是被当成真支持）",
      profile.probeResult?.failureMode === "TRUNCATION",
      `实际：${profile.probeResult?.failureMode}`);
    check("B3 measuredWindow 与 A 模式一致（同一个物理上限，±30%）",
      profile.measuredWindow >= 8192 * 0.7 && profile.measuredWindow <= 8192 * 1.3,
      `实际：${profile.measuredWindow}（A 模式同口径）`);
    check("B4 没有把截断点当作真支持（measuredWindow < 上限 × 1.3）",
      profile.measuredWindow < 8192 * 1.3);
  });
  console.log(results.splice(0).join("\n"));

  // ---- B2. 丢中间（★ 只放一个开头针的探针完全测不出这种）----
  console.log("\n【B2】模式 middle-drop：超限 → 200 OK，头尾都留、只砍中间");
  await caseFor("middle-drop", "mock-middle", ({ profile }) => {
    check("B2-1 写入了画像", profile !== null);
    if (!profile) return;
    check("B2-2 ★ failureMode = TRUNCATION（没有被当成真支持）",
      profile.probeResult?.failureMode === "TRUNCATION",
      `实际：${profile.probeResult?.failureMode}`);
    check("B2-3 ★ 细分类型 = MIDDLE_DROPPED（能指出是丢中间，不是掐头）",
      profile.probeResult?.truncationKind === "MIDDLE_DROPPED",
      `实际：${profile.probeResult?.truncationKind}`);
    check("B2-4 measuredWindow 没有超过物理上限的 1.3 倍",
      profile.measuredWindow < 8192 * 1.3,
      `实际：${profile.measuredWindow}`);
  });
  console.log(results.splice(0).join("\n"));

  // ---- C. 探针不适用 ----
  console.log("\n【C】模式 broken：连小尺寸都复述不出随机串");
  await caseFor("broken", "mock-broken", ({ r, profile, harnessRoot }) => {
    check("C1 probe 以非零码退出", r.status !== 0, `实际退出码：${r.status}`);
    check("C2 ★ 没有写入任何画像（不能把无效结论落盘）", profile === null,
      profile ? `却写了：${JSON.stringify(profile.probeResult)}` : "");
    check("C3 stderr 里说明了是「校准失败」",
      /校准失败/.test(r.stderr ?? ""), (r.stderr ?? "").trim().split("\n").slice(-2).join(" / "));
    check("C4 临时目录里没有模型能力相关的残留文件",
      !fs.existsSync(path.join(harnessRoot, "state", "model-profiles", "127.0.0.1-mock-broken.json")));
  });
  console.log(results.splice(0).join("\n"));

  console.log("\n" + "=".repeat(64));
  if (failures === 0) {
    console.log("结论：四种情形全部被正确区分。");
    console.log("  → 待实测项 #3 的『判定逻辑』这一半成立：探针能把静默截断和真支持分开，");
    console.log("     连『丢中间』（头尾都在、只砍中段 —— 只放一个开头针的探针测不出来）也能识别。");
    console.log("  → 剩下那一半（真实端点到底哪种行为）必须靠一次真探测，见 --probe --yes。");
    return 0;
  }
  console.log(`结论：${failures} 项失败，判定逻辑还不成立，先别去花额度。`);
  return 1;
}

process.exitCode = await main();
