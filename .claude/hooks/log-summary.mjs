#!/usr/bin/env node
/**
 * log-summary.mjs —— 「命令被包装」之后回显给模型的那份摘要
 * 第 3 批 · 上下文治理 · 配合 G10 的窄范围命令改写
 *
 * 调用方：guard-bash.mjs 把命令改写成
 *     { <原命令> ; } > <日志> 2>&1; rc=$?; node .claude/hooks/log-summary.mjs <日志> $rc; exit $rc
 * 所以本脚本是**被 shell 调用的**，不是 hook，不读 stdin。
 *
 * 它做的事只有一件：把一份可能很大的日志，压成一份「失败项 + 末尾 N 行 + 日志路径」的回显。
 * ★ 硬要求：截断必须保留失败项，不能只留末尾（否则「哪一行挂了」这份最关键的信息会被砍掉）。
 *   这条由 policy.shapeOutput() 保证，本脚本不再自己实现一份。
 *
 * 小日志原样输出 —— 包装不该改变模型对普通命令的观察。
 *
 * 用法：node .claude/hooks/log-summary.mjs <日志路径> <退出码>
 */

import path from "node:path";
import {
  readTextFile,
  shapeOutput,
  clip,
  LIMITS,
} from "./lib/policy.mjs";

const MAX_LINES_SHOWN = 40;
const MAX_OUT_CHARS = 12000;

function main() {
  const [, , logFile, rcArg] = process.argv;
  if (!logFile) {
    process.stderr.write("用法：node .claude/hooks/log-summary.mjs <日志路径> <退出码>\n");
    process.exit(0);
  }

  const rc = Number.isFinite(Number(rcArg)) ? Number(rcArg) : 0;
  const raw = readTextFile(logFile, 8 * 1024 * 1024);

  // 日志读不到 —— 绝不能把结果吞掉，原样说明情况并透传退出码
  if (raw === null) {
    process.stdout.write(`[harness] 无法读取日志文件：${logFile}（退出码 ${rc}）\n`);
    process.exit(0);
  }

  const bytes = Buffer.byteLength(raw, "utf8");

  // 小输出：原样回显，包装对它透明
  if (bytes <= LIMITS.outputShapeBytes) {
    process.stdout.write(raw);
    process.exit(0);
  }

  const shaped = shapeOutput(raw, { tailLines: MAX_LINES_SHOWN });

  // 相对项目根的路径（Read 按会话 cwd 解析；也不把本机绝对路径泄露进上下文）。
  //
  // ★ 不能用 process.cwd() 算：被包装的命令常常是 `cd <子目录> && npm test`，
  //   等本脚本运行时 shell 的 cwd 已经在子目录里了，算出来是 `../../.harness/...`，
  //   只能退化成绝对路径（真会话里实测到过）。
  //   改成**从日志路径自己反推项目根**：日志一定在 <root>/.harness/logs/ 下。
  // ★ 第 2 段（日志中心）：完整输出现在落在**工作区根**的 日志\02-命令\ 下，不再进项目目录
  //   （项目要交付给用户，不能留 harness 的运行痕迹）。
  //   所以这里不再算"相对项目根的路径"——那会算出 `../../日志/...` 这种又长又容易看错的路径，
  //   直接给「相对工作区根」的写法（日志/02-命令/xxx.log）；不在日志中心时原样给绝对路径。
  const norm = String(logFile).replace(/\\/g, "/");
  const at = norm.indexOf("/日志/");
  const shown = at >= 0 ? norm.slice(at + 1) : norm;

  const out = [
    `[harness] 这条命令的输出被 harness 包装过：原始 ${shaped?.totalLines ?? "?"} 行 / ${bytes} 字节，退出码 ${rc}`,
    `完整日志（未截断，可直接 Read）：${shown}　（在工作区根的 日志\\02-命令\\ 下，项目目录里不留日志）`,
    shaped ? shaped.summary : raw.slice(0, MAX_OUT_CHARS),
    `[harness] 上面已是「失败项 + 末尾」的完整摘要。要看更多就 Read 那个 .log 文件 —— 不要为了看输出重跑一遍命令。`,
  ].join("\n");

  process.stdout.write(clip(out, MAX_OUT_CHARS) + "\n");
}

main();
