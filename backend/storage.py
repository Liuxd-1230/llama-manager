"""SQLite persistence with explicit, idempotent migrations."""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any, Iterable

import aiosqlite

from .env_manager import APP_DATA_DIR


DATABASE_PATH = APP_DATA_DIR / "manager.db"

MIGRATIONS: list[list[str]] = [[
    """CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, applied_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话',
        created_at REAL NOT NULL, updated_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, user_content TEXT NOT NULL, user_display TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]', created_at REAL NOT NULL,
        UNIQUE(conversation_id, position)
    )""",
    """CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        parent_candidate_id TEXT, backend_id TEXT, provider_id TEXT NOT NULL, model TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS tool_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, event_json TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}', result_json TEXT NOT NULL DEFAULT '{}',
        checkpoint_json TEXT NOT NULL DEFAULT '{}', resources_json TEXT NOT NULL DEFAULT '[]',
        error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
        started_at REAL, finished_at REAL
    )""",
    """CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        created_at REAL NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}'
    )""",
    """CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        builtin INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS dataset_cases (
        id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, prompt TEXT NOT NULL, expected TEXT NOT NULL DEFAULT '',
        evaluator_json TEXT NOT NULL DEFAULT '{}', metadata_json TEXT NOT NULL DEFAULT '{}'
    )""",
    """CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        provider_id TEXT NOT NULL, model TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
        metrics_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL,
        created_at REAL NOT NULL, finished_at REAL
    )""",
    """CREATE TABLE IF NOT EXISTS evaluation_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        case_id TEXT REFERENCES dataset_cases(id) ON DELETE SET NULL, response TEXT NOT NULL,
        score REAL NOT NULL, latency_ms REAL NOT NULL, details_json TEXT NOT NULL DEFAULT '{}'
    )""",
    """CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL, updated_at REAL NOT NULL, last_sync_at REAL
    )""",
    """CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        path TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', file_count INTEGER NOT NULL DEFAULT 0,
        updated_at REAL NOT NULL, UNIQUE(knowledge_base_id, path)
    )""",
    """CREATE TABLE IF NOT EXISTS knowledge_files (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        path TEXT NOT NULL, fingerprint TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        modified_at REAL NOT NULL, indexed_at REAL NOT NULL, UNIQUE(source_id, path)
    )""",
    """CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
        source_path TEXT NOT NULL, content TEXT NOT NULL, page INTEGER,
        line_start INTEGER, line_end INTEGER, chunk_index INTEGER NOT NULL,
        embedding BLOB, embedding_dim INTEGER, embedding_model TEXT NOT NULL DEFAULT ''
    )""",
    """CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        chunk_id UNINDEXED, knowledge_base_id UNINDEXED, content, tokenize='unicode61'
    )""",
    """CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at REAL NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id, position)",
    "CREATE INDEX IF NOT EXISTS idx_candidates_turn ON candidates(turn_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_cases_dataset ON dataset_cases(dataset_id, position)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_kb ON knowledge_chunks(knowledge_base_id)",
], [
    "ALTER TABLE turns ADD COLUMN active_candidate_id TEXT NOT NULL DEFAULT ''",
]]


class Database:
    def __init__(self, path: Path = DATABASE_PATH):
        self.path = path

    async def _connect(self) -> aiosqlite.Connection:
        connection = await aiosqlite.connect(self.path)
        connection.row_factory = aiosqlite.Row
        await connection.execute("PRAGMA foreign_keys=ON")
        await connection.execute("PRAGMA journal_mode=WAL")
        await connection.execute("PRAGMA busy_timeout=5000")
        return connection

    async def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            await self._migrate()
        except (aiosqlite.DatabaseError, OSError):
            if self.path.exists():
                backup = self.path.with_name(f"{self.path.name}.corrupt-{int(time.time())}")
                shutil.move(self.path, backup)
            await self._migrate()

    async def _migrate(self) -> None:
        connection = await self._connect()
        try:
            await connection.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at REAL NOT NULL)")
            rows = await connection.execute_fetchall("SELECT version FROM schema_migrations")
            applied = {int(row[0]) for row in rows}
            for version, statements in enumerate(MIGRATIONS, 1):
                if version in applied:
                    continue
                await connection.execute("BEGIN")
                try:
                    for statement in statements:
                        await connection.execute(statement)
                    await connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)", (version, time.time()))
                    await connection.commit()
                except Exception:
                    await connection.rollback()
                    raise
        finally:
            await connection.close()

    async def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        connection = await self._connect()
        try:
            cursor = await connection.execute(sql, tuple(params))
            await connection.commit()
            return cursor.rowcount
        finally:
            await connection.close()

    async def executemany(self, sql: str, rows: Iterable[Iterable[Any]]) -> None:
        connection = await self._connect()
        try:
            await connection.executemany(sql, [tuple(row) for row in rows])
            await connection.commit()
        finally:
            await connection.close()

    async def fetchone(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        connection = await self._connect()
        try:
            cursor = await connection.execute(sql, tuple(params))
            row = await cursor.fetchone()
            return dict(row) if row else None
        finally:
            await connection.close()

    async def fetchall(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        connection = await self._connect()
        try:
            cursor = await connection.execute(sql, tuple(params))
            return [dict(row) for row in await cursor.fetchall()]
        finally:
            await connection.close()

    async def transaction(self, statements: list[tuple[str, Iterable[Any]]]) -> None:
        connection = await self._connect()
        try:
            await connection.execute("BEGIN")
            for sql, params in statements:
                await connection.execute(sql, tuple(params))
            await connection.commit()
        except Exception:
            await connection.rollback()
            raise
        finally:
            await connection.close()

    async def get_setting(self, key: str, default: Any = None) -> Any:
        row = await self.fetchone("SELECT value_json FROM app_settings WHERE key=?", (key,))
        return json.loads(row["value_json"]) if row else default

    async def set_setting(self, key: str, value: Any) -> None:
        await self.execute(
            "INSERT INTO app_settings(key, value_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            (key, json.dumps(value, ensure_ascii=False), time.time()),
        )


database = Database()
