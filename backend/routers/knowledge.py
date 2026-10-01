from __future__ import annotations

import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Request

from ..api_models import EmbeddingSettings, JobCreate, KnowledgeBaseCreate, KnowledgeSearchRequest, KnowledgeSourceCreate


router = APIRouter(tags=["knowledge"])


@router.get("/api/knowledge-bases")
async def list_knowledge_bases(request: Request):
    rows = await request.app.state.db.fetchall("""SELECT k.*, COUNT(DISTINCT s.id) AS source_count, COUNT(DISTINCT c.id) AS chunk_count
        FROM knowledge_bases k LEFT JOIN knowledge_sources s ON s.knowledge_base_id=k.id
        LEFT JOIN knowledge_chunks c ON c.knowledge_base_id=k.id GROUP BY k.id ORDER BY k.updated_at DESC""")
    return {"knowledge_bases": rows}


@router.post("/api/knowledge-bases")
async def create_knowledge_base(body: KnowledgeBaseCreate, request: Request):
    knowledge_base_id, now = uuid.uuid4().hex, time.time()
    await request.app.state.db.execute("INSERT INTO knowledge_bases(id, name, description, created_at, updated_at) VALUES(?, ?, ?, ?, ?)", (knowledge_base_id, body.name, body.description, now, now))
    return {"id": knowledge_base_id, **body.model_dump(), "source_count": 0, "chunk_count": 0, "created_at": now, "updated_at": now}


@router.get("/api/knowledge-bases/{knowledge_base_id}")
async def get_knowledge_base(knowledge_base_id: str, request: Request):
    item = await request.app.state.db.fetchone("SELECT * FROM knowledge_bases WHERE id=?", (knowledge_base_id,))
    if not item: raise KeyError("Knowledge base not found")
    item["sources"] = await request.app.state.db.fetchall("SELECT * FROM knowledge_sources WHERE knowledge_base_id=? ORDER BY updated_at DESC", (knowledge_base_id,))
    return item


@router.delete("/api/knowledge-bases/{knowledge_base_id}")
async def delete_knowledge_base(knowledge_base_id: str, request: Request):
    chunk_ids = await request.app.state.db.fetchall("SELECT id FROM knowledge_chunks WHERE knowledge_base_id=?", (knowledge_base_id,))
    for chunk in chunk_ids: await request.app.state.db.execute("DELETE FROM knowledge_chunks_fts WHERE chunk_id=?", (chunk["id"],))
    await request.app.state.db.execute("DELETE FROM knowledge_bases WHERE id=?", (knowledge_base_id,))
    request.app.state.knowledge._vector_cache.pop(knowledge_base_id, None)
    return {"ok": True}


@router.post("/api/knowledge-bases/{knowledge_base_id}/sources")
async def add_source(knowledge_base_id: str, body: KnowledgeSourceCreate, request: Request):
    path = Path(body.path).expanduser().resolve()
    if not path.exists(): raise ValueError("路径不存在")
    if body.kind == "file" and not path.is_file(): raise ValueError("来源类型与路径不匹配")
    if body.kind == "directory" and not path.is_dir(): raise ValueError("来源类型与路径不匹配")
    source_id, now = uuid.uuid4().hex, time.time()
    await request.app.state.db.execute("INSERT INTO knowledge_sources(id, knowledge_base_id, path, kind, updated_at) VALUES(?, ?, ?, ?, ?)", (source_id, knowledge_base_id, str(path), body.kind, now))
    return {"id": source_id, "knowledge_base_id": knowledge_base_id, "path": str(path), "kind": body.kind, "status": "pending", "updated_at": now}


@router.delete("/api/knowledge-sources/{source_id}")
async def delete_source(source_id: str, request: Request):
    chunks = await request.app.state.db.fetchall("SELECT c.id, c.knowledge_base_id FROM knowledge_chunks c JOIN knowledge_files f ON f.id=c.file_id WHERE f.source_id=?", (source_id,))
    for chunk in chunks: await request.app.state.db.execute("DELETE FROM knowledge_chunks_fts WHERE chunk_id=?", (chunk["id"],))
    await request.app.state.db.execute("DELETE FROM knowledge_sources WHERE id=?", (source_id,))
    for knowledge_base_id in {chunk["knowledge_base_id"] for chunk in chunks}: request.app.state.knowledge._vector_cache.pop(knowledge_base_id, None)
    return {"ok": True}


@router.post("/api/knowledge-sources/{source_id}/sync")
async def sync_source(source_id: str, request: Request):
    source = await request.app.state.db.fetchone("SELECT * FROM knowledge_sources WHERE id=?", (source_id,))
    if not source: raise KeyError("Knowledge source not found")
    job = await request.app.state.jobs.create(JobCreate(kind="knowledge_sync", payload={"source_id": source_id}, resources=[f"filesystem:{source['path']}"]))
    return {"job": job}


@router.post("/api/knowledge/search")
async def search_knowledge(body: KnowledgeSearchRequest, request: Request):
    return await request.app.state.knowledge.search(body.knowledge_base_ids, body.query, body.limit)


@router.get("/api/knowledge/settings")
async def get_embedding_settings(request: Request):
    return await request.app.state.knowledge.settings()


@router.put("/api/knowledge/settings")
async def put_embedding_settings(body: EmbeddingSettings, request: Request):
    return await request.app.state.knowledge.save_settings(body)
