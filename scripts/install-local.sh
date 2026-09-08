#!/bin/bash
set -e

BINARY="$(cd "$(dirname "$0")/.." && pwd)/bin/alice"
LINK="/usr/local/bin/alice"

if [ ! -f "$BINARY" ]; then
  echo "错误：$BINARY 不存在，请先运行 bun run compile"
  exit 1
fi

if [ ! -x "$BINARY" ]; then
  chmod +x "$BINARY"
fi

echo "安装 Alice CLI..."
echo "  二进制：$BINARY"
echo "  链接到：$LINK"

sudo ln -sf "$BINARY" "$LINK"

echo ""
alice --version && echo "安装成功！现在可以在任意目录使用 alice 命令。"
