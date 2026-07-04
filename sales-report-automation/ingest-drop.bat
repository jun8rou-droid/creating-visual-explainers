@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo この ingest-drop.bat に CSV/TSV をドラッグ＆ドロップしてください。
  pause
  exit /b 1
)
if exist ".venv\Scripts\activate.bat" call ".venv\Scripts\activate.bat"
python -m sales_report_automation.simple_ingest "%~1"
endlocal
