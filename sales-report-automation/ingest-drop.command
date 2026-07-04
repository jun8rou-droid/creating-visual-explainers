#!/bin/bash
# Mac: tkinter を使わず、macOS 標準の「ファイルを選ぶ」ダイアログで取り込む（Tcl/Tk クラッシュ回避）。
cd "$(dirname "$0")" || exit 1

# 2つ目のダイアログで CSV を選ぶと JSON 解析エラーになるため、拡張子で事前に弾く（macOS の bash は古いので tr で小文字化）。
reject_non_json_mapping() {
  local p=$1
  local lc
  lc=$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')
  case "$lc" in
    *.json) return 0 ;;
  esac
  osascript -e 'display alert "エラー" message "2つ目のファイル選択では、列マッピング用の .json を選んでください（例: このフォルダの config/nichisho_nissyo.json）。データの CSV は1つ目だけです。同じ CSV を2回選ぶと失敗します。英語ヘッダの CSV だけなら、2つ目はキャンセルしてください。"' 2>/dev/null || true
  return 1
}

choose_file() {
  osascript <<'APPLESCRIPT'
try
  POSIX path of (choose file with prompt "取り込む CSV / TSV を選んでください")
on error number -128
  return ""
end try
APPLESCRIPT
}

choose_config_json() {
  osascript <<'APPLESCRIPT'
try
  POSIX path of (choose file with prompt "列マッピング用の JSON（例: config/nichisho_nissyo.json）を選んでください。英語ヘッダ CSV だけならキャンセル。")
on error number -128
  return ""
end try
APPLESCRIPT
}

CONFIG=""
if [[ $# -ge 2 ]]; then
  FILE=$1
  CONFIG=$2
  reject_non_json_mapping "$CONFIG" || exit 1
elif [[ $# -ge 1 ]]; then
  FILE=$1
  CFG=$(choose_config_json)
  CFG=$(printf '%s' "$CFG" | tr -d '\r')
  if [[ -n "$CFG" && -f "$CFG" && -s "$CFG" ]]; then
    reject_non_json_mapping "$CFG" || exit 1
    CONFIG=$CFG
  fi
else
  FILE=$(choose_file)
  FILE=$(printf '%s' "$FILE" | tr -d '\r')
  if [[ -z "$FILE" ]]; then
    exit 0
  fi
  CFG=$(choose_config_json)
  CFG=$(printf '%s' "$CFG" | tr -d '\r')
  if [[ -n "$CFG" && -f "$CFG" && -s "$CFG" ]]; then
    reject_non_json_mapping "$CFG" || exit 1
    CONFIG=$CFG
  fi
fi

if [[ ! -f "$FILE" ]]; then
  osascript -e 'display alert "エラー" message "ファイルが見つかりません"' 2>/dev/null || true
  exit 1
fi

if [[ -n "$CONFIG" ]]; then
  if [[ ! -f "$CONFIG" ]]; then
    osascript -e 'display alert "エラー" message "マッピング JSON が見つかりません"' 2>/dev/null || true
    exit 1
  fi
  if [[ ! -s "$CONFIG" ]]; then
    osascript -e 'display alert "エラー" message "マッピング JSON が空です。config フォルダの .json を指定してください。"' 2>/dev/null || true
    exit 1
  fi
fi

PY=""
for c in \
  ".venv/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3" \
  "/usr/bin/python3" \
  "/opt/homebrew/bin/python3" \
  "/usr/local/bin/python3"; do
  if [[ -x "$c" ]]; then
    PY=$c
    break
  fi
done

if [[ -z "$PY" ]]; then
  osascript -e 'display alert "エラー" message "Python が見つかりません。.venv を作成してください。"' 2>/dev/null || true
  exit 1
fi

if [[ -n "$CONFIG" ]]; then
  exec "$PY" -m sales_report_automation.simple_ingest "$FILE" "$CONFIG"
fi
exec "$PY" -m sales_report_automation.simple_ingest "$FILE"
