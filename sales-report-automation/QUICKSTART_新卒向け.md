# 週次売上レポート自動化 — 新卒向けクイックスタート

「ターミナル？　Python？　仮想環境って何？」のレベルから、このツールを動かせるところまでを順番に説明します。**怖い見た目のコマンドが出てきても、コピペで進めて大丈夫**です。

---

## このツールが何をしてくれるか

社内のシステムから出てくる **CSV ファイル**（売上の生データ）を渡すと:

1. 中身を読み取って、社内データベース（このパソコンの中の小さなDB）に保存
2. 集計（合計金額、得意先別の金額、欠けている単価の候補など）
3. AI（Claude）が「上司に口頭で報告するイメージ」の日本語サマリーを書く
4. その内容を**メールで送り**、Webブラウザで開ける**ダッシュボード**にも反映

これを毎週手動でやってもよいし、`data/inbox/` というフォルダにCSVを置くだけで自動でやらせる、ということもできます。

---

## まず覚えておきたい用語（ぜんぶ簡単に）

| 用語 | やさしく言うと |
|------|----------------|
| **CSV** | 表計算ソフトでも開けるテキストの表。「,」で列を区切るのが基本 |
| **TSV** | CSVのタブ区切り版。社内ツールから出すとこっちがよくある |
| **ターミナル**（macなら「ターミナル.app」） | 文字でパソコンに命令を打つ画面。アイコンクリックの代わり |
| **Python** | このツールを動かしている言語。ランタイムが必要 |
| **パッケージ** | Python用の便利機能の追加部品。ネット経由で入れる |
| **仮想環境（.venv）** | このプロジェクト専用の「Pythonの作業部屋」。他のプロジェクトと干渉しない |
| **`.env` ファイル** | 秘密の設定（APIキーやメールパスワード）を書いておくテキストファイル。Gitに上げないやつ |
| **APIキー** | 外部サービス（ここではClaude AI）を呼ぶための長い合言葉 |
| **SQLite** | 1ファイルで完結する小さなデータベース。`data/report_store.sqlite` という1個のファイルで全部できている |
| **SMTP** | メールを送るときの仕組み。Gmailなら `smtp.gmail.com` |
| **ダッシュボード** | 数字を見やすく並べたWebページ。ブラウザで `http://127.0.0.1:8080/` を開く |

> **`127.0.0.1` って？**
> 自分のパソコン自身のことです。「ネットには出ない、自分の中だけで開いているWebサイト」を見にいく時の合言葉。

---

## 0. はじめてのとき：1回だけやるセットアップ

### 0-1. ターミナルを開く

- Mac: `Command + スペース` →「ターミナル」と入力 → Enter
- Windows: スタートメニュー →「PowerShell」または「コマンドプロンプト」

ターミナルは、最初は黒い（か白い）真っ平らな画面に英数字がチカチカしているだけです。**ここに文字を打って Enter** で命令します。

### 0-2. プロジェクトフォルダに移動する

`cd`（change directory の略 = フォルダを移動）コマンドを使います。

```bash
cd ~/src/creating-visual-explainers/sales-report-automation
```

> **`~` って？**
> 自分のホームフォルダ（macなら `/Users/yamadajunichirou`）のショートカット記号です。

### 0-3. 仮想環境を作る（1回だけ）

このプロジェクト用のPython作業部屋を作ります。

```bash
python3 -m venv .venv
```

> **何が起きる？**
> `.venv` という隠しフォルダができて、そこに専用のPythonと部品入れができます。

### 0-4. 仮想環境に「入る」

```bash
source .venv/bin/activate
```

すると、行頭に `(.venv)` という印が付きます。**これが「作業部屋に入っている」状態**です。ターミナルを閉じると抜けるので、次からは毎回これを打ちます。

> Windowsの場合: `.\.venv\Scripts\activate`

### 0-5. 必要なパッケージを入れる（1回だけ）

```bash
pip install -r requirements.txt
```

`pip` は Python のパッケージ管理ツール、`requirements.txt` は「こういう部品がいるよ」というリストです。これで `anthropic`（AI呼び出し）、`fastapi`（Webサーバー）、`watchdog`（フォルダ監視）などが入ります。

### 0-6. `.env` ファイルを確認する

このフォルダ直下の `.env` ファイル（隠しファイル）に、APIキーやメール設定が書いてあるはずです。Macなら Finder で `Command + Shift + .` を押すと隠しファイルが見えます。

開いて中身が下のような構成になっていればOK:

```
ANTHROPIC_API_KEY=sk-ant-api03-…（Claude AIの合言葉）
SALES_REPORT_SMTP_HOST=smtp.gmail.com
SALES_REPORT_SMTP_USER=自分のGmailアドレス
SALES_REPORT_SMTP_PASSWORD=Gmailのアプリパスワード
SALES_REPORT_MAIL_FROM=送信元アドレス
SALES_REPORT_MAIL_TO=送信先アドレス（カンマで複数可）
```

> **Gmailアプリパスワードって？**
> 普段ログインに使うパスワードとは別に、ツール用に発行する16桁の合言葉。Googleアカウント設定の「2段階認証」→「アプリパスワード」で発行します。

> **このファイルは絶対にGitにアップロードしない**こと。`.gitignore` で除外設定済みなので、普通に運用していれば大丈夫です。

---

## 1. 毎週の作業：CSVを1本手動で取り込む（いちばんシンプル）

毎週月曜日の朝、社内ツールから出してきた `週次売上_2026-W14.csv` のようなファイルが手元にあるとします。

### 1-1. ターミナルを開いて、仮想環境に入る

```bash
cd ~/src/creating-visual-explainers/sales-report-automation
source .venv/bin/activate
```

### 1-2. 取り込みコマンドを打つ

ファイルパスを引数に渡すだけです。

```bash
./ingest ~/Downloads/週次売上_2026-W14.csv
```

> **`./ingest` って？**
> このフォルダにある起動用のスクリプトです（macOS/Linux用）。Windowsの人は `ingest.bat ファイル名` です。

実行すると順番に:
1. CSVをDBに取り込み
2. 集計
3. Claudeが日本語サマリーを書く（数秒）
4. ターミナルに本文がパッと出る
5. 設定が揃っていればメールも送られる

### 1-3. うまくいったか確認

ターミナルに出てくる最後の方に:
```
(週次メールを送信しました)
```
と出ていれば成功。Gmailの送信済みも見てみましょう。

### 「お試し」モード（メールもAIも止める）

設定を試したいだけ・本番に流したくない時:
```bash
./ingest ~/Downloads/週次売上_2026-W14.csv --dry-run --no-mail
```

> **`--dry-run`** … Claude AI を呼ばずに「もし動かしたら何を渡すか」のJSONを画面に出すだけ
> **`--no-mail`** … メール送信をスキップ

---

## 2. ダッシュボード（Webページ）で集計を見る

別のターミナルウィンドウで:

```bash
cd ~/src/creating-visual-explainers/sales-report-automation
source .venv/bin/activate
python3 -m uvicorn sales_report_automation.web:app --port 8080
```

> **`uvicorn` って？**
> Python製の小さなWebサーバー。これが起動している間だけブラウザでページが見えます。

下のように表示されたら準備OK:
```
INFO:     Uvicorn running on http://127.0.0.1:8080
```

ブラウザで `http://127.0.0.1:8080/` を開くと、画面が出ます。週／月の選択、合計金額、前週比、得意先トップ、単価が欠けている行のCSVダウンロードなどが見えます。

**止めたいとき:** ターミナルで `Ctrl + C`（コントロールとCを同時押し）。

---

## 3. 【最強・推奨】完全自動：パソコン起動と同時に常駐させる

> 一度設定すれば、**毎週やることは「CSVを inbox に置くだけ」**になります。ターミナル操作ゼロ。

### 3-0. 1回だけのセットアップ（5秒・ダブルクリック2回）

1. Finderで `sales-report-automation` フォルダを開く
2. **`setup-auto-watcher.command` をダブルクリック**
3. 「開発元を確認できません」と出たら → 右クリック → 開く → 警告で「開く」
4. 「セットアップ完了！」のダイアログが出れば成功

> **何が起きた？**
> macOSの `launchd`（ローンチディー）という仕組みに「パソコンが起動したらwatcherを裏で立ち上げてね」と頼みました。すでに今の時点でwatcherは動いています。

### 3-0-2. inbox を Finder のサイドバーに登録（任意・1回）

毎回 `data/inbox/` まで降りていくのが面倒なら、Finderのサイドバーに登録しておくと便利です。

1. Finderで `sales-report-automation/data/` を開く
2. `inbox` フォルダをFinder左サイドバーの「よく使う項目」エリアにドラッグ

これで Downloads から CSV をドロップする時に、**inbox がサイドバーに常に見えている**状態になります。

### 3-1. 毎週の作業（これだけ！）

1. 社内ツールが出した CSV を Downloads などからつかむ
2. **Finderサイドバーの inbox にドラッグ**
3. 30秒〜1分ほど待つ → メールが届く

それだけ。ターミナルもブラウザも開かなくてOK（ダッシュボードを見たい時だけ第2章を起動）。

### 3-2. 動いているか確認したい時

`auto-watcher/watcher.log` がリアルタイムで更新されていれば動いています。Finderで開いて末尾を見てみてください。エラーがあると `auto-watcher/watcher.err.log` に出ます。

### 3-3. 自動起動を止めたい時

**`stop-auto-watcher.command` をダブルクリック**するだけ。再度有効にしたければ `setup-auto-watcher.command` をもう一度ダブルクリック。

> **マッピングJSONが必要なCSV（日本語ヘッダなど）の注意**
> 自動起動のwatcherは `--config` を付けずに動いているので、英語ヘッダのCSVだけが処理できます。日本語ヘッダの形式が来たときは取り込みが失敗して `data/inbox/failed/` に移動します。その時は手動で `./ingest ファイル config/xxx.json` を打つか、`auto-watcher/com.junichiro.sales-report.watcher.plist.template` の `ProgramArguments` に `--config <パス>` を追加して setup-auto-watcher.command をもう一度実行してください。

---

## 4. （上級・任意）手動でwatcherを起動するパターン

毎週、社内ツールから自動で `data/inbox/` に CSV が落ちてくる構成にしたい場合に使います。手動で投入したい時にも便利です。

### 3-1. 監視を起動する

```bash
cd ~/src/creating-visual-explainers/sales-report-automation
source .venv/bin/activate
python3 -m sales_report_automation.watcher --inbox data/inbox --week auto
```

> **`watcher` って？**
> `data/inbox/` フォルダをじっと見張って、CSV/TSV/TXTが増えたら自動で取り込みパイプラインを動かしてくれる「番犬」プログラム。`watchdog` というパッケージを使っています。

> **`--week auto`** … CSVの中の `ship_date`（出荷日）から「これは何週目のデータ？」を勝手に判定する設定。社内ツールから来るCSVがどの週か気にしなくてよい。

すると下のように出ます:
```
[watch] 監視中: ~/src/.../sales-report-automation/data/inbox
  成功 → processed/
  失敗 → failed/
  Ctrl+C で停止
```

### 3-2. CSVを置いてみる

別ウィンドウで（または Finder からドラッグ&ドロップで）:
```bash
cp sample/week_sample.csv data/inbox/
```

watcher側のターミナルに `[watch] 取り込み開始: ...` が出て、終われば `[watch] 成功 → processed/...` と出ます。

### 3-3. ファイルの行き先

| 結果 | 移動先 |
|------|--------|
| 取り込み成功 | `data/inbox/processed/` |
| 失敗（CSVが壊れている等） | `data/inbox/failed/` |

`data/inbox/` 直下は常に空のままになり、また次のファイルを待ち受けます。

### 試運転モード

最初のテストで「メールはまだ送りたくない・AIも呼びたくない」場合:

```bash
python3 -m sales_report_automation.watcher --inbox data/inbox --week auto --dry-run --no-mail
```

慣れてきたら、片方ずつ外していきます（例: `--no-mail` だけ残してClaudeは本物を呼ぶ → サマリーの仕上がりだけ確認）。

---

## 5. 日本語ヘッダのCSV／タブ区切りファイルを取り込む

社内ツールから出てくるCSVが日本語の列名（「日付」「得意先コード」など）だったり、タブ区切りだったりすることがあります。その時は **マッピング JSON**（列名の対応表）を一緒に渡します。

```bash
./ingest ~/Downloads/受注一覧.tsv config/nissyo_tab_export.json
```

> **マッピング JSON って？**
> 「CSV側の『日付』列をツール内部の `ship_date` として扱う」みたいな対応表を書いておくJSONファイル。`config/` フォルダにテンプレが入っています。新しい形式のCSVが来たら、このJSONを1つ作ればOK。

watcherでも同じことができます:
```bash
python3 -m sales_report_automation.watcher \
  --inbox data/inbox \
  --config config/nissyo_tab_export.json \
  --week auto
```

---

## 6. 困ったときの相談手順

### A. ターミナルが赤い文字を出して止まった

エラーメッセージは**そのまま全部コピー**してください。「`ModuleNotFoundError: No module named 'xxx'`」みたいなのは、`pip install -r requirements.txt` を仮想環境に入った状態でやり直すと直ることが多いです。

### B. メールが届かない

まず `--dry-run` を外してターミナルに出てくる文を読んでみます:
- `SMTP_HOST 等が未設定` → `.env` の中身を確認
- `認証エラー` → Gmailのアプリパスワードを再発行
- `タイムアウト` → 社内ネットワークがポート587をブロックしていないか情シスに確認

### C. ダッシュボードが「DB がまだありません」と出る

まだ1回もCSVを取り込んでいません。先に `./ingest` で取り込みを1本通してから、ブラウザを更新してください。

### D. CSVに必須列がないと怒られる

メッセージに `必須列がありません: ['ship_date', 'customer_code', ...]` とあれば、英語ヘッダ用ロジックに当たっています。日本語ヘッダのCSVなら **マッピングJSON を `--config` で渡す**のを忘れずに。

### E. `.env` を変更したのに反映されない

ターミナルを開きっぱなしだと古い設定のままのことがあります。**ターミナルを閉じて開き直し**、もう一度 `source .venv/bin/activate` から始めると、最新の `.env` が読まれます。

---

## 7. 1日の流れ（完成版・参考イメージ）

毎週月曜の朝:

```
1. 社内ツールが data/inbox/ に CSV を投入（自動 or 手動cp）
   ↓
2. 常駐している watcher が検知して取り込み開始
   ↓
3. SQLite に保存 → 集計 → Claude にサマリー依頼
   ↓
4. メールが上司・自分・関係者に届く（Subject: [週次売上] 2026-W14）
   ↓
5. 必要があれば http://127.0.0.1:8080/ を開いて詳細を確認
   ↓
6. CSV は data/inbox/processed/ に自動退避（再実行したいときはここから戻す）
```

新卒のうちは、まず **「手動取り込み」（第1章）** と **「ダッシュボードを見る」（第2章）** の2つだけ覚えれば十分です。watcherやマッピングJSONは慣れてからで大丈夫。

---

## 8. ちょっと中身を覗くと面白いところ

| 興味があれば | 中を覗くファイル |
|--------------|------------------|
| AIにどんなプロンプトを投げているか | `sales_report_automation/pipeline.py` の `call_claude_report()` |
| 単価が欠けてる時に何を候補にするか | `sales_report_automation/dashboard_data.py` の `pick_recommended_unit_price()` |
| メールの件名・本文の組み立て | `sales_report_automation/notify_mail.py` |
| ダッシュボードの見た目（HTML/CSS） | `sales_report_automation/static/dashboard.html` |

最初は読まなくてOK。「サマリーをもう少しこういう書き方にしたい」と思った時に該当箇所だけ覗くと、全体像が見えてきます。

---

慣れない単語があったら気にせず質問してください。1個ずつ潰していけば、1〜2週間で「こういうものか」と扱えるようになります。
