from __future__ import annotations
import asyncio
import base64
import binascii
import io
from pathlib import Path
from fastapi import WebSocket, WebSocketDisconnect, Request
from ..responses import JSONResponse
from pypdf import PdfReader
from .. import config_manager as cfg
from ..download_manager import download_manager

from fastapi import APIRouter, HTTPException
from ..inference import _reject_remote_websocket
MAX_ATTACHMENT_CHARS = 150_000
MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024

router = APIRouter(tags=["files"])


@router.post('/api/v1/files/pick')
async def select_native_path(body: dict, request: Request):
    _check_picker_access(request)
    mode = body.get('mode', 'file')
    if mode not in ('file', 'folder'): raise ValueError('选择类型无效')
    extension = str(body.get('extension') or '')
    if extension and not __import__('re').fullmatch(r'\.[a-zA-Z0-9]+', extension): raise ValueError('扩展名无效')
    from ..native_picker import pick_path
    identifier=str(body.get('request_id') or '')
    if identifier and not __import__('re').fullmatch(r'[a-zA-Z0-9-]{1,64}',identifier): raise ValueError('选择请求标识无效')
    anchor=body.get('anchor')
    if anchor is not None:
        import math
        if not isinstance(anchor,dict) or any(not isinstance(anchor.get(key),(int,float)) or not math.isfinite(anchor[key]) or abs(anchor[key])>100000 for key in ['left','top','width','height']) or anchor['width']<=0 or anchor['height']<=0: raise ValueError('窗口位置无效')
    return {'path': await pick_path(mode, str(body.get('initial') or ''), extension,request_id=identifier,anchor=anchor)}


@router.delete('/api/v1/files/pick')
def cancel_native_path(request: Request, request_id: str = ''):
    _check_picker_access(request)
    from ..native_picker import cancel_picker
    cancel_picker(request_id)
    return {'ok': True}


def _check_picker_access(request: Request):
    from urllib.parse import urlsplit
    from ..inference import _is_local_host
    if not _is_local_host(request.client.host if request.client else None):
        raise HTTPException(status_code=403, detail='系统窗口仅允许本机使用')
    origin = request.headers.get('origin')
    if origin and urlsplit(origin).netloc != request.url.netloc:
        raise HTTPException(status_code=403, detail='系统窗口只允许应用自身打开')

def _allowed_browse_roots() -> list[Path]:
    """Directories a non-local caller may browse: trees that already matter to
    the configured app (the parent of each configured model/engine/template
    path, plus the data dir). Local callers browse the whole machine."""
    from pathlib import Path
    from ..paths import APP_DATA_DIR

    config = cfg.get_config()
    roots: dict[str, Path] = {str(APP_DATA_DIR): APP_DATA_DIR}
    for value in (config.model_path, config.mmproj_path, config.chat_template_file, config.llama_cpp_dir):
        value = str(value or '').strip()
        if not value:
            continue
        path = Path(value)
        base = path.parent if path.suffix else path
        roots[str(base)] = base
    return list(roots.values())


def _browse_guard(request: Request, target: Path) -> None:
    from ..inference import _is_local_host

    if _is_local_host(request.client.host if request.client else None):
        return
    # Resolve both sides: runner workspaces can sit behind reparse points, and
    # an unresolved root never matches a resolved browse target.
    roots = [root.resolve() for root in _allowed_browse_roots()]
    if not any(target == root or root in target.parents for root in roots):
        raise HTTPException(status_code=403, detail='远程访问只允许浏览已配置的模型、引擎与数据目录')


@router.get("/api/v1/drives")
def list_drives(request: Request):
    """List available drives (Windows) or ['/'] (Linux).

    A non-local caller only sees the drives hosting configured roots —
    with remote API enabled this endpoint must not double as a disk map.
    """
    from ..inference import _is_local_host

    if _is_local_host(request.client.host if request.client else None):
        return {"drives": cfg.list_drives()}
    drives = sorted({root.drive + '\\' for root in _allowed_browse_roots() if root.drive} or {'/'})
    return {"drives": drives}


@router.get("/api/v1/browse")
def browse_dir(request: Request, dir: str):
    """Browse directory contents for folder picker."""
    from pathlib import Path
    target=Path(dir).expanduser()
    if target.is_file(): target=target.parent
    if not target.is_dir(): raise ValueError('目录不存在，请检查路径或返回上一级')
    _browse_guard(request, target.resolve())
    try:
        next(target.iterdir(), None)
    except PermissionError: raise ValueError('没有权限读取此目录，请选择其他目录') from None
    return {"entries": cfg.browse_directory(str(target)), "current": str(target.resolve())}


@router.post("/api/v1/download/start")
async def download_start(body: dict):
    target_dir = body.get("target_dir", "")
    if not target_dir:
        return JSONResponse(status_code=400, content={"error": "target_dir required"})
    try:
        await download_manager.start_download(target_dir)
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@router.post("/api/v1/download/stop")
async def download_stop():
    await download_manager.stop()
    return {"ok": True}


@router.get("/api/v1/download/status")
def download_status():
    return {"is_downloading": download_manager.is_downloading(), "logs": download_manager.get_logs()}


@router.websocket("/ws/download")
async def ws_download(websocket: WebSocket):
    if await _reject_remote_websocket(websocket):
        return
    await websocket.accept()
    q = download_manager.subscribe()
    try:
        for line in download_manager.get_logs():
            await websocket.send_text(line)
        while True:
            text = await q.get()
            await websocket.send_text(text)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        download_manager.unsubscribe(q)


@router.post("/api/v1/attachments/extract")
async def extract_attachment(request: Request):
    """Extract text from an uploaded chat attachment (PDF via pypdf, else UTF-8)."""
    body = await request.json()
    name = str(body.get("name") or "attachment")
    data_base64 = str(body.get("data_base64") or "")
    try:
        raw = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError):
        return JSONResponse(status_code=400, content={"error": "附件数据不是有效的 base64"})
    if len(raw) > MAX_ATTACHMENT_BYTES:
        return JSONResponse(status_code=413, content={"error": f"文件超过 {MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB 上限"})
    def _extract_sync() -> str:
        if name.lower().endswith(".pdf"):
            reader = PdfReader(io.BytesIO(raw))
            return "\n\n".join((page.extract_text() or "") for page in reader.pages)
        return raw.decode("utf-8", errors="replace")

    try:
        # pypdf is CPU-bound; keep it off the event loop so long PDFs do not
        # freeze websocket pushes and unrelated requests.
        text = await asyncio.to_thread(_extract_sync)
    except Exception as exc:
        return JSONResponse(status_code=422, content={"error": f"解析失败: {exc}"})
    truncated = len(text) > MAX_ATTACHMENT_CHARS
    if truncated:
        text = text[:MAX_ATTACHMENT_CHARS] + "\n\n…[内容已截断]"
    return {"name": name, "size": len(raw), "chars": len(text), "truncated": truncated, "content": text}


@router.get("/api/v1/scan-models")
def scan_models(dir: str):
    models = cfg.scan_models(dir)
    return {"models": [m.model_dump() for m in models]}


@router.get("/api/v1/model-info")
def model_info(path: str):
    """Size + metadata for one model file — feeds the live VRAM/RAM estimator."""
    from pathlib import Path as _Path
    model_path = _Path(path) if path else None
    size_mb = round(model_path.stat().st_size / (1024 * 1024), 1) if model_path and model_path.is_file() else 0
    return {"size_mb": size_mb, "meta": cfg.read_model_metadata(path)}


@router.get("/api/v1/detect-server")
def detect_server(llama_cpp_dir: str, engine: str = "llama.cpp"):
    resolved = cfg.resolve_engine_dir(llama_cpp_dir, engine)
    if engine == "kvmem":
        path = cfg.detect_kvmem_binary(resolved)
    elif engine == "ninfer":
        path = cfg.detect_ninfer_binary(resolved)
    else:
        path = cfg.detect_server_binary(resolved)
    return {
        "path": path,
        "found": bool(path),
        "dir": resolved,
        "bundled": not (llama_cpp_dir or "").strip(),
        # Lets the form grey out parameters this build predates instead of
        # letting the launch die on "unknown flag".
        "lrfu": "--kvmem-lrfu" in cfg.binary_flags(path) if path else False,
    }
