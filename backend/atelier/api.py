"""Atelier domain APIs: projects, assets, downloads, jobs and creative services."""
from __future__ import annotations
import asyncio
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import re
import shutil
from typing import Literal
import uuid
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from . import store, compiler, generation, mcp
from .downloads import downloads, token
from ..hf_download.core.cache_utils import build_hf_command
from ..hf_download.core.hf_client import test_mirror
from ..paths import APP_DATA_DIR
from ..secrets import write_secret

router=APIRouter(prefix='/api/v1',tags=['atelier'])
KINDS={'project','character','artist','lora','tag','notebook','preset','mcp','model','artwork'}


class ObjectWrite(BaseModel):
    name: str = Field(min_length=1,max_length=200)
    data: dict = Field(default_factory=dict)


class AssetRecord(BaseModel):
    id: str
    kind: str
    name: str
    data: dict
    updated_at: float


class JobRecord(BaseModel):
    id: str
    kind: str
    title: str
    status: str
    data: dict
    result: dict
    error: str
    updated_at: float


class GenerationRequest(BaseModel):
    workflow_id: str = ''
    positive: str = Field(default='',max_length=100000)
    negative: str = ''
    seed: int = Field(default=0,ge=0,le=2**64-1)
    width: int = Field(default=1024,ge=64,le=8192)
    height: int = Field(default=1536,ge=64,le=8192)
    steps: int = Field(default=28,ge=1,le=200)
    cfg: float = Field(default=4.5,ge=0,le=100)
    sampler: str = 'euler'
    scheduler: str = 'sgm_uniform'
    page_id: str = ''
    doc: dict = Field(default_factory=dict)
    loras: list[dict] = Field(default_factory=list)
    lora_bindings: list[dict] = Field(default_factory=list)
    source_hash: str = ''
    asset_snapshot: list[dict] = Field(default_factory=list)


class RepoRequest(BaseModel):
    input: str = Field(min_length=1,max_length=3000)
    endpoint: str = 'https://hf-mirror.com'


class DownloadRequest(BaseModel):
    repo_id: str
    revision: str = 'main'
    endpoint: str = 'https://hf-mirror.com'
    files: list[str] = Field(min_length=1,max_length=10000)
    mode: Literal['local_dir','cache'] = 'local_dir'
    directory: str
    workers: Literal[1,2,4,8] = 4


class CompileRequest(BaseModel):
    doc: dict
    target: Literal['plain','moss','anima'] = 'plain'
    asset_ids: list[str] = Field(default_factory=list)
    safety: Literal['safe','sensitive','nsfw','explicit'] = 'safe'
    view: dict | None = None


@router.get('/overview')
def overview():
    from ..moss_server import db
    projects=store.objects('project')
    with db.conn() as connection:
        for project in projects:
            recent=connection.execute('SELECT pages.name,pages.doc,pages.updated_at FROM pages JOIN series ON pages.series_id=series.id WHERE series.project_id=? ORDER BY pages.updated_at DESC LIMIT 1',(project['id'],)).fetchone()
            project['preview']={'name':recent['name'],'doc':json.loads(recent['doc']),'updated_at':recent['updated_at']} if recent else None
    return {'projects':projects,'series':db.workspace()['series'],'jobs':store.jobs(),'artworks':store.objects('artwork')[:12],'data_dir':str(APP_DATA_DIR)}


@router.get('/objects/{kind}')
def list_objects(kind: str,q: str='') -> list[AssetRecord]:
    if kind not in KINDS: raise ValueError('素材类型无效')
    return store.objects(kind,q)


@router.post('/objects/{kind}')
def create_object(kind: str,body: ObjectWrite) -> AssetRecord:
    if kind not in KINDS: raise ValueError('素材类型无效')
    validate_asset(kind, body.data)
    return store.put_object(kind,body.name,body.data)


@router.put('/objects/{kind}/{identifier}')
def update_object(kind: str,identifier: str,body: ObjectWrite) -> AssetRecord:
    if store.get_object(identifier)['kind']!=kind: raise ValueError('类型不匹配')
    validate_asset(kind, body.data)
    return store.put_object(kind,body.name,body.data,identifier)


def validate_asset(kind: str, data: dict):
    if kind != 'preset': return
    import math
    for key, upper in [('temperature',2),('top_p',1)]:
        if key not in data: continue
        try: value = float(data[key])
        except (TypeError, ValueError): raise ValueError(f'{key} 必须是数字')
        if not math.isfinite(value) or not 0 <= value <= upper: raise ValueError(f'{key} 必须在 0 到 {upper} 之间')
        data[key] = value


@router.delete('/objects/{kind}/{identifier}')
def delete_object(kind: str,identifier: str):
    if store.get_object(identifier)['kind']!=kind: raise ValueError('类型不匹配')
    with store.connection() as db: db.execute('DELETE FROM atelier_objects WHERE id=?',(identifier,))
    return {'ok':True}


@router.post('/projects/{identifier}/select')
def select_project(identifier: str):
    from ..moss_server import db
    if store.get_object(identifier)['kind']!='project': raise ValueError('项目不存在')
    db.kv_set('current_project',identifier)
    if not db.workspace()['series']:
        series=db.create_series('默认系列')
        db.create_page(series['id'],'第 1 页')
    return db.workspace()


@router.get('/dictionary/{kind}')
def dictionary(kind: Literal['tag','character'],q: str='',offset: int=0):
    with store.connection() as db:
        rows=db.execute('SELECT * FROM atelier_dictionary WHERE kind=? AND search LIKE ? ORDER BY popularity DESC LIMIT 80 OFFSET ?',(kind,'%'+q.lower()+'%',max(0,offset))).fetchall()
    return [json.loads(row['data']) for row in rows]


@router.post('/downloads/inspect')
async def inspect_repo(body: RepoRequest):
    return await downloads.inspect(body.input,body.endpoint)


@router.post('/downloads')
def submit_download(body: DownloadRequest):
    return downloads.submit(body.model_dump())


@router.post('/downloads/preview')
def download_preview(body: DownloadRequest):
    directory=Path(body.directory).expanduser()
    existing=directory
    while not existing.exists() and existing!=existing.parent: existing=existing.parent
    return {'command':build_hf_command(body.repo_id,body.revision,body.files,body.mode,body.directory,body.directory),'free_bytes':shutil.disk_usage(existing).free}


@router.post('/downloads/{identifier}/{action}')
async def download_action(identifier: str,action: str):
    result=await asyncio.to_thread(downloads.action,identifier,action)
    if 'repo_id' in result:
        await downloads.inspect(result['repo_id']+'@'+result.get('revision','main'),result['endpoint'])
        return downloads.submit(result,identifier=identifier)
    return result


@router.get('/downloads/history')
def download_history(q: str=''):
    return downloads.engine.history.query(q) if downloads.engine else []


@router.post('/downloads/mirror-test')
async def mirror_test(body: RepoRequest):
    if body.endpoint not in ('https://hf-mirror.com','https://hf-mirror.net','https://huggingface.co'): raise ValueError('镜像地址无效')
    return await asyncio.to_thread(test_mirror,body.endpoint)


@router.get('/downloads/token')
def token_status():
    return {'configured':bool(token())}


@router.put('/downloads/token')
def save_token(body: dict):
    write_secret('hf_token',str(body.get('token','')).strip())
    return token_status()


@router.post('/models/register')
def register_model(body: ObjectWrite):
    from .. import config_manager as cfg
    from ..models import AppConfig
    path=Path(body.data.get('path',''))
    if not path.is_file(): raise ValueError('模型文件不存在')
    if path.suffix.lower() not in ('.gguf','.ninfer'): raise ValueError('此格式只能登记为素材，不能创建推理档案')
    config=AppConfig(model_path=str(path),engine='ninfer' if path.suffix.lower()=='.ninfer' else 'llama.cpp')
    name=cfg._sanitize_name(body.name)
    if cfg.read_config(name): raise ValueError('同名档案已存在')
    cfg.save_config(config,name,make_current=False)
    return {'name':name,'path':str(path)}


@router.post('/loras/scan')
async def scan_loras(body: ObjectWrite):
    directory=Path(body.data.get('directory','')).expanduser()
    if not directory.is_dir(): raise ValueError('LoRA 目录不存在')
    def scan():
        imported=[]
        known={a['data'].get('path'):a for a in store.objects('lora')}
        for path in directory.rglob('*.safetensors'):
            if str(path) not in known:
                imported.append(store.put_object('lora',path.stem,{'path':str(path),'filename':path.name,'triggers':'','weight':.8}))
        return imported
    return await asyncio.to_thread(scan)


@router.post('/loras/{identifier}/metadata')
async def lora_metadata(identifier: str):
    asset=store.get_object(identifier)
    path=Path(asset['data'].get('path',''))
    if asset['kind']!='lora' or not path.is_file(): raise ValueError('LoRA 文件不存在')
    def digest():
        value=hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''): value.update(chunk)
        return value.hexdigest()
    sha=await asyncio.to_thread(digest)
    async with httpx.AsyncClient(timeout=30) as client:
        response=await client.get('https://civitai.com/api/v1/model-versions/by-hash/'+sha)
        if response.status_code==404: raise ValueError('没有找到匹配的 Civitai 元数据')
        response.raise_for_status()
        metadata=response.json()
    return store.put_object('lora',asset['name'],{**asset['data'],'remote_metadata':metadata,'sha256':sha},identifier)


@router.post('/compile')
async def compile_prompt(body: CompileRequest):
    from .creation import compile_document
    return await compile_document(body.doc,body.target,asset_ids=body.asset_ids,safety=body.safety,view=body.view)


@router.post('/text/transform')
async def transform_text(body: dict):
    from .providers import complete
    text=str(body.get('text',''))
    if not text.strip(): raise ValueError('文本为空')
    instruction='Translate faithfully into simplified Chinese. Return only the translation.' if body.get('action')=='translate' else 'Polish this image prompt in English. Preserve all facts and do not add details. Return only the edited text.'
    return {'text':(await complete([{'role':'system','content':instruction},{'role':'user','content':text}])).get('content','')}


@router.get('/jobs')
def list_jobs(kind: str | None = None,page_id: str | None = None,limit: int = 100) -> list[JobRecord]: return store.jobs(kind,page_id,limit)


@router.get('/jobs/{identifier}')
def get_job(identifier: str): return store.job(identifier)


@router.get('/jobs/{identifier}/events')
async def events(identifier: str,request: Request,after: int=0):
    record=store.job(identifier)
    try: after=max(after,int(request.headers.get('Last-Event-ID','0')))
    except ValueError: raise ValueError('事件序号无效')
    if record['kind']=='agent':
        from .jobs import stream_agent
        return StreamingResponse(stream_agent(identifier,after),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})
    async def stream():
        sequence=after
        while not await request.is_disconnected():
            with store.connection() as db:
                rows=db.execute('SELECT * FROM atelier_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT 100',(identifier,sequence)).fetchall()
            for row in rows:
                sequence=row['seq']
                yield f"id: {sequence}\ndata: {row['event']}\n\n"
            if len(rows)<100 and store.job(identifier)['status'] in ('succeeded','failed','cancelled','interrupted'): break
            if not rows: yield ': heartbeat\n\n'
            await asyncio.sleep(1)
    return StreamingResponse(stream(),media_type='text/event-stream',headers={'Cache-Control':'no-cache'})


@router.post('/generations')
async def generate(body: GenerationRequest) -> JobRecord: return generation.submit(body.model_dump())


@router.post('/generations/{identifier}/cancel')
async def cancel_generation(identifier: str): return await generation.cancel(identifier)


@router.post('/generations/{identifier}/restore')
def restore_generation(identifier: str): return generation.restore(identifier)


@router.get('/outputs/{filename}')
def output(filename: str):
    if not re.fullmatch(r'[0-9a-f]{32}-\d+\.(png|jpg|jpeg|webp|gif)',filename): raise KeyError('图片不存在')
    path=APP_DATA_DIR/'outputs'/filename
    if not path.is_file(): raise KeyError('图片不存在')
    return FileResponse(path)


@router.post('/mcp/{identifier}/test')
async def test_mcp(identifier: str):
    tools=await mcp.discover(identifier)
    asset=store.get_object(identifier)
    store.put_object('mcp',asset['name'],{**asset['data'],'tools':tools},identifier)
    return {'tools':tools}


@router.post('/jobs/{identifier}/cancel')
async def cancel_job(identifier: str):
    from .jobs import active
    record=store.job(identifier)
    if record['kind']=='generation': return await generation.cancel(identifier)
    if record['kind']=='download': return await asyncio.to_thread(downloads.action,identifier,'cancel')
    if record['status'] not in ('running','queued','paused'): raise ValueError('此任务已经结束')
    if identifier in active: active[identifier].cancel()
    return store.update_job(identifier,status='cancelled')


@router.get('/workflows/anima')
def anima_preset():
    return {'nodes': {
        '1': {'class_type':'UNETLoader','inputs':{'unet_name':'anima-2.9b.safetensors','weight_dtype':'default'}},
        '2': {'class_type':'CLIPLoader','inputs':{'clip_name':'qwen_3_06b_base.safetensors','type':'stable_diffusion','device':'default'}},
        '3': {'class_type':'VAELoader','inputs':{'vae_name':'qwen_image_vae.safetensors'}},
        '4': {'class_type':'CLIPTextEncode','inputs':{'text':'','clip':['2',0]}},
        '5': {'class_type':'CLIPTextEncode','inputs':{'text':'worst quality, low quality, watermark','clip':['2',0]}},
        '6': {'class_type':'EmptyLatentImage','inputs':{'width':1024,'height':1536,'batch_size':1}},
        '7': {'class_type':'KSampler','inputs':{'model':['1',0],'positive':['4',0],'negative':['5',0],'latent_image':['6',0],'seed':0,'steps':28,'cfg':4.5,'sampler_name':'euler','scheduler':'sgm_uniform','denoise':1}},
        '8': {'class_type':'VAEDecode','inputs':{'samples':['7',0],'vae':['3',0]}},
        '9': {'class_type':'SaveImage','inputs':{'images':['8',0],'filename_prefix':'Atelier'}}
    }}


@router.put('/providers/{identifier}/secret')
def provider_secret(identifier: str,body: dict):
    from ..provider_manager import get_provider
    if not get_provider(identifier): raise KeyError('模型服务不存在')
    write_secret('provider:'+identifier,str(body.get('key','')).strip())
    return {'ok':True}


@router.get('/vision/profiles')
def vision_profiles():
    from .. import config_manager as cfg
    return [{'name':name,'engine':profile.engine,'model_path':profile.model_path,'mmproj_path':profile.mmproj_path} for name in cfg.list_configs() if (profile:=cfg.read_config(name)) and profile.mmproj_path and profile.engine in ('llama.cpp','kvmem')]


@router.post('/vision/select')
async def select_vision_profile(body: dict):
    from .. import config_manager as cfg
    from ..process_manager import process_manager
    from fastapi import HTTPException
    name=str(body.get('name',''))
    profile=cfg.read_config(name)
    if not profile or not profile.mmproj_path or profile.engine not in ('llama.cpp','kvmem'):
        raise ValueError('请选择带有 MMProj 的视觉 GGUF 档案')
    if not Path(profile.model_path).is_file() or not Path(profile.mmproj_path).is_file():
        raise ValueError('视觉模型或 MMProj 文件不存在，请检查档案路径')
    status=process_manager.get_status()
    if status.state=='running' and status.profile!=name:
        if not body.get('confirm_switch'):
            raise HTTPException(status_code=409,detail='切换将停止当前受管引擎，请确认后重试')
        await process_manager.stop()
    if status.state!='running' or status.profile!=name:
        await process_manager.start(profile,profile_name=name)
    cfg.load_config(name)
    return process_manager.get_status().model_dump()
