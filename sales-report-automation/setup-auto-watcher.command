#!/bin/bash
# 週次売上自動取り込みを Mac の起動時に自動で立ち上げるセットアップ。
# このファイルをダブルクリックすると、watcher を裏で常駐させる仕掛けが入ります。
# 解除したいときは stop-auto-watcher.command をダブルクリックしてください。

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.junichiro.sales-report.watcher"
PLIST_TEMPLATE="$PROJECT_DIR/auto-watcher/$LABEL.plist.template"
PLIST_DEST_DIR="$HOME/Library/LaunchAgents"
PLIST_DEST="$PLIST_DEST_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/auto-watcher"

alert() {
  osascript -e "display alert \"週次売上自動取り込み\" message \"$1\"" >/dev/null 2>&1 || true
}

fail() {
  alert "エラー: $1"
  echo "ERROR: $1" >&2
  exit 1
}

# 1) 必須チェック
[ -f "$PLIST_TEMPLATE" ] || fail "plist テンプレートが見つかりません: $PLIST_TEMPLATE"
[ -x "$PROJECT_DIR/.venv/bin/python3" ] || fail "仮想環境(.venv) が見つかりません。先に 'python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt' を済ませてください。"
[ -d "$PROJECT_DIR/data/inbox" ] || mkdir -p "$PROJECT_DIR/data/inbox"
mkdir -p "$LOG_DIR"
mkdir -p "$PLIST_DEST_DIR"

# 2) 既存プロセスがあれば一旦停止
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# 3) テンプレに絶対パスを差し込んで配置
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PLIST_TEMPLATE" > "$PLIST_DEST"

# 4) ロード（次回再起動時はOSが自動で起動する）
launchctl load "$PLIST_DEST"

sleep 1

# 5) 動作確認
if launchctl list | grep -q "$LABEL"; then
  alert "セットアップ完了！\\n\\nこの後はパソコン起動時に自動でwatcherが立ち上がります。\\n\\n使い方: data/inbox/ に CSV を置けば自動で取り込み・メール送信されます。\\n\\nログ: auto-watcher/watcher.log（と watcher.err.log）"
  echo "OK: $LABEL is loaded."
  echo "Logs:"
  echo "  $LOG_DIR/watcher.log"
  echo "  $LOG_DIR/watcher.err.log"
else
  fail "起動確認に失敗しました。$LOG_DIR/watcher.err.log を確認してください。"
fi
