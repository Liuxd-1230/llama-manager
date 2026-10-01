"""Persistent background jobs with explicit local resource locks."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from .api_models import JobCreate, JobRecord
from .storage import Database


JobHandler = Callable[["JobContext", dict[str, Any]], Awaitable[dict[str, Any]]]


class JobContext:
    def __init__(self, manager: "JobManager", job_id: str):
        self.manager = manager
        self.job_id = job_id

    async def emit(self, message: str, level: str = "info", data: dict[str, Any] | None = None) -> None:
        await self.manager.emit(self.job_id, message, level, data or {})

    async def checkpoint(self, value: dict[str, Any]) -> None:
        await self.manager.db.execute(
            "UPDATE jobs SET checkpoint_json=?, updated_at=? WHERE id=?",
            (json.dumps(value, ensure_ascii=False), time.time(), self.job_id),
        )

    async def cancelled(self) -> bool:
        record = await self.manager.get(self.job_id)
        return not record or record.status == "cancelled"

    async def ensure_active(self) -> None:
        if await self.cancelled():
            raise asyncio.CancelledError


class JobManager:
    def __init__(self, db: Database):
        self.db = db
        self.handlers: dict[str, JobHandler] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.resource_locks: dict[str, asyncio.Lock] = {}
        self.subscribers: set[asyncio.Queue] = set()

    async def initialize(self) -> None:
        now = time.time()
        await self.db.execute(
            "UPDATE jobs SET status='interrupted', error='应用重启，任务已安全中断', updated_at=?, finished_at=? WHERE status IN ('queued','running')",
            (now, now),
        )

    def register(self, kind: str, handler: JobHandler) -> None:
        self.handlers[kind] = handler

    def busy_resources(self, resources: list[str]) -> list[str]:
        """Return which of the given resources are currently held by a running job."""
        return [name for name in resources if name in self.resource_locks and self.resource_locks[name].locked()]

    async def create(self, request: JobCreate) -> JobRecord:
        if request.kind not in self.handlers:
            raise ValueError(f"Unsupported job kind: {request.kind}")
        job_id = uuid.uuid4().hex
        now = time.time()
        resources = sorted(set(request.resources))
        await self.db.execute(
            "INSERT INTO jobs(id, kind, status, payload_json, resources_json, created_at, updated_at) VALUES(?, ?, 'queued', ?, ?, ?, ?)",
            (job_id, request.kind, json.dumps(request.payload, ensure_ascii=False), json.dumps(resources), now, now),
        )
        self.tasks[job_id] = asyncio.create_task(self._run(job_id))
        return await self.get_required(job_id)

    async def _run(self, job_id: str) -> None:
        record = await self.get_required(job_id)
        locks = [self.resource_locks.setdefault(resource, asyncio.Lock()) for resource in record.resources]
        acquired: list[asyncio.Lock] = []
        try:
            for lock in locks:
                await lock.acquire()
                acquired.append(lock)
            if (await self.get_required(job_id)).status == "cancelled":
                return
            now = time.time()
            await self.db.execute("UPDATE jobs SET status='running', started_at=?, updated_at=? WHERE id=?", (now, now, job_id))
            await self.emit(job_id, "任务已开始", data={"kind": record.kind})
            result = await self.handlers[record.kind](JobContext(self, job_id), record.payload)
            now = time.time()
            await self.db.execute(
                "UPDATE jobs SET status='succeeded', result_json=?, updated_at=?, finished_at=? WHERE id=? AND status!='cancelled'",
                (json.dumps(result or {}, ensure_ascii=False), now, now, job_id),
            )
            await self.emit(job_id, "任务已完成", data=result or {})
        except asyncio.CancelledError:
            now = time.time()
            await self.db.execute("UPDATE jobs SET status='cancelled', updated_at=?, finished_at=? WHERE id=?", (now, now, job_id))
            await self.emit(job_id, "任务已取消", level="warning")
        except Exception as exc:
            now = time.time()
            await self.db.execute(
                "UPDATE jobs SET status='failed', error=?, updated_at=?, finished_at=? WHERE id=?",
                (str(exc), now, now, job_id),
            )
            await self.emit(job_id, f"任务失败：{exc}", level="error")
        finally:
            for lock in reversed(acquired):
                lock.release()
            self.tasks.pop(job_id, None)

    async def cancel(self, job_id: str) -> JobRecord:
        record = await self.get_required(job_id)
        if record.status not in {"queued", "running"}:
            return record
        await self.db.execute("UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?", (time.time(), job_id))
        task = self.tasks.get(job_id)
        if task:
            task.cancel()
        return await self.get_required(job_id)

    async def retry(self, job_id: str) -> JobRecord:
        record = await self.get_required(job_id)
        if record.status not in {"failed", "cancelled", "interrupted"}:
            raise ValueError("Only failed, cancelled, or interrupted jobs can be retried")
        return await self.create(JobCreate(kind=record.kind, payload=record.payload, resources=record.resources))

    async def emit(self, job_id: str, message: str, level: str = "info", data: dict[str, Any] | None = None) -> None:
        event = {"job_id": job_id, "created_at": time.time(), "level": level, "message": message, "data": data or {}}
        await self.db.execute(
            "INSERT INTO job_events(job_id, created_at, level, message, data_json) VALUES(?, ?, ?, ?, ?)",
            (job_id, event["created_at"], level, message, json.dumps(event["data"], ensure_ascii=False)),
        )
        for queue in list(self.subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    async def get(self, job_id: str) -> JobRecord | None:
        row = await self.db.fetchone("SELECT * FROM jobs WHERE id=?", (job_id,))
        return _job_from_row(row) if row else None

    async def get_required(self, job_id: str) -> JobRecord:
        record = await self.get(job_id)
        if not record:
            raise KeyError(f"Job not found: {job_id}")
        return record

    async def list(self, limit: int = 100) -> list[JobRecord]:
        rows = await self.db.fetchall("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))
        return [_job_from_row(row) for row in rows]

    async def events(self, job_id: str) -> list[dict[str, Any]]:
        rows = await self.db.fetchall("SELECT * FROM job_events WHERE job_id=? ORDER BY id", (job_id,))
        result = []
        for row in rows:
            data = json.loads(row.pop("data_json"))
            result.append({**row, "data": data})
        return result

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)


def _job_from_row(row: dict[str, Any]) -> JobRecord:
    return JobRecord(
        id=row["id"], kind=row["kind"], status=row["status"],
        payload=json.loads(row["payload_json"]), result=json.loads(row["result_json"]),
        checkpoint=json.loads(row["checkpoint_json"]), resources=json.loads(row["resources_json"]),
        error=row["error"], created_at=row["created_at"], updated_at=row["updated_at"],
        started_at=row["started_at"], finished_at=row["finished_at"],
    )


async def noop_handler(context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
    await context.emit("空任务检查通过")
    return payload
