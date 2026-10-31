from __future__ import annotations


from fastapi import HTTPException


def _404(what: str = "记录") -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what}不存在")
