@echo off
REM ===== Neuro Vision: one-click start (Windows) =====
cd /d "%~dp0neuro-vision-backend"

set PYCMD=
for %%V in (3.12 3.11 3.10 3.13) do (
  if not defined PYCMD (
    py -%%V --version >nul 2>&1 && set PYCMD=py -%%V
  )
)
if not defined PYCMD set PYCMD=python

if not exist .venv (
  echo Creating virtual environment with %PYCMD% ...
  %PYCMD% -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo.
  echo Package installation failed. Install Python 3.12 from python.org and run this file again.
  pause
  exit /b 1
)
python check_database.py
echo.
echo Starting Neuro Vision at http://127.0.0.1:8000  (keep this window open)
start "" http://127.0.0.1:8000
python -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
