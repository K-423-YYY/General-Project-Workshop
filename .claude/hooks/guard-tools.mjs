/**
 * guard-tools.mjs —— Read / Edit 工具的策略闸门
 * 第 2 批 · 机制层（核心）· 交付物 A4
 *
 * 只实现 G7 / G8 / G12，且**只警告、不拦截**（方案明确要求软化，避免打断合理工作）：
 *   G7  Read  > 400 行的大文件，且本会话第 2 次「全读」→ 提示改用 offset/limit 或交给 Explore 子代理
 *   G8  同一文件第 8 次 Edit，且中途没跑过任何 L1 定向测试 → 提示「你大概在猜，先跑测试」
 *   G12 Read 某个技能的 `SKILL.md` 且体积 > 8 KB → 提示「先看技能索引，别整篇吞」
 *       （为什么需要它：G7 要第 2 次全读才响，而第一次把 86 KB 的 hatch-pet 读进来就已经亏了）
 *
 * 警告走 hookSpecificOutput.additionalContext 注入模型上下文，
 * **不设 permissionDecision**，因此不影响正常权限流程（不会替用户自动批准 Edit）。
 *
 * 第 2 段（日志中心）：每次 warn 记一行到**工作区根**的 `日志\04-拦截\block-<日期>.jsonl`
 *   （规则号 G7 / G8 + 文件 + 建议）。写日志内部 fail-open，绝不影响警告与放行本身。
 *
 * 铁律：返回 JSON 必写 hookSpecificOutput.hookEventName；异常一律 fail-open。
 */

import {
  readEvent,
  projectRoot,
  bypassReason,
  loadState,
  saveState,
  sessionState,
  countLines,
  warn,
  emit,
  clip,
  LIMITS,
} from "./lib/policy.mjs";
import { FILES as LOG_FILES, appendJsonl, stampCompact } from "./lib/log-center.mjs";
import fs from "node:fs";

const BIG_FILE_LINES = LIMITS.bigFileLines; // 400
const EDIT_REPEAT = LIMITS.editRepeat;       // 8
/** G12：技能正文超过这个体积就不该"整篇读"（索引在 自定义\scripts\list-skills.mjs） */
const SKILL_BIG_BYTES = 8 * 1024;
/** 只认"技能目录下的 SKILL.md"，避免误伤普通文件 */
const SKILL_MD_RE = /[\\/]skills[\\/][^\\/]+[\\/]SKILL\.md$/i;

/**
 * 返回 `{ decision, rule }`：decision 是 warn 决定对象或 null，rule 是规则号（G7 / G8）。
 * rule 只用于写日志，不进 stdout（stdout 只放 Claude Code 认的字段）。
 */
function judge(ev, root, s) {
  const fp = ev.tool_input?.file_path;
  if (!fp || typeof fp !== "string") return { decision: null, rule: null };

  const tool = ev.tool_name;

  // ── G7 大文件重复全读
  if (tool === "Read") {
    // 带 offset / limit 的是分段读，正是我们鼓励的做法 —— 不计数也不警告
    const partial = ev.tool_input?.offset !== undefined || ev.tool_input?.limit !== undefined;
    if (partial) return { decision: null, rule: null };

    // ── G12 技能正文整篇读（第一次就提醒，不等第二次）
    if (SKILL_MD_RE.test(fp)) {
      let size = 0;
      try { size = fs.statSync(fp).size; } catch { /* 读不到大小就不判断 */ }
      if (size > SKILL_BIG_BYTES) {
        s.skillBigReads = s.skillBigReads ?? {};
        const n = (s.skillBigReads[fp] = (s.skillBigReads[fp] ?? 0) + 1);
        if (n === 1) {
          return {
            rule: "G12-skill-body-oversize",
            decision: warn(
              `这是技能正文，且体积 ${(size / 1024).toFixed(1)} KB，已超过 8 KB 的"整篇读"阈值：${fp}\n` +
                "技能库有 23 个技能、正文合计约 246 KB —— 全量读是 6~8 万 token 级的浪费，而一次项目最多用 3~5 个。\n" +
                "正确做法：① 先跑 `node AI-Dev-Harness\\自定义\\scripts\\list-skills.mjs` 看索引（约 2 KB，里面有每个技能干什么）；" +
                "② 确认真要用它，再只读这一个技能的正文；③ 超大技能按需读它的 `references\\`（用 Read 的 offset/limit 分段），不要一次吞完。",
            ),
          };
        }
      }
    }

    const info = countLines(fp);
    if (!info || info.truncated || info.lines <= BIG_FILE_LINES) return { decision: null, rule: null };

    s.reads[fp] = (s.reads[fp] || 0) + 1;
    if (s.reads[fp] < 2) return { decision: null, rule: null }; // 第 1 次全读不打扰

    return {
      rule: "G7-big-file-reread",
      decision: warn(
        `这个文件已在本会话里第 ${s.reads[fp]} 次全量读入：${fp}（${info.lines} 行）。\n` +
          "重复全读是纯粹的上下文浪费，而且读第 3 遍通常说明前两遍没记牢。\n" +
          "建议：① 用 Read 的 offset/limit 只读这次真正要动的那一段；" +
          "② 要摸清结构就交给 Explore 子代理，让它读完只回结论，别把全文灌进主上下文；" +
          "③ 上一次读到的关键结论写进 .harness/ 下的笔记，下次直接看笔记。",
      ),
    };
  }

  // ── G8 同一文件反复改
  if (tool === "Edit") {
    s.edits[fp] = (s.edits[fp] || 0) + 1;
    const n = s.edits[fp];
    const l1RanSinceLastEdit = (s.l1?.sinceEdit ?? 0) > 0;

    // 本次 Edit 之后，「距上次 L1 运行」重新归零
    s.l1.sinceEdit = 0;

    if (n < EDIT_REPEAT) return { decision: null, rule: null };
    // 软化：跑过 L1 测试就不警告 —— 那是正常迭代，不是瞎改
    if (l1RanSinceLastEdit) return { decision: null, rule: null };

    return {
      rule: "G8-edit-without-test",
      decision: warn(
        `同一个文件已改到第 ${n} 次，且中途没有跑过任何定向测试：${fp}\n` +
          "文件被反复改、又从不跑测试，通常不是「继续完善」，而是「在猜」。历史上同文件改 19 次的那次事故就是这个形状。\n" +
          "建议：先停下来跑一次定向单测（npx vitest run <对应测试文件>，秒级），拿到真实的失败信息再改；" +
          "如果连续两次改动都没让测试前进，停下来向用户报告，而不是继续试。",
      ),
    };
  }

  return { decision: null, rule: null };
}

/** 每次 warn 记一行到 日志\04-拦截\block-<日期>.jsonl（fail-open，不影响警告本身） */
function logDecision(root, ev, rule, decision) {
  try {
    if (!decision) return;
    const hso = decision.hookSpecificOutput ?? {};
    appendJsonl("block", LOG_FILES.block(), {
      ts: Date.now(),
      time: stampCompact(),
      source: "hook:guard-tools",
      project: root,
      session: ev.session_id ?? ev.sessionId ?? null,
      tool: ev.tool_name ?? null,
      file: ev.tool_input?.file_path ?? null,
      rule: rule ?? "(未标注)",
      decision: "warn",
      message: clip(String(hso.additionalContext ?? ""), 4000),
    });
  } catch {
    /* fail-open */
  }
}

async function main() {
  const ev = await readEvent();
  if (!ev) return;
  if (ev.hook_event_name !== "PreToolUse") return;
  if (ev.tool_name !== "Read" && ev.tool_name !== "Edit") return;

  if (bypassReason(ev)) return;

  const root = projectRoot(ev);
  const st = loadState(root);
  const s = sessionState(ev, st);

  const { decision, rule } = judge(ev, root, s);
  saveState(root, st);
  logDecision(root, ev, rule, decision);
  emit(decision);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    try {
      process.stderr.write(
        `[harness] guard-tools.mjs 异常，本次已放行（fail-open）：${clip(err && err.message, 500)}\n`,
      );
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
