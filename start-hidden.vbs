Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' 激活虚拟环境并启动 uvicorn (隐藏窗口)
WshShell.Run "cmd /c ""call .venv\Scripts\activate.bat && python -m uvicorn backend.main:app --host 0.0.0.0 --port 9090""", 0, False

' 等待 3 秒后打开浏览器
WScript.Sleep 3000
WshShell.Run "http://localhost:9090", 1, False
