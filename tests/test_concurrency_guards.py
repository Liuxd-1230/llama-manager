"""Regression guards for the P0 concurrency fixes.

Covers four traps that controlled fixtures can actually reproduce:
- the ComfyUI poll loop must yield to the event loop, not stall it;
- start/stop must serialize so a double click cannot spawn two engines;
- command building must leave the event loop thread;
- profile saves must be atomic and locked under thread contention.
"""
import asyncio
import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from backend import config_manager as cfg
from backend.models import AppConfig
from backend.process_manager import ProcessManager


class FakeEngineProcess:
    """Minimal asyncio subprocess stand-in: no stdout, never crashes."""

    def __init__(self):
        self.pid = 4242
        self.returncode = None
        self.stdout = None

    async def wait(self):
        return self.returncode

    def terminate(self):
        self.returncode = 0

    def kill(self):
        self.returncode = -9


class ProcessManagerGuardTests(unittest.IsolatedAsyncioTestCase):
    async def _start(self, manager: ProcessManager, profile: str):
        async def fake_exec(*cmd, **kwargs):
            return FakeEngineProcess()

        with patch.object(manager, "build_command", return_value=("fake-server", "-m", "x")), \
                patch.object(manager, "_engine_dir", return_value="engine-dir"), \
                patch("backend.process_manager.record_engine_pid"), \
                patch("backend.process_manager.asyncio.create_subprocess_exec", fake_exec):
            await manager.start(AppConfig(), profile_name=profile)

    async def test_concurrent_starts_spawn_only_one_engine(self):
        manager = ProcessManager()
        spawns = []

        async def fake_exec(*cmd, **kwargs):
            spawns.append(cmd)
            return FakeEngineProcess()

        with patch.object(manager, "build_command", return_value=("fake-server", "-m", "x")), \
                patch.object(manager, "_engine_dir", return_value="engine-dir"), \
                patch("backend.process_manager.record_engine_pid"), \
                patch("backend.process_manager.asyncio.create_subprocess_exec", fake_exec):
            results = await asyncio.gather(
                manager.start(AppConfig(), profile_name="first"),
                manager.start(AppConfig(), profile_name="second"),
                return_exceptions=True,
            )
        self.assertEqual(len(spawns), 1, "two concurrent starts must not spawn two engines")
        errors = [r for r in results if isinstance(r, Exception)]
        self.assertEqual(len(errors), 1)
        self.assertIn("already running", str(errors[0]))
        if manager._reader_task:
            await manager._reader_task

    async def test_command_build_runs_off_the_event_loop_thread(self):
        manager = ProcessManager()
        loop_thread = threading.get_ident()
        seen = {}

        def fake_build(config):
            seen["build"] = threading.get_ident()
            return ("fake-server", "-m", "x")

        def fake_engine_dir(config):
            seen["dir"] = threading.get_ident()
            return "engine-dir"

        async def fake_exec(*cmd, **kwargs):
            return FakeEngineProcess()

        with patch.object(manager, "build_command", side_effect=fake_build), \
                patch.object(manager, "_engine_dir", side_effect=fake_engine_dir), \
                patch("backend.process_manager.record_engine_pid"), \
                patch("backend.process_manager.asyncio.create_subprocess_exec", fake_exec):
            await manager.start(AppConfig(), profile_name="probe")
        self.assertNotEqual(seen["build"], loop_thread, "build_command must not run on the loop thread")
        self.assertNotEqual(seen["dir"], loop_thread, "engine dir resolution must not run on the loop thread")
        if manager._reader_task:
            await manager._reader_task

    async def test_stop_reaps_process_and_clears_profile(self):
        manager = ProcessManager()
        manager._process = FakeEngineProcess()
        manager._profile_name = "Hermes"
        with patch("backend.process_manager.IS_WINDOWS", False), \
                patch("backend.process_manager.forget_engine_pid") as forget:
            await manager.stop()
        self.assertEqual(manager._process.returncode, 0)
        self.assertEqual(manager._profile_name, "")
        forget.assert_called_once_with(4242)

    async def test_stop_without_process_is_a_noop(self):
        manager = ProcessManager()
        with patch("backend.process_manager.IS_WINDOWS", False):
            await manager.stop()
        self.assertEqual(manager._profile_name, "")


class ProfileSaveAtomicityTests(unittest.TestCase):
    def test_concurrent_saves_keep_every_profile_valid(self):
        with TemporaryDirectory() as tmp, patch.object(cfg, "CONFIG_DIR", Path(tmp)):
            def save(index):
                cfg.save_config(AppConfig(llama_cpp_dir=f"C:/engine-{index}"), name=f"p{index}")

            threads = [threading.Thread(target=save, args=(i,)) for i in range(24)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            names = sorted(p.stem for p in Path(tmp).glob("*.json"))
            self.assertEqual(len(names), 24)
            for name in names:
                data = json.loads((Path(tmp) / f"{name}.json").read_text(encoding="utf-8"))
                self.assertTrue(data["llama_cpp_dir"].startswith("C:/engine-"))
            self.assertEqual(list(Path(tmp).glob("*.tmp")), [], "atomic writes must clean up temp files")

    def test_same_profile_concurrent_saves_stay_valid(self):
        with TemporaryDirectory() as tmp, patch.object(cfg, "CONFIG_DIR", Path(tmp)):
            def save(index):
                cfg.save_config(AppConfig(llama_cpp_dir=f"C:/engine-{index}"), name="shared")

            threads = [threading.Thread(target=save, args=(i,)) for i in range(24)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            data = json.loads((Path(tmp) / "shared.json").read_text(encoding="utf-8"))
            self.assertTrue(data["llama_cpp_dir"].startswith("C:/engine-"))
            self.assertEqual(list(Path(tmp).glob("*.tmp")), [])

    def test_failed_save_leaves_no_temp_file_and_keeps_old_profile(self):
        with TemporaryDirectory() as tmp, patch.object(cfg, "CONFIG_DIR", Path(tmp)):
            cfg.save_config(AppConfig(llama_cpp_dir="C:/keep"), name="keep")
            before = (Path(tmp) / "keep.json").read_text(encoding="utf-8")
            with patch.object(cfg.json, "dumps", side_effect=ValueError("boom")):
                with self.assertRaises(ValueError):
                    cfg.save_config(AppConfig(llama_cpp_dir="C:/new"), name="keep")
            self.assertEqual((Path(tmp) / "keep.json").read_text(encoding="utf-8"), before)
            self.assertEqual(list(Path(tmp).glob("*.tmp")), [])


class ComfyPollingTests(unittest.IsolatedAsyncioTestCase):
    async def test_polling_keeps_the_event_loop_responsive(self):
        from backend.moss_server import comfy

        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, url):
                # Yield once like a real HTTP round-trip would, so the
                # heartbeat can run between polls; without this the poller
                # would never reach an await point and the guard is blind.
                await asyncio.sleep(0)
                # Never completes: the poller runs until the test cancels it.
                return SimpleNamespace(status_code=200, json=lambda: {})

        max_gap = 0.0

        async def heartbeat():
            nonlocal max_gap
            loop = asyncio.get_running_loop()
            last = loop.time()
            while True:
                await asyncio.sleep(0.02)
                now = loop.time()
                max_gap = max(max_gap, now - last)
                last = now

        with patch.object(comfy.httpx, "AsyncClient", FakeClient):
            waiter = asyncio.create_task(comfy.wait_for_images("http://fixture", "pid", timeout=5.0))
            beat = asyncio.create_task(heartbeat())
            await asyncio.sleep(0.35)
            beat.cancel()
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            await asyncio.gather(beat, return_exceptions=True)
        # A sync sleep in the poll loop blocks the loop for ~0.8s per tick and
        # would push the heartbeat gap past this bound.
        self.assertLess(max_gap, 0.5, f"event loop stalled {max_gap:.3f}s during polling")


if __name__ == "__main__":
    unittest.main()
