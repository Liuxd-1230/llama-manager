@echo off
chcp 65001 >nul 2>&1
title llama.cpp Run Manager

echo.
echo  ================================
echo    llama.cpp Run Manager
echo  ================================
echo.

cd /d "%~dp0"

REM -- Check Python --
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Install Python 3.10+
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

REM -- Install deps --
echo [2/3] Checking dependencies...
pip install -q -r requirements.txt 2>nul

REM -- Start --
echo [3/3] Starting server...
echo.
echo  Address: http://localhost:9090
echo  Press Ctrl+C to stop
echo.

REM -- Open browser after delay --
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:9090"

REM -- Run uvicorn --
python -m uvicorn backend.main:app --host 0.0.0.0 --port 9090

pause
