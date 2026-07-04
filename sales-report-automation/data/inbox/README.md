# 週次 CSV の自動投入先（inbox）

外部の仕組み（ジョブ・FTP・共有フォルダ同期など）が **ここにファイルを置く**前提のフォルダです。  
**ファイル監視（watcher）**を起動している PC 上で、この **直下** に届けます。

## パス（相対・絶対）

| 役割 | 相対パス（`sales-report-automation` をカレントにしたとき） |
|------|------------------------------------------------------------|
| **投入先（ここに置く）** | `data/inbox/` |
| 成功後の退避 | `data/inbox/processed/` |
| 失敗時の退避 | `data/inbox/failed/` |

**絶対パス**は環境ごとに違います。専門家向けには例えば次のように渡せます。

```text
<このリポジトリを置いたディレクトリ>/sales-report-automation/data/inbox
```

実際の文字列は、そのマシンで `cd sales-report-automation && pwd` と `echo "$PWD/data/inbox"` で確定してください。

## ファイルのルール（契約のたたき台）

- **置き場所:** `data/inbox/` の **直下のみ**（サブフォルダ内は watcher が見ません）。
- **拡張子:** `.csv` / `.tsv` / `.txt`
- **隠しファイル:** 名前が `.` で始まるものは無視されます。
- **ファイル名:** 現状のツールは **名前に依存せず**、中身の `ship_date` などで週を推定します。後から「`weekly_*.csv` に統一」などの命名規則を足してもよいです。

## watcher 起動例（専門家が常駐させるとき）

```bash
cd sales-report-automation
source .venv/bin/activate
set -a && source .env && set +a
python3 -m sales_report_automation.watcher \
  --inbox data/inbox \
  --config config/nissyo_tab_export.json \
  --week auto
```

- 列マッピングが不要な **英語ヘッダ CSV だけ**なら **`--config` 行を省略**してください。
- 試験中は README にあるとおり **`--dry-run`** や **`--no-move`** も利用できます。

## 運用上の注意

- 投入は **コピー完了後**に検知されます（短い待ちあり）。
- **`.env` の SMTP 等**が揃っている環境で watcher を動かすと、取り込み成功後に **週次メールも送る**動きになります（試験時は `--dry-run` やメール側の運用で制御してください）。
