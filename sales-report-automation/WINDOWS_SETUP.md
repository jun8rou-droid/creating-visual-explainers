# Windows でのセットアップ（職場PC向け）

ダブルクリック中心で動かせるように、Windows 用の `.bat` を 3 つ用意しました。
コマンドプロンプトを開く必要はほぼありません。

## 初回だけやること（5 分）

### 1. Python をインストール

[python.org](https://www.python.org/downloads/) から **Python 3.10 以上**をダウンロード。
インストーラーで **「Add python.exe to PATH」のチェックを必ず入れる**。

> **Add python.exe to PATH** にチェックしないと、後の bat ファイルが Python を見つけられません。
> もしチェックを忘れたら、もう一度インストーラーを実行して「Modify」で入れ直しが可能です。

### 2. プロジェクトフォルダを Windows PC にコピー

USBメモリ・OneDrive・Git どれでも構いません。注意点：

- **`.venv\` フォルダはコピーしない**（OS 依存なので作り直し）
- **`data\report_store.sqlite` はコピーして OK**（過去取引データを引き継ぎたいなら）
- **`.env` はコピーしないほうが安全**（パスワードは新しい PC 用に発行し直すのが推奨）

### 3. `setup-windows.bat` をダブルクリック

自動でやってくれること：
1. Python の存在確認（なければ python.org を開く）
2. 仮想環境（`.venv\`）の作成
3. 必要なパッケージ（`anthropic` `fastapi` `watchdog` 等）のインストール
4. `.env` を作成 → メモ帳が開くので埋める

メモ帳が開いたら、次の項目を埋めて保存：

```
ANTHROPIC_API_KEY=sk-ant-api03-...           # Anthropic 管理画面で発行
SALES_REPORT_SMTP_HOST=smtp.gmail.com
SALES_REPORT_SMTP_PORT=587
SALES_REPORT_SMTP_USE_TLS=1
SALES_REPORT_SMTP_USER=送信元@gmail.com
SALES_REPORT_SMTP_PASSWORD=Gmailのアプリパスワード16桁
SALES_REPORT_MAIL_FROM=送信元@gmail.com
SALES_REPORT_MAIL_TO=宛先@example.com
```

> **Gmail のアプリパスワード**: 普段のログイン用パスワードとは別に、ツール用の 16 桁を発行できます。Google アカウント →「2段階認証プロセス」→「アプリ パスワード」で作れます（2段階認証が有効な場合のみ）。

## 毎日の使い方

### A. ダッシュボードを見たいとき

`start-dashboard.bat` をダブルクリック → 3 秒後に既定ブラウザが自動で開きます。

止めたいときは、ターミナルウィンドウで **Ctrl+C** または ✕ ボタン。

### B. 手動で CSV を取り込みたいとき

`ingest-drop.bat` に CSV ファイルをドラッグ＆ドロップ → 取り込み開始。Claude 文案・メール送信まで実行されます。

`--dry-run` で試したいなら、コマンドプロンプトで：
```
ingest.bat sample\week_sample.csv --dry-run --no-mail
```

### C. CSV を inbox に置くだけで自動処理したいとき

`start-watcher.bat` をダブルクリック → このターミナルを開いている間、`data\inbox\` フォルダに置かれた CSV が自動で取り込まれ、メールが送られます。

毎週、ブラウザのお気に入りで `http://127.0.0.1:8081/` を開けばダッシュボードも見られます（dashboard と watcher は別ターミナルで両方動かす想定）。

## トラブルシューティング

### `setup-windows.bat` で「Python が見つかりません」と出る

`Add python.exe to PATH` にチェックを入れずにインストールした可能性が高いです。
python.org のインストーラーをもう一度実行 → `Modify` → `Add Python to environment variables` にチェック → `Modify` で入れ直してください。

### `pip install` でエラー

社内ネットワークがプロキシ経由の場合、パッケージインストールがブロックされることがあります。情シスにプロキシ設定を確認するか、`pip install --proxy=http://プロキシURL ...` で指定してください。

### ダッシュボードが開かない（ERR_CONNECTION_REFUSED）

`start-dashboard.bat` のターミナルウィンドウが閉じていないか確認。閉じていればもう一度ダブルクリック。

### 文字化けする

コマンドプロンプトの文字コードが CP932 のまま動いている可能性があります。各 `.bat` の冒頭に `chcp 65001 > nul` を入れてあるので通常は出ませんが、もし化けたら次を試す：
- Windows Terminal を使う（より UTF-8 対応が良い）
- システム設定で「世界共通の Unicode UTF-8 を使用」を有効にする

## 自動起動にしたい（任意・上級者向け）

PC 起動と同時に watcher を常駐させたい場合は **タスク スケジューラ** を使います。

1. `Win + R` → `taskschd.msc` で起動
2. 「基本タスクの作成」→ 名前を「sales-report-watcher」など
3. トリガー: 「コンピューターの起動時」
4. 操作: プログラムの開始 → `start-watcher.bat` のフルパスを指定
5. 「最上位の特権で実行」「ユーザーがログオンしているかどうかにかかわらず実行」をオンにする

これで PC を起動するたびに watcher が裏で動きます。
（必要があれば、私の方で setup-task-scheduler.ps1 を書くこともできます）
