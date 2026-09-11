# harness：把 自定义/bin/ 前置到 PATH 的兜底（U4）
#
# ★ 第 3 段（P2-3）改了定位：**默认不再挂 BASH_ENV**。
#   原因：BASH_ENV 是「所有非交互 bash」都会读的全局开关，一旦设上，
#   npm / git / 各种构建脚本内部起的 bash 统统被注入 —— 为了兜底一种少见情形
#   （引擎重置 PATH）去扰动所有第三方进程，代价不对称。
#   现在只在 HARNESS_BASH_ENV=1 时由启动器显式设上；本文件本身也必须**幂等 + 失败不致命**。
#
# 约定：HARNESS_BIN_POSIX 由启动脚本提供（Git Bash 需要的 /c/... 形式）；
#       只有 Windows 形式时退回 HARNESS_BIN。
# ⚠️ login shell（`bash -l`）不读 BASH_ENV，本文件对它无效 —— 见 bin/README.md「已知局限」。

# set -u 环境（脚本里常见）下，未定义的变量直接展开会报错 → 用 ${VAR:-} 兜住
_hb_bin="${HARNESS_BIN_POSIX:-${HARNESS_BIN:-}}"

# 目录真的存在才前置；否则宁可不动 PATH（绝不制造一条指向不存在目录的 PATH 项）
if [ -n "$_hb_bin" ] && [ -d "$_hb_bin" ]; then
  case ":$PATH:" in
    *":$_hb_bin:"*)
      : ;; # 已经在 PATH 里 → 幂等，不重复前置
    *)
      PATH="$_hb_bin:$PATH"
      export PATH
      ;;
  esac
fi

# 本文件被 source 到别人的 shell 里，绝不留下自己的痕迹
unset _hb_bin
true
