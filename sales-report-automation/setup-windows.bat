@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ================================================
echo   週次売上レポート自動化ツール - 初回セットアップ
echo ================================================
echo.

REM ---- (1) Python の存在確認 ----
where py >nul 2>&1
if errorlevel 1 (
  python --version >nul 2>&1
  if errorlevel 1 (
    echo [エラー] Python が見つかりません。
    echo.
    echo python.org から Python 3.10 以上をダウンロードして
    echo インストール時に「Add python.exe to PATH」のチェックを必ず入れてください。
    echo.
    echo ダウンロードページを開きます。インストール後、もう一度このファイルを実行してください。
    pause
    start https://www.python.org/downloads/
    exit /b 1
  )
  set "PY_CMD=python"
) else (
  set "PY_CMD=py -3"
)
echo [1/4] Python 確認 OK
%PY_CMD% --version
echo.

REM ---- (2) 仮想環境 (.venv) の作成 ----
if not exist ".venv\Scripts\activate.bat" (
  echo [2/4] 仮想環境を作成しています...
  %PY_CMD% -m venv .venv
  if errorlevel 1 (
    echo [エラー] 仮想環境の作成に失敗しました。
    pause
    exit /b 1
  )
) else (
  echo [2/4] 仮想環境はすでに存在します（再利用）
)
echo.

REM ---- (3) 依存パッケージのインストール ----
echo [3/4] 必要なパッケージをインストールしています...
echo       （初回は数分かかります）
call ".venv\Scripts\activate.bat"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt
if errorlevel 1 (
  echo [エラー] パッケージのインストールに失敗しました。
  echo インターネット接続と requirements.txt を確認してください。
  pause
  exit /b 1
)
echo       完了
echo.

REM ---- (4) data フォルダ ----
if not exist "data\inbox" mkdir "data\inbox"
if not exist "data\inbox\processed" mkdir "data\inbox\processed"
if not exist "data\inbox\failed" mkdir "data\inbox\failed"

REM ---- (5) .env の確認 ----
if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" > nul
    echo [4/4] .env を作成しました（編集が必要です）
    echo.
    echo ================================================
    echo   メモ帳で .env を開きます。次の項目を埋めてください:
    echo ================================================
    echo   - ANTHROPIC_API_KEY        Claude のAPIキー
    echo   - SALES_REPORT_SMTP_USER   送信元 Gmail アドレス
    echo   - SALES_REPORT_SMTP_PASSWORD  Gmail のアプリパスワード
    echo   - SALES_REPORT_MAIL_FROM   送信元（同じで OK）
    echo   - SALES_REPORT_MAIL_TO     送り先（カンマで複数可）
    echo.
    echo   保存して閉じたら、このウィンドウに戻ってきてください。
    echo ================================================
    pause
    notepad .env
  ) else (
    echo [警告] .env.example が見つかりません。.env は手動で作成してください。
  )
) else (
  echo [4/4] .env はすでに存在します（変更したい場合は手動で編集）
)

echo.
echo ================================================
echo   セットアップ完了！
echo ================================================
echo.
echo 次にやること（ダブルクリックで OK）:
echo.
echo   start-dashboard.bat   ブラウザでダッシュボードを開く
echo   start-watcher.bat     自動取り込み常駐（CSV を inbox に置けば動く）
echo   ingest-drop.bat       CSV をドラッグして手動取り込み
echo.
pause
endlocal
