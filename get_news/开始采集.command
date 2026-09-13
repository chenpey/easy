#!/bin/zsh
set -e
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "未找到 uv，请先安装：brew install uv"; exit 1; }
unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT
uv sync --locked
uv run --locked src/pipeline.py prepare
echo "粗筛已完成。请让当前会话模型按 judge/INSTRUCTIONS.md 判断，再通过 uv run 执行 finish。"
