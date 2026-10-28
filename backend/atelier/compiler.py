"""Anima semantic compilation adapted from ImageForge's facts/policy/writer stages."""
from __future__ import annotations
import json
from . import providers, store


def plain_prompt(doc: dict) -> str:
    segments=doc.get('caption',{}).get('segments') or []
    if doc.get('kind')=='caption':
        return '\n'.join(s.get('text','').strip() for s in segments if s.get('text','').strip()) if segments else doc.get('caption',{}).get('caption','').strip()
    layout=doc.get('layout',{})
    lines=[layout.get('summary',{}).get('caption','')]
    for item in layout.get('items',[]):
        if not item.get('hidden'):
            text=item.get('caption','')
            if item.get('shape') not in (None,'rectangle'):
                text += f" ({item['shape']} shaped region)"
            lines.append(text)
    return '\n'.join(t.strip() for t in lines if t.strip())


async def compile_anima(doc: dict, asset_ids: list[str], safety: str = 'safe', *, assets: list[dict] | None = None) -> dict:
    source=plain_prompt(doc)
    if not source:
        raise ValueError('请先写下画面要求')
    assets=assets if assets is not None else [store.get_object(identifier) for identifier in asset_ids]
    books=[{'name':a['name'],**a['data']} for a in assets if a['kind']=='character']
    # ImageForge's central invariant: explicit statements override character defaults.
    instruction='''Extract the user's stated visual facts faithfully. Return JSON only:
{"entities":[{"name":"","appearance":"","clothing":"","action":"","canonical_trigger":""}],"statements":[{"entity":"","facet":"","effect":""}],"scene":"","relations":[{"subject":"","relation":"","object":""}],"diagnostics":[]}.
Use English values. Do not invent background, expression, appearance or clothing. Keep ownership of actions and clothes explicit. Resolve referenced character books using the supplied defaults, but explicit user requirements override defaults in the same facet. Known trained characters without books use canonical_trigger only, do not invent a visual description. If identity or relation is ambiguous, put a question in diagnostics. Facet and effect statements must remain assigned to their entity.'''
    raw=await providers.complete([{'role':'system','content':instruction},{'role':'user','content':json.dumps({'request':source,'character_books':books},ensure_ascii=False)}],temperature=.2)
    from ..moss_server.llm import extract_json
    facts=extract_json(raw.get('content') or '')
    if not isinstance(facts.get('entities'),list) or not isinstance(facts.get('statements'),list):
        raise ValueError('语义解析没有返回有效人物与陈述，请重试或手动编辑提示词')
    diagnostics=[str(x) for x in facts.get('diagnostics',[])]
    tags=['masterpiece','best quality',safety]
    prose=[]
    for entity in facts['entities']:
        trigger=entity.get('canonical_trigger')
        if trigger: tags.append(str(trigger))
        parts=[str(entity[k]) for k in ('appearance','clothing','action') if entity.get(k)]
        if parts: prose.append(str(entity.get('name') or 'Subject')+': '+', '.join(parts)+'.')
    for statement in facts['statements']:
        if statement.get('effect'):
            prose.append(f"{statement.get('entity') or 'Scene'}: {statement['effect']}.")
    if facts.get('scene'): prose.append(str(facts['scene']))
    for relation in facts.get('relations',[]):
        if isinstance(relation,str):
            if relation.strip(): prose.append(relation.strip())
        elif isinstance(relation,dict):
            parts=[relation.get('subject') or relation.get('from'),relation.get('relation') or relation.get('type'),relation.get('object') or relation.get('to')]
            if all(isinstance(part,str) and part.strip() for part in parts):
                prose.append(' '.join(part.strip() for part in parts)+'.')
            else: diagnostics.append('人物或物体关系不完整，请核对原稿后重新编译')
    loras=[]
    for asset in assets:
        data=asset['data']
        if asset['kind']=='artist': tags.append('@'+str(data.get('prompt') or asset['name']).lstrip('@'))
        if asset['kind']=='lora':
            tags.extend(t.strip() for t in data.get('triggers','').split(',') if t.strip())
            loras.append({'filename':data.get('filename',asset['name']),'weight':float(data.get('weight',.8))})
    return {'prompt':', '.join(dict.fromkeys(tags))+'\n\n'+' '.join(prose),'facts':facts,'diagnostics':diagnostics,'loras':loras,'target':'anima'}
