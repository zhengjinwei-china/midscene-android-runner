#!/bin/bash
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  osascript -e 'display alert "未找到 npm，请先安装 Node.js" as critical'
  exit 1
fi
if [ ! -d node_modules ]; then
  npm install
fi
open "http://127.0.0.1:3920" 2>/dev/null || true
echo "控制台地址：http://127.0.0.1:3920"
echo "关闭本窗口即停止服务。"
exec npm run dev
