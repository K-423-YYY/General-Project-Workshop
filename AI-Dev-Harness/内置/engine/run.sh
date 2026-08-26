#!/usr/bin/env bash
# 终端模式入口（可选）。平时推荐直接用客户端对话框。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"            # .../内置/engine
HARNESS="$(cd "$DIR/../.." && pwd)"             # .../AI-Dev-Harness
WORK="$(cd "$HARNESS/.." && pwd)"               # .../本文件夹
PROJECT="${PROJECT_ROOT:-$WORK/我的项目}"
mkdir -p "$PROJECT"
cd "$PROJECT"

GOAL="${*}"
if [ -z "$GOAL" ]; then read -r -p "请输入项目目标: " GOAL; fi

PROMPT="你是通用项目开发助手。请先完整读取并严格遵循工作目录上级的 ../AI-Dev-Harness/自定义/对话协议.md，然后从阶段0开始与我协作。当前工作目录就是项目文件夹。用户目标：$GOAL。要求：全程中文对话、不让用户输入命令、所有路径用相对路径、不开启任何后台常驻进程。"

if command -v codex >/dev/null 2>&1; then
  codex exec "$PROMPT" --sandbox workspace-write --skip-git-repo-check
elif command -v claude >/dev/null 2>&1; then
  claude -p "$PROMPT" --output-format text --dangerously-skip-permissions
elif command -v dsh >/dev/null 2>&1; then
  dsh --profile headless "$PROMPT"
else
  echo "未检测到支持的 AI 引擎，请用客户端对话框。"
  exit 1
fi
