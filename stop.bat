@echo off
chcp 65001 >nul 2>&1
echo 正在停止 llama.cpp Run Manager...
taskkill /F /FI "WINDOWTITLE eq llama.cpp Run Manager" >nul 2>&1
taskkill /F /IM uvicorn.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9090 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo 已停止。
timeout /t 2 >nul
