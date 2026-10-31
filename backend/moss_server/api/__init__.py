"""HTTP 接口：工作区（系列/分页/版本）、Agent 会话、档案库、编译、设置、反推。

Route groups live in routes/ modules; this package only aggregates the
router and re-exports names that other code and tests import from here.
"""
from fastapi import APIRouter

from ..routes import archive, compile, comfy, reverse, sessions, settings, workspace

router = APIRouter()
for _module in (workspace, sessions, archive, compile, comfy, settings, reverse):
    router.include_router(_module.router)

from ..routes.sessions import session_messages  # noqa: E402,F401  (compat re-export)

__all__ = ["router", "session_messages"]
