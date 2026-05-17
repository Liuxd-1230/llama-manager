@echo off
chcp 65001 >nul 2>&1
title llama.cpp Run Manager

echo.
echo  ================================
echo    llama.cpp Run Manager
echo  ================================
echo.

cd /d "%~dp0"

REM ── 检查 Python ──
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Python，请先安装 Python 3.10+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

REM ── 检查/创建虚拟环境 ──
if not exist ".venv\Scripts\activate.bat" (
    echo [1/3] 创建虚拟环境...
    python -m venv .venv
    if %errorlevel% neq 0 (
        echo [错误] 创建虚拟环境失败
        pause
        exit /b 1
    )
)

REM ── 激活虚拟环境 ──
call .venv\Scripts\activate.bat

REM ── 安装依赖 ──
echo [2/3] 检查依赖...
pip install -q -r requirements.txt 2>nul

REM ── 启动服务 ──
echo [3/3] 启动服务...
echo.
echo  ┌─────────────────────────────────────┐
echo  │  地址: http://localhost:9090         │
echo  │  按 Ctrl+C 停止                      │
echo  └─────────────────────────────────────┘
echo.

REM ── 延迟打开浏览器 ──
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:9090"

REM ── 运行 uvicorn ──
python -m uvicorn backend.main:app --host 0.0.0.0 --port 9090

pause
