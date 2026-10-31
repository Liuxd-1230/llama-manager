from __future__ import annotations

"""Legacy MOSS compile entry; the unified creation service owns the logic."""
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/moss")


# ---------- 编译 ----------
class CompileBody(BaseModel):
    draft: dict
    view: Optional[dict] = None


@router.post("/compile")
async def api_compile(body: CompileBody):
    from ...atelier.creation import compile_document
    kind='layout' if 'items' in body.draft else 'caption'
    return await compile_document({'kind':kind,kind:body.draft},'moss',view=body.view)


# ---------- 设置 ----------
