@echo off
cd /d "%~dp0"

REM Activate virtual environment
call venv\Scripts\activate.bat

REM Run flask backend
python app.py
