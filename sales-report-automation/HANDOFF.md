# 週次売上レポート自動化 — 引き継ぎメモ（新チャット用）

会話が長くなったとき用。**新しい Cursor チャットで `@sales-report-automation/HANDOFF.md` を添付**すると文脈を引き継ぎやすい。

## 何のプロジェクトか

- **目的:** 受注 CSV → SQLite 取り込み → 集計・単価欠損候補 → **Anthropic Claude** で週次文案（数値はコード側で確定）。
- **運用想定:** 小規模・ほぼ本人用。本番は **週1 CSV 受信**・JST・週は月曜 08:00 境界（`week_calendar.py`）。

## 主要コマンド

```bash
cd sales-report-automation
source .venv/bin/activate   # 初回: python3 -m venv .venv && pip install -r requirements.txt

# 手動取り込み（短縮: 週は既定 auto）
./ingest sample/week_sample.csv --dry-run
# Windows: ingest.bat sample\week_sample.csv --dry-run
# ドラッグ: Windows は ingest-drop.bat / GUI は ingest-drop-gui.bat
# Mac は ingest-drop.command（標準ファイル選択）· オプション ingest-drop-gui.command（tk 窓）
# または: python3 -m sales_report_automation.simple_ingest sample/week_sample.csv --dry-run

# 手動取り込み（英語ヘッダ CSV・フルコマンド）
python3 -m sales_report_automation --csv sample/week_sample.csv --week 2026-W14 --dry-run

# タブ区切り・列マッピング（手元データ用サンプル）
python3 -m sales_report_automation --csv sample/nissyo_like_tab_sample.tsv \
  --config config/nissyo_tab_export.json --week auto --dry-run

# Web ダッシュ（SQLite を表示）
python3 -m uvicorn sales_report_automation.web:app --port 8080
# → http://127.0.0.1:8080/  （DB: data/report_store.sqlite、環境変数 SALES_REPORT_DB で変更可）

# 受信フォルダ自動取り込み（watchdog）
python3 -m sales_report_automation.watcher --inbox data/inbox --config config/nissyo_tab_export.json --week auto
# 成功 → data/inbox/processed/  失敗 → data/inbox/failed/
```

## 自動投入先（専門家が「届ける先」を実装するとき）

- **投入フォルダ:** `data/inbox/`（**直下のみ**が対象）
- **契約・パス例・watcher 引数:** [data/inbox/README.md](data/inbox/README.md) に集約
- 成功・失敗の退避先: `data/inbox/processed/`、`data/inbox/failed/`

## 追加・変更したファイル（技術）

| 内容 | 場所 |
|------|------|
| CLI パイプライン | `sales_report_automation/pipeline.py` |
| `--week auto` | `week_calendar.py` |
| タブ区切り + `delimiter` | `csv_mapping.py`、設定例 `config/nissyo_tab_export.json` |
| サンプル TSV | `sample/nissyo_like_tab_sample.tsv` |
| Web API + 静的 UI | `web.py`、`static/dashboard.html` |
| 集計 JSON | `dashboard_data.py` |
| フォルダ監視 | `watcher.py`（要 `watchdog`） |
| 依存 | `requirements.txt`（anthropic, fastapi, uvicorn, watchdog） |

## 図解・チェックリスト（リポジトリ別パス）

- モック・ウィザード: `output/sample/`（`sales-report-checklist-wizard.html`、`sales-report-saas-dashboard-mock.html` など）
- チェックリスト本体: `output/sample/sales-report-automation-checklist.md`
- 正本・システム境界ドラフト: `output/sample/sales-report-boundary-and-canonical-draft.md`

## 新チャットで「リフレッシュ」する手順（Cursor）

1. **新しいチャット**を開く（現在のスレッドを閉じる／新規 Composer でも可）。
2. 必要なら **`@sales-report-automation/HANDOFF.md`** または **`@README.md`** をメンション。
3. 直近の作業だけ足す（例: 「メール送信を足したい」）。

**コンテキスト**＝AI が一度に覚えている会話の量。長いと古い部分が切れるので、**引き継ぎファイル＋短い目的**で再開するのが安全。

## いまの完成度（小規模・本人用の感覚）

取り込み〜集計〜AI〜メール（SMTP）〜ダッシュ・inbox 監視まで一通りあり。残りは **上流から `data/inbox/` へ届ける仕組み**（専門家作業）と、運用メモ・DB バックアップ程度で十分なことが多い。
