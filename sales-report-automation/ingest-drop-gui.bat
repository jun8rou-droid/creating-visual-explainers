@echo off
cd /d "%~dp0"
if exist ".venv\Scripts\activate.bat" call ".venv\Scripts\activate.bat"
python -m sales_report_automation.drag_ingest
if errorlevel 1 pause
