from __future__ import annotations

"""Provider/model settings routes and connection probes."""
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import bridge, config
from ...inference import _provider_headers
from ..config import public_settings, SETTINGS_DEFAULTS

router = APIRouter(prefix="/api/v1/moss")


class SettingsBody(BaseModel):
    provider_id: Optional[str] = None
    model: Optional[str] = None
    vision_model: Optional[str] = None
    fallback_models: Optional[str] = None
    temperature: Optional[float] = None
    agent_protocol: Optional[str] = None
    context_turns: Optional[int] = None
    prompt_prefix: Optional[str] = None
    negative_prompt: Optional[str] = None


class ProbeBody(BaseModel):
    provider_id: Optional[str] = None
    model: Optional[str] = None


@router.get("/settings")
def get_settings():
    return public_settings(config.load_settings())


@router.put("/settings")
def put_settings(body: SettingsBody):
    s = config.load_settings()
    data = body.model_dump(exclude_none=True)
    s.update({k: v for k, v in data.items() if k in SETTINGS_DEFAULTS})
    return public_settings(config.save_settings(s))


def _resolve_creds(body: Optional[ProbeBody] = None) -> tuple[str, str]:
    s = config.load_settings()
    provider_id = (body.provider_id if body is not None and body.provider_id else None) or s.get("provider_id")
    try:
        resolved = bridge.resolve(provider_id)
    except bridge.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    from ...provider_manager import requires_api_key
    if not resolved["api_key"] and getattr(resolved["provider"], "kind", "") != "local" and requires_api_key(resolved["provider"]):
        raise HTTPException(status_code=400, detail=f"提供商 {resolved['provider'].name} 未配置密钥：请在系统设置中设置对应的环境变量。")
    return resolved["base_url"], resolved["api_key"]


def _auth_headers(key: str) -> dict[str, str]:
    # The local engine needs no key; an empty "Bearer " header makes
    # llama-server reject the request, so omit it entirely when unset.
    return {"Authorization": f"Bearer {key}"} if key else {}


async def _list_models(client: httpx.AsyncClient, base: str, key: str, headers: dict | None = None) -> list[str]:
    r = await client.get(f"{base}/models", headers=headers if headers is not None else _auth_headers(key))
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"GET /models 失败 {r.status_code}: {r.text[:300]}")
    try:
        data = r.json()
        return sorted({m.get("id") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"解析模型列表失败: {e}") from e


@router.post("/settings/test")
async def test_settings(body: ProbeBody = ProbeBody()):
    """Use the actual Agent adapters; an empty HTTP 200 is never a passing probe."""
    from ...atelier import providers
    base, key = _resolve_creds(body)
    settings = config.load_settings()
    selected = bridge.resolve(body.provider_id or settings.get('provider_id'))
    model = body.model or settings.get('model') or selected['provider'].default_model
    started = time.perf_counter()
    out = dict(ok=False,base_url=base,models_ok=False,chat_ok=False,stream_ok=False,tools_ok=False,model_count=0,sample_models=[])
    tool = {'type':'function','function':{'name':'ping','description':'Connection test','parameters':{'type':'object','properties':{'n':{'type':'integer'}},'required':['n']}}}
    async def probe(tools):
        async for kind,value in providers.stream([{'role':'user','content':'Call ping with n=1.' if tools else 'Reply ping.'}],model=model,provider_id=selected['provider'].id,max_tokens=128,temperature=0,tools=tools):
            if kind in ('text','reasoning') and value: out['stream_ok']=True
            if kind=='done':
                out['chat_ok']=bool(value.get('content') or value.get('tool_calls'))
                out['tools_ok']=bool(value.get('tool_calls'))
                out['stream_ok']=out['stream_ok'] or out['tools_ok']
    try:
        try: await probe([tool])
        except providers.ToolsUnsupported:
            out['tools_note']='此服务拒绝函数调用，Agent 自动模式将使用标签协议'
            await probe(None)
        out['ok']=out['chat_ok'] and out['stream_ok']
        out['message']='连接正常' if out['ok'] else '服务未返回完整内容'
    except (ValueError,httpx.HTTPError) as exc: out['message']=str(exc)
    out.update(tested_model=model,latency_ms=int((time.perf_counter()-started)*1000))
    return out


@router.post("/settings/models")
async def list_upstream_models(body: ProbeBody = ProbeBody()):
    base, key = _resolve_creds(body)
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            ids = await _list_models(client, base, key, _provider_headers(bridge.resolve(body.provider_id or config.load_settings().get('provider_id'))['provider']) if (body.provider_id or config.load_settings().get('provider_id')) != 'local' else {})
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"无法连接上游: {e}") from e
    return {"base_url": base, "models": ids, "count": len(ids)}


