"""Bayesian optimization for llama.cpp parameters using Optuna."""
from __future__ import annotations
import asyncio
import json
import subprocess
import sys
import re
from pathlib import Path
from typing import List, Optional, Dict, Any


class Optimizer:
    def __init__(self):
        self._is_running: bool = False
        self._should_stop: bool = False
        self._log_buffer: List[str] = []
        self._results: List[Dict[str, Any]] = []
        self._subscribers: List[asyncio.Queue] = []
        self._current_trial: int = 0
        self._total_trials: int = 0
        self._best_result: Optional[Dict[str, Any]] = None

    def _append(self, text: str):
        self._log_buffer.append(text)
        for q in list(self._subscribers):
            try:
                q.put_nowait(text)
            except Exception:
                self._subscribers.remove(q)

    def _notify_update(self):
        """Send a JSON status update to subscribers."""
        status = json.dumps({
            "type": "status",
            "current_trial": self._current_trial,
            "total_trials": self._total_trials,
            "best": self._best_result,
            "results_count": len(self._results),
        })
        for q in list(self._subscribers):
            try:
                q.put_nowait(status)
            except Exception:
                self._subscribers.remove(q)

    def _notify_result(self, result: Dict[str, Any]):
        """Send a new result to subscribers."""
        msg = json.dumps({"type": "result", **result})
        for q in list(self._subscribers):
            try:
                q.put_nowait(msg)
            except Exception:
                self._subscribers.remove(q)

    def _find_bench_binary(self, llama_cpp_dir: str) -> str:
        """Find llama-bench binary."""
        d = Path(llama_cpp_dir)
        if not d.is_dir():
            return ""
        exe = "llama-bench.exe" if sys.platform == "win32" else "llama-bench"
        candidates = [
            d / "build" / "bin" / exe,
            d / "build" / "bin" / "Release" / exe,
            d / "build" / "bin" / "Debug" / exe,
            d / exe,
        ]
        for c in candidates:
            if c.exists():
                return str(c)
        # Recursive fallback
        for f in d.rglob(exe):
            return str(f)
        return ""

    def _run_bench(self, bench_bin: str, model: str, ngl: int, threads: int,
                   ctx: int, kv_k: str, kv_v: str, n_cpu_moe: int,
                   mmap: bool, mlock: bool) -> Optional[Dict[str, float]]:
        """Run llama-bench once and parse output. Returns {pp: tok/s, tg: tok/s} or None if OOM."""
        cmd = [
            bench_bin,
            "-m", model,
            "-ngl", str(ngl),
            "-t", str(threads),
            "-p", str(ctx),
            "-n", "0",  # 0 = use default output tokens
        ]
        if kv_k:
            cmd += ["--cache-type-k", kv_k]
        if kv_v:
            cmd += ["--cache-type-v", kv_v]
        if n_cpu_moe > 0:
            cmd += ["--n-cpu-moe", str(n_cpu_moe)]
        if mmap:
            cmd.append("--mmap")
        if mlock:
            cmd.append("--mlock")

        self._append(f"  $ {' '.join(cmd)}")

        try:
            # Run with timeout
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,  # 5 min max per run
                cwd=str(Path(bench_bin).parent.parent.parent),  # llama.cpp root
            )
            output = result.stdout + result.stderr

            # Check for OOM
            if any(kw in output.lower() for kw in ["out of memory", "oom", "cuda error", "memory allocation failed"]):
                self._append(f"  ❌ OOM / Memory error")
                return None

            # Parse llama-bench output
            # Format varies, but typically:
            # | model | pp | tg |
            # or CSV output
            pp_tok_s = None
            tg_tok_s = None

            # Try to parse table format
            for line in output.split("\n"):
                line = line.strip()
                # Look for numbers in the output
                if "pp" in line.lower() and "tg" in line.lower():
                    continue  # header
                # Try regex for numbers
                numbers = re.findall(r'(\d+\.?\d*)\s*t/s', line)
                if len(numbers) >= 2:
                    pp_tok_s = float(numbers[0])
                    tg_tok_s = float(numbers[1])
                elif len(numbers) == 1 and pp_tok_s is None:
                    pp_tok_s = float(numbers[0])
                elif len(numbers) == 1 and tg_tok_s is None:
                    tg_tok_s = float(numbers[0])

            # Also try: look for lines with just numbers (CSV-like)
            if pp_tok_s is None:
                for line in output.split("\n"):
                    parts = line.strip().split(",")
                    if len(parts) >= 2:
                        try:
                            pp_tok_s = float(parts[-2])
                            tg_tok_s = float(parts[-1])
                            break
                        except ValueError:
                            continue

            if pp_tok_s is not None and tg_tok_s is not None:
                self._append(f"  ✅ pp={pp_tok_s:.1f} t/s, tg={tg_tok_s:.1f} t/s")
                return {"pp": pp_tok_s, "tg": tg_tok_s}
            elif pp_tok_s is not None:
                self._append(f"  ✅ pp={pp_tok_s:.1f} t/s, tg=N/A")
                return {"pp": pp_tok_s, "tg": 0.0}
            else:
                self._append(f"  ⚠️ 无法解析输出")
                # Log first 500 chars of output for debugging
                self._append(f"  输出: {output[:500]}")
                return None

        except subprocess.TimeoutExpired:
            self._append(f"  ❌ 超时 (>300s)")
            return None
        except Exception as e:
            self._append(f"  ❌ 错误: {e}")
            return None

    async def run_optimization(
        self,
        llama_cpp_dir: str,
        model_path: str,
        threads: int,
        ngl_range: tuple[int, int],
        n_cpu_moe_range: tuple[int, int],
        ctx_options: list[int],
        kv_options: list[str],
        n_trials: int = 50,
        mmap: bool = True,
        mlock: bool = False,
    ):
        """Run Bayesian optimization."""
        import optuna

        if self._is_running:
            raise RuntimeError("Optimization already running.")

        self._is_running = True
        self._should_stop = False
        self._log_buffer.clear()
        self._results.clear()
        self._best_result = None
        self._current_trial = 0
        self._total_trials = n_trials

        bench_bin = self._find_bench_binary(llama_cpp_dir)
        if not bench_bin:
            self._append("❌ 未找到 llama-bench，请先编译 llama.cpp")
            self._is_running = False
            return

        self._append(f"🔧 llama-bench: {bench_bin}")
        self._append(f"📊 模型: {model_path}")
        self._append(f"📊 参数范围:")
        self._append(f"  ngl: {ngl_range[0]}~{ngl_range[1]}")
        self._append(f"  n_cpu_moe: {n_cpu_moe_range[0]}~{n_cpu_moe_range[1]}")
        self._append(f"  ctx: {ctx_options}")
        self._append(f"  kv: {kv_options}")
        self._append(f"📊 总试验次数: {n_trials}")
        self._append(f"📊 线程数: {threads}")
        self._append(f"")

        # Suppress optuna logs
        optuna.logging.set_verbosity(optuna.logging.WARNING)

        study = optuna.create_study(direction="maximize")  # maximize tg tok/s

        def objective(trial):
            if self._should_stop:
                raise optuna.exceptions.TrialPruned()

            ngl = trial.suggest_int("ngl", ngl_range[0], ngl_range[1])
            n_cpu_moe = trial.suggest_int("n_cpu_moe", n_cpu_moe_range[0], n_cpu_moe_range[1])
            ctx = trial.suggest_categorical("ctx", ctx_options)
            kv = trial.suggest_categorical("kv", kv_options)

            self._current_trial = trial.number + 1
            self._append(f"")
            self._append(f"━━━ 试验 {self._current_trial}/{n_trials} ━━━")
            self._append(f"  ngl={ngl}, n_cpu_moe={n_cpu_moe}, ctx={ctx}, kv={kv}")
            self._notify_update()

            result = self._run_bench(bench_bin, model_path, ngl, threads, ctx, kv, kv, n_cpu_moe, mmap, mlock)

            if result is None:
                # OOM or error — return very bad score
                return 0.0

            entry = {
                "trial": self._current_trial,
                "ngl": ngl,
                "n_cpu_moe": n_cpu_moe,
                "ctx": ctx,
                "kv": kv,
                "pp": round(result["pp"], 1),
                "tg": round(result["tg"], 1),
                "score": round(result["tg"], 1),
                "status": "ok",
            }
            self._results.append(entry)
            self._notify_result(entry)

            # Update best
            if self._best_result is None or result["tg"] > self._best_result.get("tg", 0):
                self._best_result = entry
                self._append(f"  🏆 新最优! tg={result['tg']:.1f} t/s")

            self._notify_update()
            return result["tg"]

        try:
            await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
            )
        except Exception as e:
            self._append(f"❌ 优化中断: {e}")

        # Final summary
        self._append(f"")
        self._append(f"━━━ 优化完成 ━━━")
        if study.best_trial:
            best = study.best_trial
            self._append(f"🏆 最优配置:")
            self._append(f"  ngl = {best.params.get('ngl')}")
            self._append(f"  n_cpu_moe = {best.params.get('n_cpu_moe')}")
            self._append(f"  ctx = {best.params.get('ctx')}")
            self._append(f"  kv = {best.params.get('kv')}")
            self._append(f"  tg = {best.value:.1f} t/s")

        self._is_running = False
        self._notify_update()

    async def stop(self):
        self._should_stop = True
        self._append("[optimizer] 停止中...")

    def get_status(self) -> dict:
        return {
            "is_running": self._is_running,
            "current_trial": self._current_trial,
            "total_trials": self._total_trials,
            "best": self._best_result,
            "results": self._results,
            "logs": self._log_buffer[-100:],  # Last 100 lines
        }

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)


optimizer = Optimizer()
