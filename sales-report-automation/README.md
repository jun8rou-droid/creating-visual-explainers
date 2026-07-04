# 週次売上レポート自動化（MVP）

CSV を SQLite に取り込み、集計・単価欠損の候補（過去行から）を付けたうえで、**Anthropic Claude** に週次文案を書かせます。数値の確定はこのツール側、LLM は文章のみ、という前提です。**文案のトーン**は `.env` の `SALES_REPORT_SUMMARY_STYLE`、または `--report-style` / `--report-style-file`（`python -m sales_report_automation` および `simple_ingest`・`watcher` で利用可）に「こんな感じで」と追指示を書けます（`--dry-run` の JSON にも `report_style_instructions` として載ります）。

**これからの進め方（新卒・担当引き継ぎ向け）:**  
[これからの進め方（フェーズ 1〜4、ブラウザ向け）](../output/sample/sales-report-onboarding-flow.html)／[Markdown 版](../output/sample/sales-report-onboarding-flow.md) に、読む順・社内で決めること・手元で試すこと・本番に近づけることを順番付きで書いています。

**用語がわからないとき:**  
[用語集](../output/sample/sales-report-glossary.md)（CSV・SQLite・API・`--dry-run` など）。

## 必要なもの

- Python 3.10+
- `ANTHROPIC_API_KEY`（文案生成時。`--dry-run` なら不要）

## セットアップ

```bash
cd sales-report-automation
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # 任意: direnv 等で読み込み
export ANTHROPIC_API_KEY='sk-ant-...'
```

## Windows で使う

**コマンド プロンプト**または **PowerShell** で `sales-report-automation` フォルダを開いたうえで:

```bat
py -3 -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

`python` が通らない場合は **`py -3`** のまま使うか、[python.org](https://www.python.org/downloads/) インストーラで **「Add python.exe to PATH」**にチェックを入れて入れ直してください。

**環境変数（`.env`）** … Mac の `source .env` に相当する処理は、Windows では標準では一発ではありません。次のどれかで十分です。

- **手動:** システムの「環境変数」に `ANTHROPIC_API_KEY` などを登録する。  
- **PowerShell（そのウィンドウだけ有効）:** `.env` を1行ずつ読み込む例（`#` 始まりは無視）:

```powershell
Get-Content .env | ForEach-Object {
  $t = $_.Trim()
  if ($t -and -not $t.StartsWith('#')) {
    $i = $t.IndexOf('=')
    if ($i -gt 0) {
      $k = $t.Substring(0, $i).Trim()
      $v = $t.Substring($i + 1).Trim().Trim('"')
      Set-Item -Path "env:$k" -Value $v
    }
  }
}
```

**かんたん取り込み:** Mac の `./ingest` に相当する **`ingest.bat`** を同梱しています。

```bat
.\.venv\Scripts\activate
ingest.bat sample\week_sample.csv --dry-run
```

**`ingest`（bash）**は Git for Windows の **Git Bash** があればそのまま使えます。

## 他のPCで使う（配布・引き継ぎ）

**配布**＝「このツールを別のパソコンでも同じように動かす」ことです。次のどれかでリポジトリ（このフォルダ一式）を渡せます。

| 方法 | 向いていること |
|------|----------------|
| **Git** で `git clone` | いちばんきれい。更新も `git pull` で揃えやすい。 |
| **ZIP にして共有** | 社内メール・共有ドライブで `sales-report-automation` フォルダを渡す。`.git` を除いてよい。 |

**別PCで必ずやること（チェックリスト）**

1. **Python 3.10 以上**を入れる（Mac / Linux: `python3 --version`、Windows: `py -3 --version` など）。  
2. フォルダに `cd` し、**そのPCの中で**仮想環境を作り直す（**`.venv` はPCごとに作る**。他人のPCからコピーして使わない方が安全）。  
3. `pip install -r requirements.txt` を**そのPCで**実行。  
4. 文案を出すPCでは **`ANTHROPIC_API_KEY`** を、各自の環境に設定（**APIキーはチャットに貼らない・リポジトリに入れない**）。  
5. **列マッピング**（`config/*.json`）と **受信フォルダ**（`data/inbox` 等）のパスは、OS ごとに違うので、**手順書に「自PCの絶対パス例」を書かず、相対パス＋`cd` の手順**にしておくと他PCでも迷いにくい。  
6. **SQLite**（`data/report_store.sqlite`）は**PCごと**に作られる。共有したい場合は、共有ドライブ上の1ファイルに `--db` を揃えるか、DB は「各PCのローカル」でよい、と決める。

**まとめ:** コピーするのは**ソースと設定ファイル**で、**仮想環境とDBは各PCで作り直す**のがおすすめです。

## CSV の列（ヘッダ名はこの通り）

| 列名 | 説明 |
|------|------|
| `customer_code` | 顧客コード |
| `product_code` | 品目コード |
| `quantity` | 数量（空可） |
| `unit_price` | 単価（空なら候補探索対象） |
| `amount` | 金額（必須） |
| `ship_date` | 出荷日（例: 2026-04-01） |

## 使い方

### かんたん手動取り込み（おすすめ）

**`--week auto` を毎回書かなくてよい**短縮コマンドです（中身はいつものパイプラインと同じ）。

```bash
cd sales-report-automation
source .venv/bin/activate   # 初回セットアップ済みなら

# 方法1: シェルスクリプト（.venv を自動で有効化）
./ingest sample/week_sample.csv --dry-run
./ingest sample/nissyo_like_tab_sample.tsv config/nissyo_tab_export.json --dry-run

# 方法2: Python モジュール（どちらでも可）
python3 -m sales_report_automation.simple_ingest sample/week_sample.csv --dry-run
```

**Windows（コマンド プロンプト）**の例:

```bat
cd sales-report-automation
.\.venv\Scripts\activate
ingest.bat sample\week_sample.csv --dry-run
py -3 -m sales_report_automation.simple_ingest sample\week_sample.csv --dry-run
```

`--dry-run`・`--replace-week`・`--no-mail`・`--week 2026-W14`・`--db` もそのまま使えます。2つ目の引数に **マッピング JSON** を置くと `--config` 付きと同じです。

### ドラッグ＆ドロップで取り込む（ターミナル不要でも可）

- **`.env` の自動読み込み:** `pipeline` / `simple_ingest` 起動時に、**未設定の環境変数だけ**プロジェクト直下の `.env` から埋めます（シェルで `export` 済みの値は上書きしません）。
- **Windows:** **`ingest-drop.bat`** に CSV/TSV をドラッグ＆ドロップすると、そのファイルで取り込みが走ります（週は `auto`）。
- **Mac（推奨）:** **`ingest-drop.command`** をダブルクリックすると、**CSV/TSV を選ぶダイアログ**のあと、**列マッピング用 JSON を選ぶダイアログ**が続きます（**英語ヘッダだけの CSV ならキャンセル**でスキップ）。**Python の tkinter を使わない**ため、Tcl/Tk 起因のクラッシュを避けやすいです。結果は **ターミナル**に表示されます。
- **Mac（オプション・上級者向け）:** **`ingest-drop-gui.command`** は **tkinter の小窓**版です。環境によっては起動時に落ちることがあります。
- **Windows の tk ウィンドウ:** **`ingest-drop-gui.bat`**（ドラッグ／ファイル選択）。
- **Python の探し方（Mac）:** `.venv` → **python.org** の `/Library/Frameworks/...` → `/usr/bin/python3` → Homebrew の順に試します。
- **列マッピングが必要な TSV 等**は、**`ingest-drop.command` からは `config` を渡せない**ため、**従来どおり** `./ingest ファイル 設定.json` またはフル CLI を使ってください。

### 従来どおり（フルオプション）

```bash
# 文案まで出さず、LLM に渡す JSON だけ確認
python -m sales_report_automation --csv sample/week_sample.csv --week 2026-W14 --dry-run

# ship_date から週を決める（単一週は推定。複数週にまたがる CSV は週ごとに自動分割して順に処理）
python -m sales_report_automation --csv sample/week_sample.csv --week auto --dry-run

# 先週分を入れてから今週（単価候補のテスト）
python -m sales_report_automation --csv sample/week_2026_w13_seed.csv --week 2026-W13
python -m sales_report_automation --csv sample/week_sample.csv --week 2026-W14

# 同じ週を取り直す（DB 内のその週を削除してから再取込）
python -m sales_report_automation --csv sample/week_sample.csv --week 2026-W14 --replace-week
```

DB の既定パスは `data/report_store.sqlite` です。変更する場合は `--db path.sqlite` を指定してください。

## 週次メール（SMTP・任意）

**SMTP**は、メールサーバとアプリのあいだで「手紙を出す手順」を決めた規約です。ここでは多くの社内メールで使われる **STARTTLS（暗号化してから送る）** と **587番ポート** を想定しています。

1. `.env.example` にある **`SALES_REPORT_SMTP_HOST`** などを `.env` にコピーして値を入れる（`SALES_REPORT_SMTP_HOST` と **`SALES_REPORT_MAIL_TO`** が両方あるときだけ送信を試みます）。
2. いつも通り CLI を実行する（`--dry-run` のときはメールも送りません）。
3. 手元で送りたくないときは **`--no-mail`** を付ける。

送信に成功すると SQLite の **`notification_dispatches`** に `sent` が残り、同じ取り込み（同じ実行）では二重に送りません。失敗時は `failed` とエラー要約が残り、コマンドは終了コード 1 になります。

## Web ダッシュボード（実データ表示）

モック [sales-report-saas-dashboard-mock.html](../output/sample/sales-report-saas-dashboard-mock.html) と同じトーンで、**CLI が取り込んだ SQLite** の週次サマリーをブラウザに出します（**FastAPI**＝Python 用の軽量 Web フレームワーク）。

```bash
cd sales-report-automation
source .venv/bin/activate   # 未作成なら上のセットアップから
pip install -r requirements.txt
# 先に 1 週分以上を CLI で取り込む（DB が空だと週が選べません）
python -m sales_report_automation --csv sample/week_sample.csv --week 2026-W14 --dry-run
python3 -m uvicorn sales_report_automation.web:app --reload --port 8080
```

ブラウザで **http://127.0.0.1:8080/** を開き、画面上部の **週次 / 月次** で切り替えます。URL 例: `?week=2026-W14`、`?view=month&month=2026-04`。

- **参照する DB**は既定で `data/report_store.sqlite` です。CLI で `--db` を使っている場合は、Web 側でも **`export SALES_REPORT_DB=/同じパス.sqlite`** を揃えてください。
- **API**（他システムから数値だけ取るとき）: `GET /api/weeks`、`GET /api/summary?week=2026-W14`、`GET /api/months`、`GET /api/month_summary?month=2026-04`（月次は **ship_date** がその暦月に属する **全明細**を合算）。
- **単価欠けの補助**: ダッシュの表に「同一品目の過去単価・**同一得意先×材質**の過去／同月・同週平均・同品目平均・金額÷数量・推奨（その優先順）」を表示。材質は品目キーが `|` 区切りで **3 番目が材質**（`product_code_parts` が `[商品コード, 寸法, 材質, 商品名]` のマッピング）のときのみ利用。一括作業用に `GET /api/missing_unit_prices.csv?month=2026-04` または `?week=2026-W14`（UTF-8 BOM、最大 2 万件）。
- **チャネル円グラフ**: 英語ヘッダ CSV に **`channel` 列**があるか、マッピング JSON の **`columns.channel`** に元 CSV の列名を書いて再取り込みすると、`lines.channel` に入りダッシュボードに反映されます。
- **得意先 / 品目 Top 10**: 表示週の最新取り込み明細から、売上計の多い順に自動表示されます。

## 受信フォルダ（自動取り込み · ファイル監視）

**投入先の契約（パス・拡張子・専門家向けメモ）:** [data/inbox/README.md](data/inbox/README.md)

**ファイル監視**＝「指定したフォルダに新しいファイルが置かれたこと」を OS に知らせて、プログラムを動かす仕組みです。  
`watchdog` ライブラリを使い、**inbox 直下**（1段階だけ。サブフォルダ内は見ません）に置かれた `.csv` / `.tsv` / `.txt` を検知し、**いまの CLI と同じ取り込み**（`--week` は既定で `auto`）を走らせます。

- 成功したファイル → `inbox/processed/` へ移動（名前が重なれば日時を付与）
- 失敗（検証エラー等） → `inbox/failed/` へ移動

```bash
pip install -r requirements.txt   # watchdog 含む
# 手元: data/inbox/ を作り、週次 CSV をそこ「直下」に届ける想定
python3 -m sales_report_automation.watcher \
  --inbox data/inbox \
  --config config/nissyo_tab_export.json \
  --week auto
```

- 試験中は **`--dry-run`**（Claude 未使用）を付け、`--no-move` で置いたファイルを移さずにログだけ確認、も可。
- **本番でサーバ起動のまま回す**ときは、systemd / launchd / Docker などにこの1コマンドを登録するか、cron ではなく **常時プロセス**として動かすのが一般的です（**cron**＝決まった時刻に1回だけ実行する仕組みで、監視用には不向きなことが多いです）。

## 日勝ネジ工業様サンプル CSV（2024年分）

実データの列は日本語ヘッダ（`日付`, `得意先コード`, `数量`, `単価`, `金額`, …）で、日付は `YYYYMMDD`、ファイルは **CP932** の想定です。  
次のように **`config/nichisho_nissyo.json`** を指定すると、内部形式に変換してから取り込みます。

```bash
python -m sales_report_automation \
  --csv "/path/to/日勝ネジ工業様2024年分_サンプルデータ.CSV" \
  --config config/nichisho_nissyo.json \
  --week 2024-W01 \
  --dry-run
```

- **得意先コード** → `customer_code`
- **品目の同一キー** → `商品コード|寸法|材質|商品名` を連結（`999` だけでは区別できないため）
- **日付** → `YYYY-MM-DD` に正規化

※ 本番 CSV は個人情報を含むため **リポジトリにはコミットしない**でください。ローカルパスを `--csv` に渡す運用で問題ありません。

### タブ区切り（TSV）・手元データに近い列の例

**タブ区切り**＝列の区切りがカンマではなく「タブ」文字のテキストです。Excel から「テキスト（タブ区切り）」で保存するとよくこの形になります。  
**ヘッダ行**＝1行目に列名を書いた行です。ヘッダがないとツールは列を判別できません。

手元の貼り付けに合わせたサンプルを `sample/nissyo_like_tab_sample.tsv` と `config/nissyo_tab_export.json` に置いています（`delimiter: "\t"`）。列の対応は推定なので、本番ファイルと列が違う場合は JSON の `columns` を編集してください。

```bash
python3 -m sales_report_automation \
  --csv sample/nissyo_like_tab_sample.tsv \
  --config config/nissyo_tab_export.json \
  --week auto \
  --dry-run
```

## 運用トリガー（予定 · ドキュメント同期用）

- **タイムゾーン**: **日本時間（JST）**。
- **1 週間の定義**: **月曜 08:00:00 〜 翌週月曜 07:59:59**（JST）。CSV に含めるデータは、この期間に合わせて受注管理から出す。
- **CSV 送信**: 毎週**月曜 08:00（JST）**に、別の仕組み（スケジューラ）が**ツールへ CSV を 1 回送る**想定です。
- **ツールの起動**: ツールは「何時だから動く」ではなく、**「CSV が届いた」ことを合図に動き出す**想定です（届き口の作りは実装で決める）。
- **毎週月曜 08:00 に送るだけのタイマー**の例: サーバの時間を日本にそろえたうえで、cron に `0 8 * * 1`（月曜の 8 時）と書く、など。

### いまの CLI と本番の違い（新卒向け）

**いま（開発・試験）**  
担当の人がパソコンで「`python -m ... --csv ファイル --week ...`」と**自分で打って**動かしています。CSV の置き場所も、週のラベル（`--week`）も、**人が決めて打ち込む**前提です。

**本番（自動運用）**  
毎週月曜に CSV がツールの**届き口**（共有フォルダ・クラウドの受け皿・社内 API など、まだ決めてよい）に届きます。ツールは**「届いた」という出来事を見つけたら**、いまと**同じ処理の流れ**（読む → チェックする → まとめる → 必要なら AI に文章を頼む）を**自動で**始めます。  
言い換えると、**中身のレシピは同じ**で、**「料理を始める合図」だけが「人のキーボード」から「ファイルが届いた」に変わる**イメージです。

**`--week` を毎回打たなくてよくなる話**  
いまは「このファイルは 2026 年第 14 週の分です」と**人が `--week` で指定**できます。併せて **`--week auto`** を指定すると、各行の `ship_date` から**運用週キー**（JST・**月曜 08:00 開始**のウィンドウ）を推定します。行が複数の運用週にまたがる場合はエラーにするので、週次 CSV の取り違えに気づきやすくします。本番の「届き口」から起動するときは、この推定か、ファイル名に埋め込んだ週ラベルのどちらかを運用で選べます。

## 次の拡張例

- LINE / Slack 送信
- 上記スケジュールでの `cron` / GitHub Actions（CSV 送信側）と、届き口＋`--week` 自動計算の実装
- 監査ログテーブル

詳細な設計は `output/sample/sales-report-automation-checklist.md` を参照してください。
