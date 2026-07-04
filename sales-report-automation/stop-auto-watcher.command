#!/bin/bash
# 週次売上自動取り込みの常駐を停止し、自動起動も解除します。
# 再度有効にしたいときは setup-auto-watcher.command をダブルクリックしてください。

set -euo pipefail

LABEL="com.junichiro.sales-report.watcher"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

alert() {
  osascript -e "display alert \"週次売上自動取り込み\" message \"$1\"" >/dev/null 2>&1 || true
}

if [ -f "$PLIST_DEST" ]; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  alert "自動起動を解除しました。\\n\\n手動で取り込みたいときは ./ingest や ingest-drop.command を使ってください。"
  echo "OK: unloaded and removed $PLIST_DEST"
else
  alert "自動起動はもともと設定されていません。"
  echo "INFO: $PLIST_DEST does not exist."
fi
