@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\activate.bat" (
  call ".venv\Scripts\activate.bat"
)
python -m sales_report_automation.simple_ingest %*
endlocal
