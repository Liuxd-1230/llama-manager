import asyncio
import tempfile
import time
import unittest
from pathlib import Path

import httpx

from backend.api_models import EmbeddingSettings, JobCreate
from backend.evaluation import EvaluationService, pareto_front
from backend.jobs import JobManager
from backend.knowledge import KnowledgeService, _chunk_text, _evidence_confidence
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
            peak = max(peak, active)
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

    async def test_knowledge_sync_is_incremental_and_replaces_changed_file(self):
        root = Path(self.temp.name) / "docs"
        root.mkdir()
        document = root / "guide.md"
        document.write_text("alpha setup guide", encoding="utf-8")
        now = time.time()
        await self.db.execute("INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES('kb', 'Docs', ?, ?)", (now, now))
        await self.db.execute("INSERT INTO knowledge_sources(id, knowledge_base_id, path, kind, updated_at) VALUES('source', 'kb', ?, 'directory', ?)", (str(root), now))
        await self.db.set_setting("embedding", EmbeddingSettings(base_url="http://embedding.test/v1", model="embed").model_dump())
        async with httpx.AsyncClient() as client:
            service = KnowledgeService(self.db, client)

            async def embed(texts):
                return [[1.0, float(index + 1)] for index, _ in enumerate(texts)]

            service.embed = embed
            context = _Context()
            first = await service.sync_job(context, {"source_id": "source"})
            second = await service.sync_job(context, {"source_id": "source"})
            document.write_text("beta replacement guide", encoding="utf-8")
            third = await service.sync_job(context, {"source_id": "source"})
        chunks = await self.db.fetchall("SELECT content FROM knowledge_chunks WHERE knowledge_base_id='kb'")
        self.assertEqual(first["added"], 1)
        self.assertEqual(second["unchanged"], 1)
        self.assertEqual(third["changed"], 1)
        self.assertEqual([row["content"] for row in chunks], ["beta replacement guide"])

    def test_chunking_preserves_overlap_and_line_citations(self):
        chunks = _chunk_text("line\n" * 80, size=120, overlap=20)
        self.assertGreater(len(chunks), 1)
        self.assertEqual(chunks[0]["line_start"], 1)
        self.assertLess(chunks[0]["line_start"], chunks[-1]["line_start"])

    def test_knowledge_evidence_rejects_unrelated_low_similarity(self):
        unrelated = _evidence_confidence("安装步骤", {"content": "完全无关的天气记录", "vector_score": .21})
        lexical = _evidence_confidence("安装步骤", {"content": "这里是安装步骤和注意事项"})
        self.assertLess(unrelated, .25)
        self.assertGreaterEqual(lexical, .25)


class _Context:
    async def ensure_active(self):
        return None

    async def emit(self, message, level="info", data=None):
        return None

    async def checkpoint(self, value):
        return None


if __name__ == "__main__":
    unittest.main()
