@echo off
chcp 65001 > nul
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\activate.bat" (
  echo [エラー] 先に setup-windows.bat をダブルクリックして
  echo セットアップを済ませてください。
  pause
  exit /b 1
)

call ".venv\Scripts\activate.bat"

echo.
echo ================================================
echo   inbox 監視を開始します
echo ================================================
echo.
echo   監視先 : data\inbox\
echo   止める : このウィンドウで Ctrl+C
echo.
echo   data\inbox\ に CSV を置けば自動で取り込みます。
echo   成功した CSV → processed\ へ移動
echo   失敗した CSV → failed\ へ移動
echo ================================================
echo.

python -m sales_report_automation.watcher --inbox data\inbox --week auto

endlocal
