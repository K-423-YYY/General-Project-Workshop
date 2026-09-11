/**
 * shape-output.mjs —— Bash 长输出治理（G10）
 * 第 3 批 · 上下文治理 · 交付物 A5
 *
 * 事件：PostToolUse **和** PostToolUseFailure（matcher: Bash）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 本批实测：方案原文指定的机制在 Claude Code v2.1.263 上不成立 ★★
 * ══════════════════════════════════════════════════════════════════════
 *
 * `02-改进方案/02-逐项改动清单.md` 的 A5 与 `03-技术要点与陷阱.md` § 9 都写着：
 * 用 PostToolUse 的 `hookSpecificOutput.updatedToolOutput` 替换工具输出。
 *
 * **实测结论：该字段在 v2.1.263 上不存在。** 三条独立证据：
 *   1. 真会话实测：hook 确实跑了（诊断日志有记录、日志文件已落盘），
 *      但模型仍然看到完整的 300 行原始输出 —— 替换没有发生。
 *   2. 本机 `claude.exe` 内嵌的 hooks 文档（v2.1.263）里，
 *      `hookSpecificOutput` 的合法字段只有：
 *        `additionalContext` / `permissionDecision` / `permissionDecisionReason` / `updatedInput`
 *      —— **没有 `updatedToolOutput`**，也没有 `updatedMCPToolOutput`。
 *   3. 改用 `{"decision":"block","reason":…}` 实测：模型**确实收到了** reason，
 *      但**原始输出仍然完整送达** —— 即该机制只会「追加」，不会「替换」，反而更费 token。
 *
 * 因此：**「在 PostToolUse 阶段替换工具输出」这条路在本版本上走不通。**
 * 唯一能真正左右模型看到多少内容的机制是 **PreToolUse 的 `updatedInput`（改写命令）** ——
 * 那条路属于命令包装（方案里的 U4 / F7 / 第 7 批），有打破命令的风险，需用户拍板。
 *
 * 本脚本因此只保留**确定成立**的那一半职责，并且做事极其克制：
 *   ✅ 完整原始输出落盘到**工作区根** 日志\02-命令\（一个字节都不丢，供 verify-gate / 事后复查；
 *      第 2 段从项目内 .harness\logs\ 迁出 —— 项目要交付，不能留 harness 的运行痕迹）
 *   ✅ 长输出时附一条**极短**的提示（只给日志路径，不带摘要正文，避免「追加」变成负担）
 *   ❌ 不尝试替换输出（做不到）
 *
 * 关键的「保留失败项」逻辑仍在 policy.shapeOutput() 里且已被自检台覆盖，
 * 一旦将来版本支持替换（或用户批准改写命令），可以直接接上，不用重写。
 *
 * 铁律：异常一律 fail-open（exit 0 且不输出），绝不因为整形失败而吞掉工具输出。
 */

import {
  readEvent,
  projectRoot,
  cmdKey,
  clip,
  LIMITS,
  toolResponseText,
  toolExitCode,
} from "./lib/policy.mjs";
import { FILES as LOG_FILES, appendJsonl, appendLog, resolveLogRoot } from "./lib/log-center.mjs";

/**
 * 诊断开关：`HARNESS_DEBUG=1` 时，把「这次事件我到底收到了什么」记一行到
 * 工作区根 `日志\02-命令\shape-debug-<日期>.jsonl`。默认关闭。
 *
 * 为什么值得留着：本批就是靠它定位到「非零退出走 PostToolUseFailure、且该事件没有 tool_response」
 * 这个方案没预料到的事实。将来 Claude Code 升级改了载荷结构，这一行能第一时间看出来。
 */
function debug(root, ev, text) {
  if (process.env.HARNESS_DEBUG !== "1") return;
  try {
    const r = ev?.tool_response;
    appendJsonl(
      "command",
      LOG_FILES.shapeDebug(),
      {
        ts: new Date().toISOString(),
        event: ev?.hook_event_name,
        cmd: String(ev?.tool_input?.command ?? "").slice(0, 120),
        responseKeys: r && typeof r === "object" ? Object.keys(r) : typeof r,
        errorBytes: typeof ev?.error === "string" ? Buffer.byteLength(ev.error, "utf8") : null,
        extractedBytes: Buffer.byteLength(text, "utf8"),
        threshold: LIMITS.outputShapeBytes,
      },
      { logRoot: resolveLogRoot({ cwd: root }) ?? undefined },
    );
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

/**
 * ★★ 实测发现的真问题（原方案没预料到）★★
 *
 * `Bash` 的**非零退出**根本不走 `PostToolUse`，而是走 `PostToolUseFailure`；
 * 而 `PostToolUseFailure` **没有 `tool_response`** 字段 —— 原始输出以**字符串**形式塞在 `error` 里，
 * 形如 `"Exit code 1\n<stdout>…"`（实测：300 行日志 → error 16104 字节）。
 *
 * 后果：只挂在 PostToolUse 上的话，「长失败日志」这个**恰恰最该被治理**的场景永远不触发，
 * 而它正是方案点名要治的那个（「改一行 → 跑全量 → 刷屏」）。
 * 所以本脚本两个事件都挂，并在这里把两种载荷归一化。
 */
function extract(ev) {
  if (ev.hook_event_name === "PostToolUseFailure") {
    const err = typeof ev.error === "string" ? ev.error : "";
    const m = err.match(/^Exit code (-?\d+)\r?\n/);
    return { text: m ? err.slice(m[0].length) : err, exitCode: m ? Number(m[1]) : null };
  }
  return { text: toolResponseText(ev), exitCode: toolExitCode(ev) };
}

async function main() {
  const ev = await readEvent();
  if (!ev) return;
  const eventName = ev.hook_event_name;
  if (eventName !== "PostToolUse" && eventName !== "PostToolUseFailure") return;
  if (ev.tool_name !== "Bash") return;

  const root = projectRoot(ev);
  const { text, exitCode } = extract(ev);
  debug(root, ev, text);

  if (!text) return;

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= LIMITS.outputShapeBytes) return; // 没超阈值，完全不干预

  const cmd = ev.tool_input?.command ?? "";
  const logRoot = resolveLogRoot({ cwd: root });
  if (!logRoot) return; // 找不到日志根 → 不干预（绝不给出一个指向不存在位置的提示）
  const logName = LOG_FILES.commandOutput(cmdKey(cmd));

  // ① 完整输出落盘（本脚本当前**确定成立**的唯一职责）
  const written = appendLog("command", { file: logName, text, logRoot });
  if (!written.ok) return;
  const logPath = written.path;

  // ② 给一个"能直接 Read"的路径。
  //    ★ 第 2 段权衡：日志现在在工作区根（项目外），已经**不存在**"相对项目根"的写法
  //      （只会算出 `..\..\日志\...` 这种看错率极高的路径）。所以这里给绝对路径 ——
  //      G10 的立身之本是"要看更多就去 Read 那个文件"，路径不可达等于逼模型重跑长命令。
  const relLogPath = logPath;

  // ③ 只加**一行**提示。
  //    注意：v2.1.263 无法替换工具输出，所以这条提示是**追加**在原文之后的。
  //    既然原文一个字都省不掉，这里就必须极度克制 —— 只给路径，绝不重复摘要正文，
  //    否则等于在已经超长的输出上再加一段，适得其反。
  const notice =
    `\n\n[harness] 本次输出 ${bytes} 字节（> ${LIMITS.outputShapeBytes}），` +
    `完整原文已落盘：${relLogPath}` +
    `${exitCode === null ? "" : `（退出码 ${exitCode}）`}` +
    `\n如需复查，直接 Read 这个文件；不要重新跑一遍命令。`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: clip(notice, LIMITS.maxContextChars),
      },
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    // 任何异常都必须放行原文：这里什么都不输出
    process.exit(0);
  });
