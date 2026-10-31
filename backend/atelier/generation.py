"""Durable generation snapshots. Only this application's queued prompts may be cancelled."""
import asyncio
import copy
import uuid
import httpx
from ..paths import APP_DATA_DIR
from ..moss_server import comfy
from ..moss_server.config import active_workflow, load_settings, save_settings, now_iso
from . import store

tasks={}


async def run(identifier: str):
    record=store.job(identifier)
    data=record['data'];base=data['base']
    try:
        store.update_job(identifier,status='running',result={'phase':'validating','images':[]})
        prompt_id=await comfy.submit(base,data['workflow'])
        store.update_job(identifier,status='running',result={'phase':'generating','prompt_id':prompt_id,'images':[]})
        images=await comfy.wait_for_images(base,prompt_id,timeout=1800)
        if not images:
            raise ValueError('ComfyUI 未输出图片，请检查输出节点')
        store.update_job(identifier,status='running',result={'phase':'saving','prompt_id':prompt_id,'images':[]})
        paths=[]
        directory=APP_DATA_DIR/'outputs';directory.mkdir(exist_ok=True)
        for index,image in enumerate(images):
            raw,name=await comfy.fetch_image(base,image)
            suffix=__import__('pathlib').Path(name).suffix.lower()
            if suffix not in ('.png','.jpg','.jpeg','.webp','.gif'): suffix='.png'
            filename=f'{identifier}-{index}{suffix}'
            (directory/filename).write_bytes(raw)
            paths.append({'url':f'/api/v1/outputs/{filename}','filename':name})
        store.update_job(identifier,status='succeeded',result={'phase':'completed','prompt_id':prompt_id,'images':paths})
    except asyncio.CancelledError:
        store.update_job(identifier,status='cancelled')
    except Exception as exc:
        store.update_job(identifier,status='failed',error=str(exc))
    finally:
        tasks.pop(identifier,None)


def submit(data: dict):
    data=copy.deepcopy(data)
    settings=load_settings()
    workflow = (settings.get('comfy_workflows') or {}).get(data['workflow_id']) if data.get('workflow_id') else active_workflow(settings)
    if not workflow: raise ValueError('所选工作流不存在，请重新选择')
    nodes=workflow.get('nodes') or {}
    if not nodes:
        raise ValueError('请先导入并选择 ComfyUI API 工作流')
    bindings=workflow.get('bindings') or {}
    errors=[error for field,binding in bindings.items() if (error:=comfy.validate_binding(nodes,field,binding))]
    if errors: raise ValueError('；'.join(errors))
    if not bindings.get('positive'):
        raise ValueError('请为正向提示词配置工作流节点绑定')
    for field in ('positive','negative'):
        binding=bindings.get(field)
        if binding and not str(data.get(field,'')).strip():
            data[field]=nodes[str(binding['node'])]['inputs'][binding['input']]
    if not str(data.get('positive','')).strip():
        raise ValueError('请填写正向提示词或在工作流中提供默认提示词')
    if data.get('loras') and not data.get('lora_bindings'):
        raise ValueError('当前工作流尚未绑定 LoRA，请配置节点后再生成')
    rendered=comfy.apply_bindings(copy.deepcopy(nodes),bindings,data)
    for lora in data.get('lora_bindings',[]):
        node=rendered.get(str(lora.get('node')))
        if not node or node.get('class_type')!='LoraLoader': raise ValueError('LoRA 绑定节点无效')
        node['inputs'].update(lora_name=lora['filename'],strength_model=float(lora['weight']),strength_clip=float(lora['weight']))
    from .creation import document_hash, references
    source_hash=document_hash(data.get('doc',{}))
    if data.get('source_hash') and data['source_hash']!=source_hash:
        raise ValueError('编译文稿版本与生成快照不一致，请重新编译后提交')
    assets=data.get('asset_snapshot') or references(data.get('doc',{}))[0]
    snapshot={**data,'workflow':rendered,'bindings':copy.deepcopy(bindings),'base':comfy.comfy_base(settings),'workflow_name':workflow.get('name',''),'source_hash':source_hash,'asset_snapshot':assets}
    task=store.create_job('generation','生成图像',snapshot)
    tasks[task['id']]=asyncio.create_task(run(task['id']))
    return task


def restore(identifier: str):
    record=store.job(identifier)
    if record['kind']!='generation': raise ValueError('请选择生成记录')
    snapshot=copy.deepcopy(record['data'])
    nodes=snapshot.get('workflow')
    if not nodes: raise ValueError('此记录没有保存工作流快照')
    settings=load_settings();workflow_id=uuid.uuid4().hex[:10]
    settings.setdefault('comfy_workflows',{})[workflow_id]={'name':'快照 · '+snapshot.get('workflow_name','生成工作流'),'nodes':nodes,'bindings':snapshot.get('bindings') or comfy.guess_bindings(nodes),'layout':{},'created_at':now_iso()}
    settings['comfy_active']=workflow_id
    settings['comfy_params']={key:snapshot[key] for key in ('seed','width','height','cfg','steps','sampler','scheduler') if key in snapshot}
    settings['comfy_workflows'][workflow_id]['params']=copy.deepcopy(settings['comfy_params'])
    settings['comfy_url']=snapshot.get('base') or comfy.comfy_base(settings)
    save_settings(settings)
    return {'workflow_id':workflow_id,'snapshot':snapshot}


async def cancel(identifier: str):
    record=store.job(identifier)
    if record['kind']!='generation' or record['status'] not in ('queued','running'):
        raise ValueError('此任务不能取消')
    prompt=record['result'].get('prompt_id')
    base=record['data'].get('base')
    if prompt and base:
        async with httpx.AsyncClient(timeout=10) as client:
            queue=(await client.get(base+'/queue')).json()
            if any(entry[1]==prompt for entry in queue.get('queue_running',[])):
                raise ValueError('此任务正在执行；ComfyUI 中断接口会影响外部任务，请在 ComfyUI 手动停止')
            response=await client.post(base+'/queue',json={'delete':[prompt]})
            response.raise_for_status()
    if identifier in tasks: tasks[identifier].cancel()
    return store.update_job(identifier,status='cancelled')
