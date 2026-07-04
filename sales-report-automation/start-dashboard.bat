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
echo   ダッシュボードを起動します
echo ================================================
echo.
echo   URL : http://127.0.0.1:8081/
echo   止める : このウィンドウで Ctrl+C
echo.
echo   3 秒後にブラウザを開きます...
echo ================================================

REM 3秒後に既定ブラウザでダッシュボードを開く
start "" /b cmd /c "timeout /t 3 /nobreak > nul && start http://127.0.0.1:8081/"

python -m uvicorn sales_report_automation.web:app --port 8081 --reload

endlocal
