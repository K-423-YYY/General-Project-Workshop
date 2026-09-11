#!/usr/bin/env bash
# 终端模式入口（可选）。平时推荐直接用客户端对话框。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"            # .../内置/engine
HARNESS="$(cd "$DIR/../.." && pwd)"             # .../AI-Dev-Harness
WORK="$(cd "$HARNESS/.." && pwd)"               # .../本文件夹
PROJECT="${PROJECT_ROOT:-$WORK/我的项目}"
mkdir -p "$PROJECT"
cd "$PROJECT"

# ---- 日志中心（第 2 段 · 要求 A）：写环境变量，供所有子进程（hooks / 包装器 / 脚本）复用 ----
# 日志中心在**工作区根**（不在项目里）：项目是要交付的，不能留 harness 的运行痕迹。
LOG_ROOT="$WORK/日志"
export HARNESS_LOG_ROOT="$LOG_ROOT"
LOG_CLI="$HARNESS/自定义/scripts/lib/log-center.mjs"

# 写日志的统一入口：正文从 stdin 读；只追加；失败绝不影响启动（fail-open，但会在终端出声）
harness_log() {
  local cat="$1" file="$2" tmp
  if ! command -v node >/dev/null 2>&1; then echo "日志: 未安装 node，跳过写日志"; cat >/dev/null; return 0; fi
  if [ ! -f "$LOG_CLI" ]; then echo "日志: 缺少 $LOG_CLI，跳过写日志"; cat >/dev/null; return 0; fi
  tmp="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/harness-log-$$-$RANDOM.txt")"
  cat >"$tmp" || true
  node "$LOG_CLI" append --category "$cat" --file "$file" --from "$tmp" >/dev/null ||
    echo "日志: 写入 $cat/$file 失败（不影响启动）"
  rm -f "$tmp" || true
  return 0
}

# ---- 项目内机制层（第 5 批 · A13）：确保 <项目>/.claude/ 存在 ----
# Claude Code 用「会话 cwd」当项目根，不向上寻找 .claude/settings.json；
# 这里 cd 到的就是项目目录，没有 .claude/ 时 hooks 在这条路径上完全不生效。
# --rules none：规则文件由内置 scaffold 与对话协议负责。幂等、fail-open。
SCAFFOLD_EXT="$HARNESS/自定义/scripts/scaffold-ext.mjs"
if command -v node >/dev/null 2>&1 && [ -f "$SCAFFOLD_EXT" ]; then
  if node "$SCAFFOLD_EXT" --project "$PROJECT" --rules none --quiet >/dev/null 2>&1; then
    echo "机制层: .claude/ 已就绪"
  else
    echo "机制层: 未完全就绪（跑 node \"$SCAFFOLD_EXT\" --project . 看详情）"
  fi
fi

GOAL="${*}"
if [ -z "$GOAL" ]; then read -r -p "请输入项目目标: " GOAL; fi

# ---- 引擎选择（第 3 段 · 锁定决策 10）----
# 「装没装」的判定只有一份实现：自定义/scripts/lib/engine-detect.mjs（统一解析器）。
# 这里只负责：列可用引擎 → 回车沿用上次选择 → 落盘记住。
# 非交互（管道 / HARNESS_NONINTERACTIVE=1 / 显式 ENGINE）一律自动挑，绝不阻塞。
ENGINE_DETECT="$HARNESS/自定义/scripts/lib/engine-detect.mjs"
if [ -n "${ENGINE:-}" ]; then
  echo "引擎: 由环境变量 ENGINE 指定 → $ENGINE（跳过选择）"
elif command -v node >/dev/null 2>&1 && [ -f "$ENGINE_DETECT" ]; then
  DEFAULT_ENGINE="$(node "$ENGINE_DETECT" --pick 2>/dev/null || echo unsupported)"
  IDS="$(node "$ENGINE_DETECT" --ids 2>/dev/null || true)"
  N="$(printf '%s\n' "$IDS" | grep -c . || true)"
  if [ "${HARNESS_NONINTERACTIVE:-}" = "1" ] || [ ! -t 0 ] || [ "$N" -le 0 ]; then
    ENGINE="$DEFAULT_ENGINE"
    echo "引擎: 非交互式启动 → $ENGINE（可用引擎 $N 个；要换用 ENGINE=<id>）"
  elif [ "$N" -eq 1 ]; then
    ENGINE="$DEFAULT_ENGINE"
    echo "引擎: 本机只有这一个可用引擎 → $ENGINE"
  else
    echo ""
    echo "── 可用引擎 ──────────────────────────────────────────────"
    node "$ENGINE_DETECT" --list
    echo "──────────────────────────────────────────────────────────"
    printf '选择引擎 [回车 = %s]: ' "$DEFAULT_ENGINE"
    read -r ANS || ANS=""
    ENGINE="$DEFAULT_ENGINE"
    if [ -n "$ANS" ]; then
      case "$ANS" in
        *[!0-9]*)
          # 不是纯数字 → 当作引擎 id 试一把
          if printf '%s\n' "$IDS" | grep -qx "$ANS"; then
            ENGINE="$ANS"
          else
            echo "输入无法识别（$ANS）→ 沿用默认：$DEFAULT_ENGINE"
          fi
          ;;
        *)
          # 编号 → 取第 N 个可用引擎
          PICKED="$(printf '%s\n' "$IDS" | sed -n "${ANS}p")"
          if [ -n "$PICKED" ]; then ENGINE="$PICKED"; else echo "编号 $ANS 超出范围 → 沿用默认：$DEFAULT_ENGINE"; fi
          ;;
      esac
    fi
  fi
  [ -n "${ENGINE:-}" ] && node "$ENGINE_DETECT" --remember "$ENGINE" >/dev/null 2>&1 || true
else
  if command -v codex >/dev/null 2>&1; then ENGINE=codex-cli
  elif command -v claude >/dev/null 2>&1; then ENGINE=claude-code
  elif command -v dsh >/dev/null 2>&1; then ENGINE=deepseek-harness
  else echo "未检测到支持的 AI 引擎，请用客户端对话框。"; exit 1
  fi
fi

if [ -z "${ENGINE:-}" ] || [ "$ENGINE" = "unsupported" ]; then
  echo "未检测到支持的 AI 引擎（codex / claude / dsh / traecode / Trae IDE / Claude 桌面端）。"
  echo "请先安装其一，或直接打开客户端对话框手动开项目。"
  exit 1
fi
export HARNESS_ROOT="$HARNESS"
ENGINE_KIND="cli"
case "$ENGINE" in
  claude-code-desktop|trae-ide) ENGINE_KIND="desktop" ;;
esac
echo "识别引擎: $ENGINE | 项目: $PROJECT"
echo ""

# ---- 命令包装器（第 7 批 · U4）：把 自定义/bin/ 前置到 PATH ----
# AI 无论用什么引擎，改代码都要通过 shell 执行命令；前置 PATH 后 sed / perl / python /
# sleep / npx / npm / playwright 都会先命中 harness 的包装器：违规拦下、其余原样执行，
# 两种情况都记入 **工作区根** 的 日志/02-命令/cmd-<日期>.jsonl（供 audit.mjs 审计）；
# 被拦下的再记一行到 日志/04-拦截/block-<日期>.jsonl。
# 边界：只对通过本脚本启动的会话生效。
HARNESS_BIN="$HARNESS/自定义/bin"
if command -v node >/dev/null 2>&1 && [ -d "$HARNESS_BIN" ]; then
  PATH="$HARNESS_BIN:$PATH"
  export PATH
  export HARNESS_BIN HARNESS_PROJECT="$PROJECT" HARNESS_ENGINE="$ENGINE"
  export HARNESS_BIN_POSIX="$HARNESS_BIN"
  # BASH_ENV 收敛（第 3 段 · P2-3）：默认**不设** —— 全局 BASH_ENV 会注入到
  # npm / git 等第三方进程内部的非登录 bash 里，属于"为了兜底一种少见情形扰动所有子进程"。
  # 确实需要时用 HARNESS_BASH_ENV=1 显式开启（_env.sh 自身幂等、失败不致命）。
  if [ "${HARNESS_BASH_ENV:-}" = "1" ] && [ -f "$HARNESS_BIN/_env.sh" ]; then
    export BASH_ENV="$HARNESS_BIN/_env.sh"
    echo "命令包装: 已按 HARNESS_BASH_ENV=1 额外设 BASH_ENV（只影响非登录 bash）"
  fi
  export HARNESS_SESSION_KEY="$(date +%Y%m%d-%H%M%S)-$$"
  echo "命令包装: 已前置 自定义/bin（跨引擎强制层）"
fi

# ---- 启动词：统一由 自定义/scripts/build-prompt.mjs 拼装（内联 40 行硬规则）----
# 这样 Codex / Claude Code / DeepSeek Harness 拿到的都是同一份硬规则。
BUILD_PROMPT="$HARNESS/自定义/scripts/build-prompt.mjs"
if [ ! -f "$BUILD_PROMPT" ]; then
  echo "缺少启动词生成脚本：$BUILD_PROMPT"
  exit 1
fi
PROMPT="$(node "$BUILD_PROMPT" --engine "$ENGINE" --goal "$GOAL")"
if [ -z "$PROMPT" ]; then
  echo "启动词生成失败（build-prompt.mjs 没有输出）。"
  exit 1
fi

# ---- 日志中心：启动词快照（01-会话）+ 本次引擎与机制层状态（06-引擎）----
# 事后复盘最常问的三件事：这一会话是谁在跑、机制层有没有真的生效、喂进去的启动词是什么。
STAMP_FULL="$(date '+%Y-%m-%d %H:%M:%S')"
STAMP_COMPACT="$(date '+%Y%m%d-%H%M%S')"
DAY_FILE="$(date '+%Y-%m-%d')"
MECHANISM="未生效"
if [ -f "$PROJECT/.claude/settings.json" ] && [ -f "$PROJECT/.claude/hooks/guard-bash.mjs" ]; then
  MECHANISM="生效"
fi
WRAPPER="未生效"; [ -n "${HARNESS_BIN:-}" ] && WRAPPER="生效"

# 「本次引擎 + 机制层到底生效没有」—— 按**引擎形态**分别判，不糊弄成一个笼统的绿灯。
# hooks 是 Claude Code 专属；Codex 的 hooks 要用户合并 ~/.codex/config.toml 才存在；
# DSH / Trae 根本没有 hooks。笼统报「已生效」= 让用户以为有拦截，其实没有（假绿）。
MECH_KIND="none"; MECH_OK="no"; MECH_TEXT="⚠️ 未知引擎 → 机制层状态未知"
case "$ENGINE" in
  claude-code)
    MECH_KIND="hooks"
    if [ "$MECHANISM" = "生效" ]; then MECH_OK="yes"; MECH_TEXT="✅ hooks 已生效（项目内 .claude/：6 个事件 + statusLine）"
    else MECH_TEXT="❌ hooks 未就位（项目内 .claude/settings.json 或 hooks 缺失）"; fi ;;
  claude-code-desktop)
    MECH_KIND="hooks"
    if [ "$MECHANISM" = "生效" ]; then MECH_OK="yes"; MECH_TEXT="✅ 同一套 hooks 已就位 —— 只有在项目目录里开会话才生效"
    else MECH_TEXT="❌ hooks 未就位（项目内 .claude/ 缺失）"; fi ;;
  codex-cli)
    MECH_KIND="wrapper+prompt"
    if [ -f "$HOME/.codex/config.toml" ] && grep -q 'hook-guard\.mjs' "$HOME/.codex/config.toml" 2>/dev/null; then
      MECH_OK="yes"; MECH_TEXT="✅ Codex hooks 已配置（~/.codex/config.toml 里有 hook-guard）；真会话未实测"
    else
      MECH_TEXT="⚠️ Codex hooks 未配置 → 本会话强制手段是「命令包装 + 启动词」；要开 hooks 见 自定义/引擎适配/codex/config-hooks.toml"
    fi ;;
  deepseek-harness)
    MECH_KIND="wrapper+prompt"
    MECH_TEXT="⚠️ DSH 无 hooks → 强制手段是「命令包装 + --patch 层 + 启动词」" ;;
  traecode-cli)
    MECH_KIND="wrapper+prompt"
    MECH_TEXT="⚠️ TraeCode CLI 机制层未查明 → 强制手段是「命令包装 + 启动词」" ;;
  trae-ide)
    MECH_KIND="prompt"
    MECH_TEXT="⚠️ 图形端无法注入 hooks → 只靠「.trae/rules/ + 启动词」（模型自觉）" ;;
esac

harness_log '01-会话' "session-$DAY_FILE.md" <<EOF

## 启动快照 $STAMP_FULL

- 引擎：$ENGINE（$ENGINE_KIND）
- 项目根：$PROJECT
- 工作区根：$WORK
- 日志根：$LOG_ROOT
- 机制层（档位 $MECH_KIND）：$MECH_TEXT
- 命令包装（自定义/bin 前置 PATH）：$WRAPPER
- 目标：$GOAL

启动词（已内联硬规则与上次审计摘要）：

~~~text
$PROMPT
~~~
EOF

harness_log '06-引擎' "session-$STAMP_COMPACT.md" <<EOF
# 本次会话 · 引擎与机制层（$STAMP_FULL）

- 引擎：**$ENGINE**（$ENGINE_KIND）
- 机制层：**$MECH_TEXT**
- 机制层档位：$MECH_KIND（hooks = 引擎事件强制；wrapper+prompt = 命令包装 + 启动词；prompt = 只靠启动词）
- 机制层判据（Claude 系）：.claude/settings.json 与 hooks/guard-bash.mjs 都在 = $MECHANISM
- 命令包装是否生效：$WRAPPER
- 项目根：$PROJECT
- 日志根：$LOG_ROOT
- 说明：Codex / DSH / Trae 不用 .claude/ 机制层，它们的强制手段是命令包装 + 启动词（见 自定义/引擎适配/ 与 引擎能力矩阵）。
EOF

# ── 「harness 真的起来了」横幅（第 3 段 · 锁定决策 10）──
# 用「左竖线 + 内容」的写法，不画右边框：中文是双宽字符，bash 里算显示宽度要引 unicode 表，
# 排版歪掉比不画框更糟。信息一条不少。
echo ""
echo "┌──────────────────────────────────────────────────────────"
echo "│ harness 已启动"
echo "│ 本次引擎   $ENGINE ($ENGINE_KIND)"
echo "│ 机制层     $MECH_OK / 档位 $MECH_KIND"
echo "│ 命令包装   $WRAPPER"
echo "│ 日志中心   日志/（06-引擎 已记本次会话）"
echo "│ 项目       $PROJECT"
echo "└──────────────────────────────────────────────────────────"
echo "机制层详情: $MECH_TEXT"
echo ""

case "$ENGINE" in
  codex-cli)        codex exec "$PROMPT" --sandbox workspace-write --skip-git-repo-check ;;
  claude-code)      claude -p "$PROMPT" --output-format text --dangerously-skip-permissions ;;
  deepseek-harness) dsh --profile headless "$PROMPT" ;;
  claude-code-desktop|trae-ide|traecode-cli)
    # 图形端 / 未查明的 CLI：没有可注入的接口 → 落启动词 + 给下一步（绝不假装启动了）
    HARNESS_DIR="$PROJECT/.harness"
    mkdir -p "$HARNESS_DIR"
    printf '%s\n' "$PROMPT" > "$HARNESS_DIR/exec-prompt.md"
    echo ""
    echo "下一步（顺序别换）:"
    echo "  1. 打开图形端，选择/打开这个项目目录：$PROJECT"
    echo "     （Claude Code 用会话 cwd 当项目根、不向上寻找 —— 在别处开会话，hooks 完全不生效）"
    echo "  2. 新开一个会话，把启动词整段粘进去。启动词也在这份文件里：$HARNESS_DIR/exec-prompt.md"
    ;;
esac
