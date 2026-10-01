from __future__ import annotations

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
import os

from ..api_models import JobCreate, JobRecord


router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("", response_model=list[JobRecord])
async def list_jobs(request: Request):
    return await request.app.state.jobs.list()


@router.post("", response_model=JobRecord)
async def create_job(body: JobCreate, request: Request):
    return await request.app.state.jobs.create(body)


@router.get("/{job_id}", response_model=JobRecord)
async def get_job(job_id: str, request: Request):
    return await request.app.state.jobs.get_required(job_id)


@router.get("/{job_id}/events")
async def get_job_events(job_id: str, request: Request):
    return {"events": await request.app.state.jobs.events(job_id)}


@router.post("/{job_id}/cancel", response_model=JobRecord)
async def cancel_job(job_id: str, request: Request):
    return await request.app.state.jobs.cancel(job_id)


@router.post("/{job_id}/retry", response_model=JobRecord)
async def retry_job(job_id: str, request: Request):
    return await request.app.state.jobs.retry(job_id)


ws_router = APIRouter(tags=["jobs"])


@ws_router.websocket("/ws/jobs")
async def ws_jobs(websocket: WebSocket):
    host = websocket.client.host if websocket.client else ""
    allow_remote = os.getenv("LLAMA_MANAGER_ALLOW_REMOTE", "").lower() in {"1", "true", "yes", "on"}
    if not allow_remote and not (host in {"127.0.0.1", "::1", "localhost", "testclient"} or host.startswith("127.")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    manager = websocket.app.state.jobs
    queue = manager.subscribe()
    try:
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        manager.unsubscribe(queue)
