"""Compile one immutable document and its references into a reusable artifact."""
from __future__ import annotations
import asyncio
import copy
import hashlib
import json
from . import compiler, store


def document_hash(document: dict) -> str:
    return hashlib.sha256(json.dumps(document,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def references(document: dict, identifiers: list[str] | None = None):
    assets=[]; diagnostics=[]
    for identifier in dict.fromkeys([*document.get('asset_ids',[]),*(identifiers or [])]):
        try: assets.append(store.get_object(identifier))
        except KeyError: diagnostics.append('引用素材已被移除：'+identifier)
    return assets,diagnostics


def prompt_references(assets: list[dict]) -> list[str]:
    fragments=[]
    for asset in assets:
        data=asset['data']
        if asset['kind'] in ('tag','artist'):
            fragments.append(str(data.get('prompt') or asset['name']))
        elif asset['kind']=='lora':
            fragments.extend(str(data.get('triggers') or '').split(','))
    return list(dict.fromkeys(text.strip() for text in fragments if text.strip()))


async def compile_document(document: dict, target: str, *, asset_ids: list[str] | None = None, safety: str = 'safe', view: dict | None = None) -> dict:
    source=copy.deepcopy(document)
    assets,diagnostics=references(source,asset_ids)
    snapshot={'doc':source,'target':target,'assets':copy.deepcopy(assets),'source_hash':document_hash(source)}
    task=store.create_job('compile',{'moss':'MOSS','anima':'Anima','plain':'纯文本'}.get(target,target)+' 提示词编译',snapshot)
    store.update_job(task['id'],status='running')
    try:
        checks=[];prefix='';negative=''
        if target=='anima':
            result=await compiler.compile_anima(source,[asset['id'] for asset in assets],safety,assets=assets)
            diagnostics.extend(result.get('diagnostics',[]))
            tags=prompt_references([asset for asset in assets if asset['kind']=='tag'])
            if tags: result['prompt']+= '\n'+', '.join(tags)
        elif target in ('moss','plain'):
            fragments=prompt_references(assets)
            if target=='plain':
                result={'prompt':'\n'.join(filter(None,[compiler.plain_prompt(source),', '.join(fragments)]))}
            else:
                from ..moss_server.layout_core import sanitize_draft, compile_safe, compile_checks
                from ..moss_server.config import load_settings
                draft=copy.deepcopy(source.get('layout',{}) if source.get('kind')=='layout' else source.get('caption',{}))
                if fragments:
                    destination=draft.setdefault('summary',{}) if source.get('kind')=='layout' else draft
                    destination['caption']=' '.join(filter(None,[destination.get('caption',''),', '.join(fragments)]))
                draft=sanitize_draft(draft)
                prompt,error=await asyncio.to_thread(compile_safe,draft,view)
                if error: raise ValueError(error)
                checks=compile_checks(draft) if 'items' in draft else []
                settings=load_settings();prefix=settings.get('prompt_prefix') or '';negative=settings.get('negative_prompt') or ''
                result={'prompt':prompt}
        else: raise ValueError('提示词输出目标无效')
        result={**result,'target':target,'diagnostics':diagnostics,'checks':[*checks,*diagnostics],'prefix':prefix,'negative':negative,'source_doc':source,'source_hash':snapshot['source_hash'],'asset_snapshot':assets,'job_id':task['id']}
        store.update_job(task['id'],status='succeeded',result=result)
        return result
    except Exception as exc:
        store.update_job(task['id'],status='failed',error=str(exc))
        raise
