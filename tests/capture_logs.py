# -*- coding: utf-8 -*-
"""Capture engine logs with a reader thread (readline blocks on silent servers)."""
import subprocess
import threading
import time

LLAMA = r"E:\llama.cpp\build\bin\Release\llama-server.exe"
ORNITH = r"E:\LmModels\mradermacher\Ornith-1.5-9B-uncensored-GGUF\Ornith-1.5-9B-uncensored.Q4_K_M.gguf"
BONSAI = r"E:\LmModels\OS-Software\Ternary-Bonsai-2-27B-Uncensored-Heretic\Ternary-Bonsai-2-27B-Uncensored-Heretic-PTQ1_0.gguf"


def capture(name, cmd, seconds):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    lines = []

    def reader():
        for raw in iter(proc.stdout.readline, b""):
            lines.append(raw.decode("utf-8", errors="replace").rstrip())

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    time.sleep(seconds)
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    try:
        proc.wait(timeout=10)
    except Exception:
        pass
    thread.join(timeout=5)
    with open(f"/tmp/{name}.log", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"== {name}: {len(lines)} lines")
    return lines


lines = capture("ornith", [LLAMA, "-m", ORNITH, "--host", "127.0.0.1", "--port", "8097",
                           "-ngl", "99", "-fa", "on", "-c", "4096"], 22)
for line in lines:
    if "buffer" in line.lower():
        print("  BUF:", line[:160])

lines = capture("bonsai-err", [LLAMA, "-m", BONSAI, "--host", "127.0.0.1", "--port", "8097",
                               "-ngl", "99", "-c", "16384"], 18)
for line in lines[-6:]:
    print("  ERR:", line[:160])
