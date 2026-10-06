# -*- coding: utf-8 -*-
"""VRAM calibration: launch each engine+model, capture the engine's own
buffer accounting plus the nvidia-smi delta, and compare with the
estimator's prediction. Results feed the coefficients in vram.ts."""
import json
import re
import subprocess
import time
import urllib.request

LLAMA = r"E:\llama.cpp\build\bin\Release\llama-server.exe"
KVMEM = r"E:\kvmem-prism\bin\llama-kvmem-server.exe"

def nvidia_used():
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout.strip()
    return int(out.splitlines()[0])

def run_and_measure(name, cmd, ready_pattern, stop_words=("listening", "ready")):
    before = nvidia_used()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    lines = []
    t0 = time.time()
    ready = False
    while time.time() - t0 < 120:
        line = proc.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace").rstrip()
        lines.append(text)
        joined = text.lower()
        if any(word in joined for word in stop_words) and ("listening" in joined or "ready" in joined or "api base" in joined):
            ready = True
            time.sleep(1.5)  # let buffers settle
            break
    during = nvidia_used()
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    try:
        proc.wait(timeout=10)
    except Exception:
        pass
    time.sleep(3)
    after = nvidia_used()
    buffers = {k: round(int(v) / 1024, 2) for k, v in
               ((m.group(1).lower(), m.group(2)) for m in
                (re.search(r"(model|KV|compute|output) buffer size = ([\d.]+) MiB", l, re.I) for l in lines) if m)}
    total_mib = sum(buffers.values())
    result = {
        "name": name, "ready": ready, "nvidia_delta_gb": round((during - before) / 1024, 2),
        "buffers_mib": buffers, "engine_reported_gb": round(total_mib / 1024, 2),
        "tail": lines[-1][:110] if lines else "",
    }
    print(json.dumps(result, ensure_ascii=False))
    with open(r"D:\funproject\llama-manager\calibration.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(result, ensure_ascii=False) + "\n")

def llama(model, extra):
    return [LLAMA, "-m", model, "--host", "127.0.0.1", "--port", "8097", "-ngl", "99", "-fa", "on"] + extra

def kvmem(model, extra):
    return [KVMEM, "-m", model, "--host", "127.0.0.1", "--port", "8097", "-ngl", "99"] + extra

ORNITH = r"E:\LmModels\mradermacher\Ornith-1.5-9B-uncensored-GGUF\Ornith-1.5-9B-uncensored.Q4_K_M.gguf"
BONSAI = r"E:\LmModels\OS-Software\Ternary-Bonsai-2-27B-Uncensored-Heretic\Ternary-Bonsai-2-27B-Uncensored-Heretic-PTQ1_0.gguf"

if __name__ == "__main__":
    open(r"D:\funproject\llama-manager\calibration.jsonl", "w").close()
    runs = [
        ("llama-ornith-c4096-f16kv", llama(ORNITH, ["-c", "4096", "-b", "2048", "-ub", "512"])),
        ("llama-bonsai-c16384-f16kv", llama(BONSAI, ["-c", "16384", "-b", "2048", "-ub", "512"])),
        ("llama-bonsai-c16384-q8kv", llama(BONSAI, ["-c", "16384", "-b", "2048", "-ub", "512", "-ctk", "q8_0", "-ctv", "q8_0"])),
        ("kvmem-bonsai-budget2048-q4kv", kvmem(BONSAI, ["-c", "32768", "-b", "512", "--kvmem-budget", "2048",
                                                        "--kvmem-gen-reserve", "4096", "--kv-dtype", "q4_0", "-fa", "on"])),
    ]
    for name, cmd in runs:
        try:
            run_and_measure(name, cmd, name.split("-")[0])
        except Exception as exc:
            print(json.dumps({"name": name, "error": str(exc)}, ensure_ascii=False))
        time.sleep(2)
