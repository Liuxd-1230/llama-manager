"""Detached Agent producers with replayable original SSE events."""
import asyncio
import json
import time
from . import store

active={}


def _append_event(identifier: str, event: dict):
    with store.connection() as db:
        db.execute('INSERT INTO atelier_events(job_id,event,created_at) VALUES(?,?,?)',
                   (identifier,json.dumps(event,ensure_ascii=False),time.time()))


def _read_events(identifier: str, after: int):
    with store.connection() as db:
        return db.execute('SELECT * FROM atelier_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT 256',
                          (identifier,after)).fetchall()


def running_for_session(session_id: str):
    for identifier in list(active):
        record = store.job(identifier)
        if record['data'].get('session_id') == session_id:
            return record
    return None


def start_agent(generator, title: str, data: dict):
    job=store.create_job('agent',title,data)
    identifier=job['id']
    async def produce():
        store.update_job(identifier,status='running')
        try:
            failed=False
            async for frame in generator:
                for line in frame.splitlines():
                    if line.startswith('data: '):
                        event=json.loads(line[6:])
                        if event.get('type')=='error': failed=True
                        # SQLite connection/commit must not block SSE delivery on
                        # the event loop. Persist each original delta before delivery.
                        await asyncio.to_thread(_append_event,identifier,event)
            store.update_job(identifier,status='failed' if failed else 'succeeded')
        except asyncio.CancelledError:
            store.update_job(identifier,status='cancelled')
        except Exception as exc:
            await asyncio.to_thread(_append_event,identifier,{'type':'error','message':str(exc)})
            store.update_job(identifier,status='failed',error=str(exc))
        finally:
            active.pop(identifier,None)
    active[identifier]=asyncio.create_task(produce())
    return identifier


async def stream_agent(identifier: str, after: int = 0):
    sequence=max(0, after)
    while True:
        rows=await asyncio.to_thread(_read_events,identifier,sequence)
        for row in rows:
            sequence=row['seq']
            yield f"id: {sequence}\ndata: {row['event']}\n\n"
        # The producer may finish while the previous batch is being sent.
        # Only an empty read after completion proves the durable tail is drained.
        if not rows and identifier not in active:
            record=await asyncio.to_thread(store.job,identifier)
            yield "data: " + json.dumps({"status":record["status"],"error":record.get("error","")},ensure_ascii=False) + "\n\n"
            break
        if not rows: yield ': heartbeat\n\n'
        await asyncio.sleep(0 if rows else .05)


async def close():
    tasks=list(active.values())
    for task in tasks: task.cancel()
    if tasks: await asyncio.gather(*tasks,return_exceptions=True)
