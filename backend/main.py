"""Atelier application lifecycle and transport boundaries."""
from contextlib import asynccontextmanager
from pathlib import Path
import logging
import uuid
import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from .storage import database
from .version import APP_VERSION
from . import config_manager as cfg
from .moss_server import db as studio_db
from .moss_server.api import router as studio_router
from .moss_server.skills import router as skills_router, load_skills
from .routers import models, runtime, maintenance, chat, files, conversations
from .inference import _is_local_host, _remote_api_enabled
from .responses import request_id


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .secrets import configure_redaction
    configure_redaction()
    await database.initialize()
    studio_db.init()
    load_skills()
    from .atelier.store import initialize, import_dictionary
    from .atelier.downloads import downloads
    initialize()
    await __import__("asyncio").to_thread(import_dictionary)
    await downloads.initialize()
    cfg.load_config(cfg.initial_profile_name())
    app.state.db = database
    async with httpx.AsyncClient(follow_redirects=False) as client:
        app.state.http_client = client
        yield
    await downloads.close()
    from .atelier.jobs import close
    await close()
    from .atelier.generation import tasks
    for task in list(tasks.values()): task.cancel()
    if tasks: await __import__("asyncio").gather(*list(tasks.values()),return_exceptions=True)
    from .atelier.mcp import shutdown
    await shutdown()


app = FastAPI(title='Atelier', version=APP_VERSION, lifespan=lifespan)


@app.middleware('http')
async def local_api(request: Request, call_next):
    request.state.request_id = uuid.uuid4().hex
    if request.url.path.startswith('/api/') and not _remote_api_enabled() and not _is_local_host(request.client.host if request.client else None):
        return JSONResponse(status_code=403, content={'code': 'remote_api_disabled', 'message': '仅允许本机访问 API', 'request_id': request.state.request_id})
    token = request_id.set(request.state.request_id)
    try:
        response = await call_next(request)
    except Exception:
        logging.getLogger(__name__).exception('Request failed: %s',request.state.request_id)
        response = JSONResponse(status_code=500,content={'code':'internal_error','message':'处理失败，请使用请求标识检查服务日志','request_id':request.state.request_id})
    finally:
        request_id.reset(token)
    response.headers['X-Request-ID'] = request.state.request_id
    return response


async def error_response(request: Request, exc: Exception):
    status = 422 if isinstance(exc, RequestValidationError) else exc.status_code if isinstance(exc, HTTPException) else 404 if isinstance(exc, KeyError) else 400
    message = str(exc.detail) if isinstance(exc, HTTPException) else '请求参数不正确' if isinstance(exc, RequestValidationError) else str(exc).strip("'")
    return JSONResponse(status_code=status, content={'code': 'request_error', 'message': message, 'detail': message, 'request_id': getattr(request.state, 'request_id', '')})


for exception in (KeyError, ValueError, HTTPException, RequestValidationError):
    app.add_exception_handler(exception, error_response)
for router in (models.router, runtime.router, maintenance.router, chat.router, files.router, conversations.router, studio_router, skills_router):
    app.include_router(router)
from .atelier.api import router as atelier_router
app.include_router(atelier_router)

FRONTEND = Path(__file__).resolve().parents[1] / 'frontend'
if FRONTEND.exists():
    app.mount('/static', StaticFiles(directory=FRONTEND), name='static')


@app.get('/', include_in_schema=False)
def index():
    return FileResponse(FRONTEND / 'index.html')
