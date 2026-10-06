# -*- coding: utf-8 -*-
"""Clean calibration matrix per engine/model pairing:
  Bonsai GGUF -> PrismML llama-server (ternary needs it)
  Hermes MoE  -> PrismML with --cpu-moe / --n-cpu-moe sweep
Global nvidia delta, baseline re-verified between runs."""
import json
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

PRISM = r"E:\PrismLlma\llama-server.exe"
BONSAI = r"E:\LmModels\OS-Software\Ternary-Bonsai-2-27B-Uncensored-Heretic\Ternary-Bonsai-2-27B-Uncensored-Heretic-PTQ1_0.gguf"
HERMES = r"E:\LmModels\LuffyTheFox\Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-Final-GGUF\Hermes3.6-35B-A3B-Uncensored-Genesis-Final-APEX-Compact.gguf"
LOG = r"D:\funproject\llama-manager\tests\logs"


def gpu_used():
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout.strip()
    return int(out.splitlines()[0])


def wait_quiet(baseline, tolerance=120, timeout=40):
    for _ in range(timeout):
        if gpu_used() <= baseline + tolerance:
            return True
        time.sleep(1)
    return False


def run(tag, cmd, wait_s):
    baseline = gpu_used()
    log_path = LOG + "\\" + tag + ".log"
    with open(log_path, "w", encoding="utf-8") as log_fh:
        proc = subprocess.Popen(cmd, stdout=log_fh, stderr=subprocess.STDOUT)
        ok = False
        for _ in range(wait_s):
            time.sleep(1)
            try:
                urllib.request.urlopen("http://127.0.0.1:8097/v1/models", timeout=1)
                ok = True
                time.sleep(2)
                break
            except Exception:
                if proc.poll() is not None:
                    break
    during = gpu_used() if ok else None
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    try:
        proc.wait(timeout=10)
    except Exception:
        pass
    quiet = wait_quiet(baseline)
    result = {"tag": tag, "serving": ok, "baseline_mb": baseline, "during_mb": during,
              "delta_gb": round((during - baseline) / 1024, 2) if during is not None else None,
              "released": quiet}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    time.sleep(4)
    return result


def main():
    runs = [
        ("prism-bonsai-c4096-q8", [PRISM, "-m", BONSAI, "--port", "8097", "-ngl", "99", "-fa", "on", "-c", "4096", "-b", "2048", "-ub", "512"], 90),
        ("prism-bonsai-c16384-q8", [PRISM, "-m", BONSAI, "--port", "8097", "-ngl", "99", "-fa", "on", "-c", "16384", "-b", "2048", "-ub", "512"], 90),
        ("prism-bonsai-c16384-q4", [PRISM, "-m", BONSAI, "--port", "8097", "-ngl", "99", "-fa", "on", "-c", "16384", "-b", "2048", "-ub", "512", "-ctk", "q4_0", "-ctv", "q4_0"], 90),
        ("prism-heresy-cpumoe", [PRISM, "-m", HERMES, "--port", "8097", "-ngl", "99", "-fa", "on", "-c", "4096", "-b", "2048", "-ub", "512", "--cpu-moe"], 150),
        ("prism-heresy-ncmoe32", [PRISM, "-m", HERMES, "--port", "8097", "-ngl", "99", "-fa", "on", "-c", "4096", "-b", "2048", "-ub", "512", "--n-cpu-moe", "32"], 150),
        ("prism-heresy-ncmoe20", [PRISM, "-m", HERMES, "--port", "8097", "-ngl", "99", "-fa", "on", "-c", "4096", "-b", "2048", "-ub", "512", "--n-cpu-moe", "20"], 150),
    ]
    for tag, cmd, wait_s in runs:
        try:
            run(tag, cmd, wait_s)
        except Exception as exc:
            print(json.dumps({"tag": tag, "error": str(exc)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
