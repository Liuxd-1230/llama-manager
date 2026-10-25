import asyncio
import tempfile
import time
import unittest
from pathlib import Path

import httpx

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

