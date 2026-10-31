from __future__ import annotations

"""Archive routes: saved prompts and documents."""
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from .. import db

router = APIRouter(prefix="/api/v1/moss")


# ---------- 档案库 ----------
class ArchiveBody(BaseModel):
    title: str = "未命名"
    category: str = ""
    doc: dict
    prompt: str = ""


class ArchivePatch(BaseModel):
    title: Optional[str] = None
    category: Optional[str] = None


@router.get("/archive")
def list_archive():
    return db.list_archive()


@router.post("/archive")
def add_archive(body: ArchiveBody):
    return db.add_archive(body.title, body.category, body.doc, body.prompt)


@router.patch("/archive/{aid}")
def patch_archive(aid: str, body: ArchivePatch):
    db.update_archive(aid, body.title, body.category)
    return db.get_archive(aid)


@router.delete("/archive/{aid}")
def remove_archive(aid: str):
    db.delete_archive(aid)
    return {"ok": True}


