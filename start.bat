@echo off
chcp 65001 >nul 2>&1
title Atelier

echo.
echo  ================================
echo    Atelier
echo  ================================
echo.

cd /d "%~dp0"

REM -- Check Python --
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Install Python 3.11+
    echo https://www.python.org/downloads/
    pause
    exit /b 1
)

REM -- Create venv if needed --
if not exist ".venv\Scripts\activate.bat" (
    echo [1/3] Creating virtual environment...
    python -m venv .venv
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to create venv
        pause
        exit /b 1
    )
)

REM -- Activate venv --
call .venv\Scripts\activate.bat

REM -- Install deps only when requirements.txt changed --
set "REQ_STAMP=%~dp0.venv\.requirements-stamp"
set "REQ_HASH="
for /f "skip=1 delims=" %%h in ('certutil -hashfile requirements.txt SHA256 2^>nul') do (
    if not defined REQ_HASH set "REQ_HASH=%%h"
)
set "REQ_HASH=%REQ_HASH: =%"
set "STAMPED="
if exist "%REQ_STAMP%" set /p STAMPED=<"%REQ_STAMP%"
if /i "%REQ_HASH%"=="%STAMPED%" (
    echo [2/3] Dependencies up to date.
) else (
    echo [2/3] Checking dependencies...
    pip install -q -r requirements.txt
    if errorlevel 1 exit /b 1
    >"%REQ_STAMP%" echo %REQ_HASH%
)

REM -- Start --
echo [3/3] Starting server...
echo.
echo  Address: http://localhost:9090
echo  Press Ctrl+C to stop
echo.

REM -- Open browser after delay --
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:9090"

REM -- Run uvicorn --
python -m uvicorn backend.main:app --host 127.0.0.1 --port 9090

pause
