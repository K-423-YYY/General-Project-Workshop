/**
 * guard-bash.mjs —— Bash 工具的命令策略闸门
 * 第 2 批 · 机制层（核心）· 交付物 A3
 *
 * 注册在三个事件上（同一个脚本，靠 hook_event_name 分派）：
 *   PreToolUse         → 执行 G1–G6 的拦截
 *   PostToolUse        → 记账（成功）＋ 复位 L1 信号（供 G8 用）
 *   PostToolUseFailure → 退款（「失败不计数」的落点）
 *
 * 为什么需要后两个事件：G4 的定义是「E2E **成功**次数超限才拦，失败不计数」。
 * 只在 PreToolUse 里计数的话，失败也会被算进去，与决策 3 直接冲突。
 *
 * 铁律（03-技术要点与陷阱.md）：
 *   1. 返回 JSON 必写 hookSpecificOutput.hookEventName —— 少了就是静默失效
 *   3. 用 deny，不用 ask
 *   4. matcher 只匹配工具名，所有参数判断都在本脚本里
 *   —— 异常一律 fail-open（exit 0），绝不把用户锁死
 *
 * 第 2 段（日志中心）：G1–G8 的每次 deny / warn 记一行到**工作区根**的
 *   `日志\04-拦截\block-<日期>.jsonl`；G10 包装命令的完整输出落到 `日志\02-命令\`。
 *   ★ 顺序要求：日志永远在**决定之后**写，而且写失败只出声（日志中心内部 fail-open），
 *     绝不能让"记录"这件事改变拦截结果或命令行为。
 */

import fs from "node:fs";
import path from "node:path";
import {
  readEvent,
  projectRoot,
  bypassReason,
  loadState,
  saveState,
  sessionState,
  cmdKey,
  hookStrictness,
  deny,
  warn,
  emit,
  clip,
  LIMITS,
  SRC_EXT,
  E2E_RE,
  L1_RE,
  SED_INPLACE_RE,
  PERL_INPLACE_RE,
  PY_INLINE_RE,
  PY_WRITE_RE,
  redirectTargets,
  parseSleepSeconds,
  isFullCI,
  bashCommand,
} from "./lib/policy.mjs";
import { FILES as LOG_FILES, appendJsonl, resolveLogRoot, stampCompact } from "./lib/log-center.mjs";

// ───────────────────────────────────────────── 04-拦截 的落盘

/** deny/warn 决定里的正文拆成「规则 / 命令 / 原因 / 替代建议」四段，便于事后检索 */
function splitAdvice(text) {
  const s = String(text || "");
  const grab = (label) => {
    const m = s.match(new RegExp(`^\\s*${label}[：:]\\s*(.*)$`, "m"));
    return m ? m[1].trim() : null;
  };
  return {
    what: s.split(/\r?\n/)[0]?.trim() ?? null,
    why: grab("为什么"),
    howTo: grab("怎么做") ?? grab("替代做法"),
    message: clip(s, 4000),
  };
}

/**
 * 每次 deny / warn 记一行到 日志\04-拦截\block-<日期>.jsonl。
 * ★ 只记「拦/警告」，放行的命令不在这里（那是 02-命令\ 的事，由包装器与 G10 负责）。
 * ★ 写日志放在决定之后、输出之前，且内部 fail-open —— 绝不改变拦截结果。
 */
function logDecision(root, ev, cmd, rule, decision) {
  try {
    if (!decision) return;
    const hso = decision.hookSpecificOutput ?? {};
    const level = hso.permissionDecision === "deny" ? "deny" : "warn";
    const text = hso.permissionDecisionReason ?? hso.additionalContext ?? "";
    appendJsonl("block", LOG_FILES.block(), {
      ts: Date.now(),
      time: stampCompact(),
      source: "hook:guard-bash",
      project: root,
      session: ev.session_id ?? ev.sessionId ?? null,
      tool: ev.tool_name ?? "Bash",
      rule: rule ?? "(未标注)",
      decision: level,
      ...splitAdvice(text),
      cmd: clip(String(cmd ?? ""), 2000),
    });
  } catch {
    /* fail-open */
  }
}

/** 逃生阀也要留痕（用了逃生阀 = 自己承担，事后可查） */
function logBypass(root, ev, cmd, reason) {
  try {
    appendJsonl("block", LOG_FILES.block(), {
      ts: Date.now(),
      time: stampCompact(),
      source: "hook:guard-bash",
      project: root,
      session: ev.session_id ?? ev.sessionId ?? null,
      rule: "G0-bypass",
      decision: "bypass",
      why: reason,
      cmd: clip(String(cmd ?? ""), 2000),
    });
  } catch {
    /* fail-open */
  }
}

// ───────────────────────────────────────────── G10 · 长输出命令包装
//
// ★ 为什么在 PreToolUse 而不是 PostToolUse：
//   实测确认（见 shape-output.mjs 头部的完整证据链）——Claude Code v2.1.263 **没有**
//   `updatedToolOutput` 这个字段，PostToolUse 阶段**无法替换**工具输出；
//   而 `decision:block` 只会「追加」一段消息，原文照样完整送达，反而更费 token。
//   唯一能真正决定模型看到多少内容的机制，是 PreToolUse 的 `updatedInput`（改写命令）。
//   用户已就此拍板：只对**窄范围**的命令做改写。
//
// 风险控制（四道）：
//   1. **窄名单**：只包装测试 / 构建 / 类型检查这类「长输出且失败项可枚举」的命令。
//   2. 已经自己管输出的（有重定向到文件）、后台跑的、含 heredoc 的，一律不动。
//   3. 退出码用 `exit $__h_rc` **原样透传** —— 模型的错误处理逻辑不受影响。
//   4. 逃生阀复用既有的 `.harness/bypass` / `HARNESS_BYPASS=1`，另有 HARNESS_NO_REWRITE=1。
const REWRITE_RE =
  /\b(?:vitest|jest|playwright|cypress|mocha|pytest)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|ci|lint|typecheck|check)\b|\btsc\b/i;

/** 已经被本 harness 包装过的命令，不要再套一层 */
const ALREADY_WRAPPED_RE = /__h_rc=|log-summary\.mjs/;

/**
 * 去掉单/双引号**里面**的内容再判。
 * 这样 `echo 'npm test 会跑很久'`、`grep "playwright" README.md` 这类「只是提到」
 * 的命令不会被误判成「真的要跑」。引号里的内容本身就是数据，不是要执行的命令。
 */
function unquote(cmd) {
  return String(cmd || "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function planRewrite(ev, cmd, root) {
  if (process.env.HARNESS_NO_REWRITE === "1") return null;
  if (ev.tool_input?.run_in_background) return null; // 后台任务不该被拦成前台摘要
  if (!cmd || ALREADY_WRAPPED_RE.test(cmd)) return null;
  if (!REWRITE_RE.test(unquote(cmd))) return null;
  if (/<<-?\s*['"]?[A-Za-z_]/.test(cmd)) return null; // heredoc 与 { } 组合易崩，不碰
  // 已经自己把输出写进文件的，说明模型在按硬规则第 4 条做事 —— 不打扰
  if (redirectTargets(cmd).length > 0) return null;

  // ── shell 守卫（第 3 段 · P2-2）────────────────────────────────────────────
  // 下面要产出的命令是 **bash 语法**（`{ … ; } > log 2>&1; … exit $rc`）。
  // 两道闸，任一不过就放弃包装（退化成不干预，命令原样执行）：
  //   ① 显式就知道这条命令不是 bash 在跑（工具名是 cmd/powershell/pwsh）→ 不碰；
  //   ② 这台机器上找不到**真的能用**的 bash（只剩 WSL 垫片也算找不到）→ 不产出跑不通的命令。
  // 为什么值得：产出跑不通的命令 = 把用户的命令搞坏，比不包装差得多。
  const tool = String(ev.tool_name ?? ev.toolName ?? "Bash");
  if (/^(cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)$/i.test(tool)) return null;
  if (!bashCommand()) return null;

  // 完整输出落到**工作区根**的 日志\02-命令\ —— 项目内不再留 .harness\logs\。
  // 找不到日志根（项目被复制到工作区之外）就放弃包装：绝不产出跑不通或写不进去的命令。
  const logRoot = resolveLogRoot({ cwd: root });
  if (!logRoot) return null;

  // 用正斜杠：这是要交给 shell 的字符串，反斜杠在 bash 里是转义符
  const slash = (p) => p.split(path.sep).join("/");
  const logAbs = slash(path.join(logRoot, "02-命令", LOG_FILES.commandOutput(cmdKey(cmd))));
  const summaryAbs = slash(path.join(root, ".claude", "hooks", "log-summary.mjs"));

  // ★ 兜底自检：回显脚本必须真的存在，否则包装后的命令会因为
  //   "Cannot find module" 直接失败 —— 那就是把用户的命令搞坏了。
  //   宁可放弃包装（退化成不干预），也绝不产出一条注定跑不通的命令。
  //   （注意：判的是**真实文件系统路径**，不是上面那个转成正斜杠的字符串。）
  try {
    if (!fs.existsSync(path.join(root, ".claude", "hooks", "log-summary.mjs"))) return null;
  } catch {
    return null;
  }

  // { … ; } 保留原命令的完整语义（含 && / ; / |），只把标准输出与错误**一起**收进日志；
  // 随后由 log-summary 回显「失败项 + 末尾」，最后 exit 原退出码。
  //
  // ★ 第 3 段修的一个真缺陷（真跑 E2E 才暴露）：旧命令直接 `> "<log>"`，
  //   隐含假设「日志目录已经存在」。会话里**第一条**被包装的命令、或日志被清理过之后，
  //   目录并不存在 → bash 的重定向直接失败，用户那条命令根本没跑（还会拿到一个假的退出码）。
  //   现在：先 mkdir -p；目录仍然不可写（只读盘 / 权限问题）就**原样执行用户的命令**，
  //   绝不为了"管输出"把用户的命令搞坏。
  // 目录在 Node 侧建好（不用 shell 的 mkdir）：为什么——
  //   实测 `C:\Program Files\Git\bin\bash.exe` 被非登录方式拉起时，PATH 里可能**没有** MSYS 的
  //   /usr/bin，`mkdir`/`ls` 这类 coreutils 直接 command not found。而 Node 一定在（我们就是从
  //   node 跑起来的），用 Node 建目录最稳，也让改写后的命令不引入新依赖。
  try {
    fs.mkdirSync(path.dirname(logAbs), { recursive: true });
  } catch {
    /* 建不了也没关系：下面那句 `: > 日志文件` 会失败，命令走「不包装」的兜底分支 */
  }
  const command =
    // 可写性用「真的建一下那个文件」来判，不用 `[ -w ]`：
    // MSYS/Git-Bash 在 Windows 上 `test -w` 对刚 mkdir 出来的目录会误报 false（本次实测踩到），
    // 那会让包装整体退化成不包装 —— 测试里表现为「2000 行原样回显」。
    `if : > "${logAbs}" 2>/dev/null; then ` +
    `{ ${cmd} ; } > "${logAbs}" 2>&1; __h_rc=$?; ` +
    `node "${summaryAbs}" "${logAbs}" "$__h_rc"; exit $__h_rc; ` +
    `else ${cmd}; exit $?; fi`;

  return { command, logAbs };
}

/** 命令包装的决定：只改写、**不设 permissionDecision**，正常权限流程照走 */
function rewriteDecision(planned) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: planned, // 调用方传入完整 tool_input（会覆盖 command）
      additionalContext: clip(
        "[harness] 这条命令被 harness 包装了：完整输出会先落盘到工作区根的 日志\\02-命令\\，" +
          "回显给你的是「失败项 + 末尾若干行」。这是为了不让整屏测试日志灌进上下文。" +
          "退出码原样保留；要看更多直接 Read 那个 .log 文件，不要为了看输出重跑命令。" +
          "（确实不想要包装：会话里设 HARNESS_NO_REWRITE=1，或在项目根建 .harness/bypass。）",
        LIMITS.maxContextChars,
      ),
    },
  };
}

// ───────────────────────────────────────────── G1–G6 的判定

/**
 * 返回 `{ decision, rule }`：decision 是 deny / warn 决定对象或 null（放行），
 * rule 是规则号（G1…G10，写进 日志\04-拦截\ 用，不进 stdout —— stdout 只放 Claude Code 认的字段）。
 * 顺序按「最便宜、最不可能误伤」到「最贵」排。
 */
function judgePre(ev, cmd, root, s) {
  // G10 的包装计划先算出来（纯函数、无副作用）。为什么必须在最前面算：
  // 下面 G4/G5 登记 pending 时要拿它当 key —— PostToolUse 回报的 tool_input.command
  // 是**改写后**的那串命令，用原命令当 key 会让配额记账永远对不上账。
  const plan = planRewrite(ev, cmd, root);
  const effective = plan ? plan.command : cmd;

  // ── G6 长 sleep：应当改用 Bash 的 run_in_background
  const sleepSec = parseSleepSeconds(cmd);
  if (sleepSec !== null && sleepSec >= LIMITS.sleepSeconds) {
    if (ev.tool_input?.run_in_background) return { decision: null, rule: null }; // 后台跑 = 正是我们要的做法，放行
    return {
      rule: "G6-sleep",
      decision: deny(
        `检测到前台 sleep ${sleepSec} 秒（阈值 ${LIMITS.sleepSeconds} 秒）`,
        "前台阻塞等待会长时间占住会话，期间没有任何产出；实测这类等待累计烧掉大量时间。",
        "Bash 工具加 run_in_background: true 让它在后台跑，或用轮询命令（如 curl 探测端口）代替盲等。",
      ),
    };
  }

  // ── G1 就地替换改源码
  if (SED_INPLACE_RE.test(cmd) || PERL_INPLACE_RE.test(cmd)) {
    return {
      rule: "G1-inplace-edit",
      decision: deny(
        "检测到用 sed -i / perl -i 就地替换修改文件",
        "内联替换在 Windows 上会静默失配（编码 / 换行 / 正则转义都可能让替换不生效，但退出码仍是 0）——" +
          "本项目历史上已发生多次，每次都要多烧一轮才发现「改了跟没改一样」。",
        "Edit 工具。它是精确字符串替换，匹配不上会明确报错，而不是静默改坏。" +
          "（新增文件用 Write；要批量重构就先 Read 出内容再 Edit。）",
      ),
    };
  }

  // ── G2 用 shell 重定向写源码 / 配置文件
  const targets = redirectTargets(cmd);
  const badTarget = targets.find((t) => SRC_EXT.test(t.replace(/^["']|["']$/g, "")));
  if (badTarget) {
    return {
      rule: "G2-redirect-to-source",
      decision: deny(
        `检测到用 shell 重定向写入源码/配置文件：${badTarget}`,
        "heredoc 与重定向写入绕过了编辑器校验，且引号、$、反引号会被 shell 先行解释，写出来的内容经常不是你想的那样。" +
          "（方案统计里这类写法出现 21 次，是第二大浪费来源。）",
        "Write 工具写新文件、Edit 工具改已有文件。" +
          "（命令输出重定向到 日志\\02-命令\\*.log 不受影响，日志类文件放行。）",
      ),
    };
  }

  // ── G3 Python 内联改码（严格模式直接 deny，标准模式降级为警告）
  if (PY_INLINE_RE.test(cmd) && PY_WRITE_RE.test(cmd)) {
    const strict = hookStrictness(root) === "strict";
    if (strict) {
      return {
        rule: "G3-python-inline-write",
        decision: deny(
          "检测到 Python 内联脚本在改文件（python -c / heredoc 且含写操作）",
          `当前模型（画像 instructionFollowing 偏低）判定为 strict 模式，内联改码不做警告直接拦。` +
            "这类写法在一个项目里出现过 111 次，是最大的单项浪费：它无法回滚、无法 diff、失败后只能整段重写。",
          "Edit 工具做单点替换，或 Write 工具整体重写文件。要计算 / 转换内容就先写到 .harness/ 下的临时文件再 Read。",
        ),
      };
    }
    return {
      rule: "G3-python-inline-write",
      decision: warn(
        "检测到 Python 内联改码。当前为 standard 模式，仅提示：内联改码不可 diff、不可回滚，建议改用 Edit / Write 工具。",
      ),
    };
  }

  // ── G4 全量 E2E 配额（只计成功次数，见 PostToolUse / PostToolUseFailure）
  if (E2E_RE.test(cmd)) {
    if (s.e2e.ok >= LIMITS.e2ePerSession) {
      s.e2e.blocked += 1;
      return {
        rule: "G4-e2e-quota",
        decision: deny(
          `本次会话的全量 E2E 配额已用完（已成功 ${s.e2e.ok} / 上限 ${LIMITS.e2ePerSession} 次）`,
          "全量 E2E 是分钟级、高 token 的操作。「改一行就跑一次全量」是本项目最大的时间黑洞（出现 131 次）。" +
            "失败的运行不计数，所以这里的次数全都是真的跑完过的。",
          "先跑定向单测（npx vitest run <对应测试文件>，秒级）；确认这一层过了再等阶段收尾时用配额跑全量。" +
            "如果确实需要追加：说明理由并让用户执行 env-doctor / 手工改 .claude/state/quota.json 里的本会话 e2e.ok。",
        ),
      };
    }
    // 登记 pending，成功才计入 ok（失败在 PostToolUseFailure 里退款）
    s.pending[cmdKey(effective)] = { kind: "e2e", at: Date.now() };
  }

  // ── G5 全量 CI 配额（定向单测不算，见 isFullCI）
  if (isFullCI(cmd)) {
    if (s.ci.ok >= LIMITS.ciPerSession) {
      s.ci.blocked += 1;
      return {
        rule: "G5-ci-quota",
        decision: deny(
          `本次会话的全量 CI 配额已用完（已成功 ${s.ci.ok} / 上限 ${LIMITS.ciPerSession} 次）`,
          "npm test / npm run ci 跑的是全量套件，属于「任务边界」才该做的事，不适合改动后随手跑。",
          "改动后跑定向单测（npx vitest run src/xxx.spec.ts）。带测试文件路径或带 -- 参数的命令不会被这条拦。",
        ),
      };
    }
    s.pending[cmdKey(effective)] = { kind: "ci", at: Date.now() };
  }

  // ── G10 命令包装（本批新增）
  // 放在所有 deny 判定**之后**：拦截优先于改写 —— 被拦的命令根本不会执行，包装它没有意义。
  if (plan) {
    return {
      rule: "G10-output-rewrite",
      decision: rewriteDecision({ ...(ev.tool_input ?? {}), command: plan.command }),
    };
  }

  return { decision: null, rule: null };
}

// ───────────────────────────────────────────── 事件分派

async function main() {
  const ev = await readEvent();
  if (!ev) return;

  const name = ev.hook_event_name;
  if (name !== "PreToolUse" && name !== "PostToolUse" && name !== "PostToolUseFailure") return;

  const cmd = ev.tool_input?.command ?? "";
  const root = projectRoot(ev);

  // 逃生阀：全部放行（三个事件都放行，保证配额记账也不会卡住）
  const byp = bypassReason(ev);
  if (byp) {
    if (name === "PreToolUse") logBypass(root, ev, cmd, byp);
    return;
  }

  const st = loadState(root);
  const s = sessionState(ev, st);

  if (name === "PreToolUse") {
    const { decision, rule } = judgePre(ev, cmd, root, s);
    saveState(root, st);
    logDecision(root, ev, cmd, rule, decision);
    emit(decision);
    return;
  }

  // ── 后置事件：只记账，绝不产出决定（工具已经跑完了，这里拦不住任何东西）
  const key = cmdKey(cmd);
  const pending = s.pending[key];
  if (pending && Date.now() - (pending.at || 0) < 30 * 60 * 1000) {
    delete s.pending[key];
    if (name === "PostToolUse" && !isFailureResponse(ev)) {
      // 成功：真正计入配额
      if (pending.kind === "e2e") s.e2e.ok += 1;
      if (pending.kind === "ci") s.ci.ok += 1;
    }
    // PostToolUseFailure（或响应带 is_error）→ 不计数，等价于退款
  }

  // L1 定向测试跑成功 → 累加 G8 的软化信号。
  // 语义：l1.sinceEdit = 「距上一次 Edit 以来跑过几次 L1」。
  // 每次 Edit 把它清零（见 guard-tools.mjs），这里每跑成功一次就 +1。
  if (name === "PostToolUse" && L1_RE.test(cmd) && !isFailureResponse(ev)) {
    s.l1.sinceEdit = (s.l1.sinceEdit ?? 0) + 1;
  }

  saveState(root, st);
}

/** 双保险：万一 Bash 的非零退出没走 PostToolUseFailure 而是走了 PostToolUse */
function isFailureResponse(ev) {
  const r = ev.tool_response;
  if (!r || typeof r !== "object") return false;
  if (r.is_error === true || r.isError === true) return true;
  if (typeof r.exit_code === "number" && r.exit_code !== 0) return true;
  if (typeof r.exitCode === "number" && r.exitCode !== 0) return true;
  return false;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // fail-open：钩子自己崩了绝不能让用户无法执行命令，但要在 UI 里喊出来
    try {
      process.stderr.write(
        `[harness] guard-bash.mjs 异常，本次已放行（fail-open）：${clip(err && err.message, 500)}\n`,
      );
    } catch {
      /* 连 stderr 都写不了就算了 */
    }
    process.exit(0);
  });
