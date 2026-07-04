#!/bin/bash
# オプション: tkinter の小窓（ドラッグ／ファイル選択）。macOS の Tcl/Tk と相性が悪いとクラッシュするため、
# 通常は ingest-drop.command（ネイティブの選ぶダイアログ）を使ってください。
cd "$(dirname "$0")" || exit 1
for c in ".venv/bin/python3" "/usr/bin/python3"; do
  if [[ -x "$c" ]]; then
    exec "$c" -m sales_report_automation.drag_ingest
  fi
done
exec python3 -m sales_report_automation.drag_ingest
