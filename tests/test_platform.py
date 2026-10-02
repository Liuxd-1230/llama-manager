import asyncio
import tempfile
import time
import unittest
from pathlib import Path

import httpx

from backend.api_models import JobCreate
from backend.evaluation import EvaluationService, pareto_front
from backend.jobs import JobManager
from backend.storage import Database


class PlatformRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / "manager.db")
        await self.db.initialize()

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_migrations_are_idempotent_and_enable_wal(self):
        await self.db.initialize()
        versions = await self.db.fetchall("SELECT version FROM schema_migrations ORDER BY version")
        columns = await self.db.fetchall("PRAGMA table_info(turns)")
        journal = await self.db.fetchone("PRAGMA journal_mode")
        self.assertEqual([row["version"] for row in versions], [1, 2])
        self.assertIn("active_candidate_id", {row["name"] for row in columns})
        self.assertEqual(journal["journal_mode"], "wal")

    async def test_job_resource_lock_serializes_and_restart_interrupts(self):
        manager = JobManager(self.db)
        active = 0
        peak = 0

        async def handler(context, payload):
            nonlocal active, peak
            active += 1
            peak = max(active, peak)
            await asyncio.sleep(0.03)
            active -= 1
            return payload

        manager.register("test", handler)
        first = await manager.create(JobCreate(kind="test", resources=["gpu"]))
        second = await manager.create(JobCreate(kind="test", resources=["gpu"]))
        await asyncio.gather(manager.tasks[first.id], manager.tasks[second.id])
        self.assertEqual(peak, 1)
        self.assertEqual((await manager.get_required(first.id)).status, "succeeded")
        await self.db.execute(
            "INSERT INTO jobs(id, kind, status, created_at, updated_at) VALUES('orphan', 'test', 'running', ?, ?)",
            (time.time(), time.time()),
        )
        await manager.initialize()
        self.assertEqual((await manager.get_required("orphan")).status, "interrupted")

    async def test_deterministic_scoring_and_pareto_front(self):
        async with httpx.AsyncClient() as client:
            service = EvaluationService(self.db, client)
            score, _ = await service.score('{"ok":true}', "", {"type": "json_schema", "schema": {"type": "object", "properties": {"ok": {"const": True}}, "required": ["ok"]}}, False)
            blocked, details = await service.score("answer", "", {"type": "command", "command": "exit 0"}, False)
        self.assertEqual(score, 1.0)
        self.assertEqual(blocked, 0.0)
        self.assertTrue(details["blocked"])
        records = [
            {"id": "fast", "metrics": {"quality": .9, "throughput_chars_s": 20, "avg_latency_ms": 100, "gpu_memory_peak_mb": 1000}},
            {"id": "slow", "metrics": {"quality": .8, "throughput_chars_s": 10, "avg_latency_ms": 200, "gpu_memory_peak_mb": 1200}},
            {"id": "quality", "metrics": {"quality": 1, "throughput_chars_s": 8, "avg_latency_ms": 250, "gpu_memory_peak_mb": 1100}},
        ]
        self.assertEqual({item["id"] for item in pareto_front(records)}, {"fast", "quality"})


if __name__ == "__main__":
    unittest.main()
