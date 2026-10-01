"""Persistent local knowledge bases with incremental hybrid retrieval."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from pypdf import PdfReader

from .api_models import EmbeddingSettings
from .jobs import JobContext
from .storage import Database


TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".rst", ".py", ".js", ".jsx", ".ts", ".tsx", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".java", ".go", ".rs", ".sql",
    ".sh", ".ps1", ".bat", ".html", ".css", ".xml", ".csv",
}
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_FILES_PER_SOURCE = 5000


class KnowledgeService:
    def __init__(self, db: Database, client: httpx.AsyncClient):
        self.db = db
        self.client = client
        self._vector_cache: dict[str, tuple[list[str], np.ndarray, list[dict[str, Any]]]] = {}

    async def settings(self) -> dict[str, Any]:
        value = await self.db.get_setting("embedding", {})
        settings = EmbeddingSettings(**value)
        return {**settings.model_dump(), "api_key_set": bool(os.getenv(settings.api_key_env, "").strip())}

    async def save_settings(self, body: EmbeddingSettings) -> dict[str, Any]:
        await self.db.set_setting("embedding", body.model_dump())
        self._vector_cache.clear()
        return await self.settings()

    async def sync_job(self, context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
        source_id = payload["source_id"]
        await self.db.execute("UPDATE knowledge_sources SET status='syncing', updated_at=? WHERE id=?", (time.time(), source_id))
        try:
            return await self._sync_source(context, payload)
        except asyncio.CancelledError:
            await self.db.execute("UPDATE knowledge_sources SET status='pending', updated_at=? WHERE id=?", (time.time(), source_id))
            raise
        except Exception:
            await self.db.execute("UPDATE knowledge_sources SET status='failed', updated_at=? WHERE id=?", (time.time(), source_id))
            raise

    async def _sync_source(self, context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
        source = await self.db.fetchone("SELECT * FROM knowledge_sources WHERE id=?", (payload["source_id"],))
        if not source:
            raise ValueError("知识来源不存在")
        embedding_settings = EmbeddingSettings(**(await self.db.get_setting("embedding", {})))
        if not embedding_settings.base_url or not embedding_settings.model:
            raise ValueError("请先配置 embedding 端点和模型")
        root = Path(source["path"]).expanduser().resolve()
        if not root.exists():
            raise ValueError(f"路径不存在：{root}")
        files = _discover_files(root, source["kind"])
        if len(files) > MAX_FILES_PER_SOURCE:
            raise ValueError(f"文件数量超过上限 {MAX_FILES_PER_SOURCE}")
        existing_rows = await self.db.fetchall("SELECT * FROM knowledge_files WHERE source_id=?", (source["id"],))
        existing = {row["path"]: row for row in existing_rows}
        seen: set[str] = set()
        added = changed = unchanged = 0
        for index, path in enumerate(files, 1):
            await context.ensure_active()
            resolved = path.resolve()
            if source["kind"] == "directory" and root not in resolved.parents and resolved != root:
                continue
            fingerprint = _fingerprint(resolved)
            seen.add(str(resolved))
            old = existing.get(str(resolved))
            if old and old["fingerprint"] == fingerprint:
                unchanged += 1
                continue
            await context.emit(f"索引 {index}/{len(files)}：{resolved.name}")
            file_id = uuid.uuid4().hex
            stat = resolved.stat()
            chunks = _parse_and_chunk(resolved)
            embeddings = await self.embed([chunk["content"] for chunk in chunks]) if chunks else []
            statements: list[tuple[str, tuple[Any, ...]]] = []
            if old:
                old_chunks = await self.db.fetchall("SELECT id FROM knowledge_chunks WHERE file_id=?", (old["id"],))
                statements.extend(("DELETE FROM knowledge_chunks_fts WHERE chunk_id=?", (chunk["id"],)) for chunk in old_chunks)
                statements.append(("DELETE FROM knowledge_files WHERE id=?", (old["id"],)))
                changed += 1
            else:
                added += 1
            statements.append((
                "INSERT INTO knowledge_files(id, source_id, path, fingerprint, size_bytes, modified_at, indexed_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (file_id, source["id"], str(resolved), fingerprint, stat.st_size, stat.st_mtime, time.time()),
            ))
            for chunk_index, chunk in enumerate(chunks):
                chunk_id = uuid.uuid4().hex
                vector = embeddings[chunk_index] if chunk_index < len(embeddings) else None
                blob = np.asarray(vector, dtype=np.float32).tobytes() if vector is not None else None
                dim = len(vector) if vector is not None else None
                statements.append((
                    "INSERT INTO knowledge_chunks(id, knowledge_base_id, file_id, source_path, content, page, line_start, line_end, chunk_index, embedding, embedding_dim, embedding_model) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (chunk_id, source["knowledge_base_id"], file_id, str(resolved), chunk["content"], chunk.get("page"), chunk.get("line_start"), chunk.get("line_end"), chunk_index, blob, dim, embedding_settings.model),
                ))
                statements.append(("INSERT INTO knowledge_chunks_fts(chunk_id, knowledge_base_id, content) VALUES(?, ?, ?)", (chunk_id, source["knowledge_base_id"], chunk["content"])))
            await self.db.transaction(statements)
            await context.checkpoint({"completed_files": index, "total_files": len(files)})
        deleted = 0
        for path, old in existing.items():
            if path not in seen:
                await self._delete_file(old["id"]); deleted += 1
        now = time.time()
        await self.db.execute("UPDATE knowledge_sources SET fingerprint=?, status='ready', file_count=?, updated_at=? WHERE id=?", (_source_fingerprint(files), len(files), now, source["id"]))
        await self.db.execute("UPDATE knowledge_bases SET last_sync_at=?, updated_at=? WHERE id=?", (now, now, source["knowledge_base_id"]))
        self._vector_cache.pop(source["knowledge_base_id"], None)
        return {"added": added, "changed": changed, "deleted": deleted, "unchanged": unchanged, "files": len(files)}

    async def _delete_file(self, file_id: str) -> None:
        chunk_rows = await self.db.fetchall("SELECT id FROM knowledge_chunks WHERE file_id=?", (file_id,))
        for row in chunk_rows:
            await self.db.execute("DELETE FROM knowledge_chunks_fts WHERE chunk_id=?", (row["id"],))
        await self.db.execute("DELETE FROM knowledge_files WHERE id=?", (file_id,))

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        settings = EmbeddingSettings(**(await self.db.get_setting("embedding", {})))
        if not settings.base_url or not settings.model:
            raise ValueError("请先配置 OpenAI-compatible Embedding 端点和模型")
        target = settings.base_url.rstrip("/")
        if not target.endswith("/embeddings"):
            target += "/embeddings"
        key = os.getenv(settings.api_key_env, "").strip()
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        vectors: list[list[float]] = []
        for index in range(0, len(texts), 64):
            response = await self.client.post(target, headers=headers, json={"model": settings.model, "input": texts[index:index + 64]}, timeout=120)
            response.raise_for_status()
            data = sorted(response.json().get("data", []), key=lambda item: item.get("index", 0))
            vectors.extend(item["embedding"] for item in data)
        if len(vectors) != len(texts):
            raise ValueError("Embedding 端点返回数量不匹配")
        return vectors

    async def search(self, knowledge_base_ids: list[str], query: str, limit: int = 6) -> dict[str, Any]:
        started = time.perf_counter()
        ids = [value for value in dict.fromkeys(knowledge_base_ids) if value]
        if not ids or not query.strip():
            return {"results": [], "grounded": False, "latency_ms": 0}
        lexical = await self._lexical(ids, query, max(limit * 4, 20))
        vector = await self._vector(ids, query, max(limit * 4, 20))
        ranks: dict[str, float] = {}
        records: dict[str, dict[str, Any]] = {}
        for result_set in (lexical, vector):
            for rank, item in enumerate(result_set, 1):
                ranks[item["id"]] = ranks.get(item["id"], 0) + 1 / (60 + rank)
                records[item["id"]] = item
        results = []
        for chunk_id, score in sorted(ranks.items(), key=lambda item: item[1], reverse=True)[:limit]:
            item = {**records[chunk_id], "score": round(score, 6)}
            confidence = _evidence_confidence(query, item)
            if confidence < .25:
                continue
            item["confidence"] = round(confidence, 4)
            results.append(item)
        latency = (time.perf_counter() - started) * 1000
        return {"results": results, "grounded": bool(results), "latency_ms": round(latency, 2)}

    async def _lexical(self, ids: list[str], query: str, limit: int) -> list[dict[str, Any]]:
        terms = [term for term in re.findall(r"[\w\u4e00-\u9fff]+", query) if term]
        if not terms:
            return []
        match = " OR ".join(f'"{term.replace(chr(34), "")}"' for term in terms[:12])
        placeholders = ",".join("?" for _ in ids)
        sql = f"""SELECT c.id, c.content, c.source_path, c.page, c.line_start, c.line_end, bm25(knowledge_chunks_fts) AS rank
            FROM knowledge_chunks_fts JOIN knowledge_chunks c ON c.id=knowledge_chunks_fts.chunk_id
            WHERE knowledge_chunks_fts MATCH ? AND c.knowledge_base_id IN ({placeholders}) ORDER BY rank LIMIT ?"""
        try:
            return await self.db.fetchall(sql, (match, *ids, limit))
        except Exception:
            return []

    async def _vector(self, ids: list[str], query: str, limit: int) -> list[dict[str, Any]]:
        try:
            query_vector = np.asarray((await self.embed([query]))[0], dtype=np.float32)
        except Exception:
            return []
        results: list[dict[str, Any]] = []
        for knowledge_base_id in ids:
            chunk_ids, matrix, metadata = await self._load_vectors(knowledge_base_id)
            if matrix.size == 0 or matrix.shape[1] != query_vector.shape[0]:
                continue
            q = query_vector / max(float(np.linalg.norm(query_vector)), 1e-8)
            scores = matrix @ q
            top = np.argsort(scores)[::-1][:limit]
            for index in top:
                if float(scores[index]) < .2:
                    continue
                results.append({**metadata[int(index)], "id": chunk_ids[int(index)], "vector_score": float(scores[index])})
        return sorted(results, key=lambda item: item["vector_score"], reverse=True)[:limit]

    async def _load_vectors(self, knowledge_base_id: str) -> tuple[list[str], np.ndarray, list[dict[str, Any]]]:
        cached = self._vector_cache.get(knowledge_base_id)
        if cached:
            return cached
        rows = await self.db.fetchall("SELECT id, content, source_path, page, line_start, line_end, embedding, embedding_dim FROM knowledge_chunks WHERE knowledge_base_id=? AND embedding IS NOT NULL", (knowledge_base_id,))
        vectors, ids, metadata = [], [], []
        for row in rows:
            vector = np.frombuffer(row.pop("embedding"), dtype=np.float32)
            if not vector.size:
                continue
            vector = vector / max(float(np.linalg.norm(vector)), 1e-8)
            vectors.append(vector); ids.append(row["id"]); metadata.append({key: row[key] for key in ("content", "source_path", "page", "line_start", "line_end")})
        matrix = np.vstack(vectors) if vectors else np.empty((0, 0), dtype=np.float32)
        cached = (ids, matrix, metadata)
        self._vector_cache[knowledge_base_id] = cached
        while len(self._vector_cache) > 3:
            self._vector_cache.pop(next(iter(self._vector_cache)))
        return cached


def _discover_files(root: Path, kind: str) -> list[Path]:
    candidates = [root] if kind == "file" else list(root.rglob("*"))
    return sorted(path for path in candidates if path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_FILE_BYTES and (path.suffix.lower() in TEXT_EXTENSIONS or path.suffix.lower() == ".pdf"))


def _fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _source_fingerprint(files: list[Path]) -> str:
    value = "\n".join(f"{path}:{path.stat().st_size}:{path.stat().st_mtime_ns}" for path in files)
    return hashlib.sha256(value.encode()).hexdigest()


def _parse_and_chunk(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".pdf":
        chunks: list[dict[str, Any]] = []
        reader = PdfReader(str(path))
        for page_number, page in enumerate(reader.pages, 1):
            text = page.extract_text() or ""
            chunks.extend(_chunk_text(text, page=page_number))
        return chunks
    raw = path.read_bytes()
    text = ""
    for encoding in ("utf-8", "utf-16", "gb18030"):
        try:
            text = raw.decode(encoding); break
        except UnicodeDecodeError:
            continue
    return _chunk_text(text)


def _chunk_text(text: str, page: int | None = None, size: int = 1200, overlap: int = 150) -> list[dict[str, Any]]:
    text = text.replace("\x00", "").strip()
    if not text:
        return []
    chunks, start = [], 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            boundary = max(text.rfind("\n", start, end), text.rfind("。", start, end), text.rfind(". ", start, end))
            if boundary > start + size // 2:
                end = boundary + 1
        content = text[start:end].strip()
        if content:
            chunks.append({"content": content, "page": page, "line_start": text.count("\n", 0, start) + 1, "line_end": text.count("\n", 0, end) + 1})
        if end >= len(text):
            break
        start = max(start + 1, end - overlap)
    return chunks


def _evidence_confidence(query: str, item: dict[str, Any]) -> float:
    terms = [term.lower() for term in re.findall(r"[\w\u4e00-\u9fff]+", query) if len(term.strip()) >= 2]
    content = str(item.get("content") or "").lower()
    lexical = sum(term in content for term in terms) / max(1, len(terms))
    return max(float(item.get("vector_score") or 0), lexical)
