"""Shared request and event adapters for creative tasks across provider protocols."""
import json
import copy
import re
from contextlib import contextmanager
from contextvars import ContextVar
import httpx
from .. import config_manager, provider_manager
from ..inference import _external_chat_request, _provider_headers, _local_base_url, _local_chat_payload, _normalize_non_stream_response
from ..moss_server.config import load_settings

_snapshot = ContextVar('atelier_provider_snapshot', default=None)


def request_settings():
    snapshot = _snapshot.get()
    return copy.deepcopy(snapshot['settings']) if snapshot else load_settings()


@contextmanager
def frozen_request():
    """A detached task inherits one connection/config snapshot, never persisted keys."""
    settings = load_settings()
    identifier = settings.get('provider_id') or 'local'
    provider = provider_manager.get_provider(identifier) if identifier != 'local' else None
    value = {'settings': copy.deepcopy(settings), 'provider': copy.deepcopy(provider),
             'config': config_manager.get_config().model_copy(deep=True),
             'headers': _provider_headers(provider) if provider else {}}
    token = _snapshot.set(value)
    try: yield
    finally: _snapshot.reset(token)


class StreamError(ValueError):
    def __init__(self, status: int, text: str):
        self.status = status
        self.text = text
        super().__init__(f'模型服务返回 HTTP {status}，请检查模型与连接配置' if status else text)


class ToolsUnsupported(StreamError):
    pass


def build_request(messages: list[dict], *, model: str | None = None, provider_id: str | None = None, temperature: float = .7, max_tokens: int = 8192, tools: list | None = None, top_p: float | None = None):
    settings=request_settings()
    provider_id=provider_id or settings.get('provider_id') or 'local'
    data={'model':model or settings.get('model'),'stream':False,'temperature':temperature,'max_tokens':max_tokens}
    if provider_id=='local':
        snapshot = _snapshot.get()
        config=snapshot['config'] if snapshot else config_manager.get_config()
        # NInfer model aliases must come from an explicit model selection, not a filename.
        if config.engine == 'ninfer' and (not model or model == config.model_path.replace('\\', '/').rsplit('/', 1)[-1]):
            data['model'] = ''
        target=_local_base_url(config)+'/v1/chat/completions'
        data['thinking_enabled']=config.basic.enable_thinking
        payload=_local_chat_payload(data,config,messages)
        headers={};kind='openai_chat'
    else:
        snapshot = _snapshot.get()
        provider=snapshot['provider'] if snapshot and provider_id == snapshot['settings'].get('provider_id') else provider_manager.get_provider(provider_id)
        if not provider or not provider.enabled:
            raise ValueError('模型服务不存在或未启用')
        target,payload=_external_chat_request(provider,data,messages)
        headers=snapshot['headers'] if snapshot and provider is snapshot['provider'] else _provider_headers(provider)
        kind=provider.kind
    if tools:
        if kind=='anthropic':
            payload['tools']=[{'name':t['function']['name'],'description':t['function'].get('description',''),'input_schema':t['function']['parameters']} for t in tools]
        elif kind=='openai_responses':
            payload['tools']=[{'type':'function',**t['function']} for t in tools]
        else:
            payload['tools']=tools
    if kind=='anthropic':
        converted=[]
        for message in messages:
            role=message.get('role')
            if role=='system': continue
            if role=='tool':
                converted.append({'role':'user','content':[{'type':'tool_result','tool_use_id':message['tool_call_id'],'content':message.get('content','')}]})
                continue
            content=message.get('content') or ''
            blocks=[]
            if isinstance(content,list):
                for part in content:
                    if part.get('type')=='image_url':
                        url=part['image_url']['url']
                        if url.startswith('data:'):
                            header,encoded=url.split(',',1)
                            blocks.append({'type':'image','source':{'type':'base64','media_type':header[5:].split(';')[0],'data':encoded}})
                        else: blocks.append({'type':'image','source':{'type':'url','url':url}})
                    elif part.get('type')=='text': blocks.append(part)
            elif content: blocks.append({'type':'text','text':content})
            for tool in message.get('tool_calls',[]):
                blocks.append({'type':'tool_use','id':tool['id'],'name':tool['function']['name'],'input':json.loads(tool['function'].get('arguments') or '{}')})
            if blocks: converted.append({'role':'assistant' if role=='assistant' else 'user','content':blocks})
        payload['messages']=converted
    elif kind=='openai_responses':
        converted=[]
        for message in messages:
            if message.get('role')=='tool':
                converted.append({'type':'function_call_output','call_id':message['tool_call_id'],'output':message.get('content','')})
                continue
            if message.get('content'):
                content=message['content']
                if isinstance(content,list): content=[{'type':'input_image','image_url':part['image_url']['url']} if part.get('type')=='image_url' else {'type':'input_text','text':part.get('text','')} for part in content]
                converted.append({'role':message.get('role','user'),'content':content})
            for tool in message.get('tool_calls',[]):
                converted.append({'type':'function_call','call_id':tool['id'],**tool['function']})
        payload['input']=converted
    payload['temperature'] = temperature
    payload['max_output_tokens' if kind == 'openai_responses' else 'max_tokens'] = max_tokens
    if top_p is not None: payload['top_p']=top_p
    return target,headers,kind,payload


async def complete(messages: list[dict], **kwargs):
    target,headers,kind,payload=build_request(messages,**kwargs)
    async with httpx.AsyncClient(timeout=300) as client:
        response=await client.post(target,json=payload,headers=headers)
    if response.status_code>=400:
        raise ValueError(f'模型服务返回 HTTP {response.status_code}，请检查模型与连接配置')
    raw=response.json()
    normalized=_normalize_non_stream_response(kind,raw)
    message=(normalized.get('choices') or [{}])[0].get('message') or {}
    if kind=='anthropic':
        message['tool_calls']=[{'id':b['id'],'type':'function','function':{'name':b['name'],'arguments':__import__('json').dumps(b.get('input',{}))}} for b in raw.get('content',[]) if b.get('type')=='tool_use']
    elif kind=='openai_responses':
        message['tool_calls']=[{'id':b.get('call_id',b.get('id')),'type':'function','function':{'name':b['name'],'arguments':b.get('arguments','{}')}} for b in raw.get('output',[]) if b.get('type')=='function_call']
    return message


async def stream(messages: list[dict], **kwargs):
    target,headers,kind,payload=build_request(messages,**kwargs)
    payload['stream']=True
    yield ('model',payload.get('model',''))
    content=[];calls={};finished=False;received=False
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream('POST',target,json=payload,headers=headers) as response:
            if response.status_code>=400:
                detail=(await response.aread()).decode('utf-8','replace')
                if kwargs.get('tools') and response.status_code in (400,404,422) and re.search(r'tool|function',detail,re.I):
                    raise ToolsUnsupported(response.status_code, detail)
                raise StreamError(response.status_code, detail)
            async for line in response.aiter_lines():
                if not line.startswith('data:'): continue
                raw=line[5:].strip()
                if raw=='[DONE]': finished=True;break
                try: event=json.loads(raw)
                except json.JSONDecodeError: continue
                event_kind=event.get('type','')
                if event_kind in ('error','response.failed','response.incomplete') or event.get('error'): raise StreamError(0,'模型流式输出失败或被截断')
                if event_kind in ('message_stop','response.completed'): finished=True
                text=''
                if event.get('choices'):
                    choice=event['choices'][0];delta=choice.get('delta') or {}
                    text=delta.get('content') or ''
                    if delta.get('reasoning_content') or delta.get('reasoning'):
                        received=True;yield ('reasoning',delta.get('reasoning_content') or delta['reasoning'])
                    if choice.get('finish_reason'):
                        if choice['finish_reason']=='length': raise StreamError(0,'模型达到输出上限，回复未完整结束；请提高输出限制后重试')
                        finished=True
                    for part in delta.get('tool_calls') or []:
                        call=calls.setdefault(part.get('index',0),{'id':'','name':'','arguments':''})
                        if part.get('id'): call['id']=part['id']
                        function=part.get('function') or {}
                        call['name']+=function.get('name') or ''
                        call['arguments']+=function.get('arguments') or ''
                        if function.get('name'): yield ('tool_delta',{'name':call['name']})
                elif event_kind=='content_block_start' and event.get('content_block',{}).get('type')=='tool_use':
                    block=event['content_block'];calls[event['index']]={'id':block['id'],'name':block['name'],'arguments':''}
                    if block.get('input'): calls[event['index']]['arguments']=json.dumps(block['input'],ensure_ascii=False)
                    yield ('tool_delta',{'name':block['name']})
                elif event_kind=='content_block_delta':
                    delta=event.get('delta',{})
                    if delta.get('type')=='text_delta': text=delta.get('text','')
                    elif delta.get('type')=='thinking_delta': received=True;yield ('reasoning',delta.get('thinking',''))
                    elif delta.get('type')=='input_json_delta' and event['index'] in calls: calls[event['index']]['arguments']+=delta.get('partial_json','')
                elif event_kind=='response.output_item.added' and event.get('item',{}).get('type')=='function_call':
                    item=event['item'];calls[event['output_index']]={'id':item.get('call_id') or item.get('id',''),'name':item['name'],'arguments':''}
                    yield ('tool_delta',{'name':item['name']})
                elif event_kind=='response.function_call_arguments.delta' and event['output_index'] in calls:
                    calls[event['output_index']]['arguments']+=event.get('delta','')
                elif event_kind=='response.output_text.delta': text=event.get('delta','')
                elif event_kind=='response.reasoning_summary_text.delta': received=True;yield ('reasoning',event.get('delta',''))
                if text:
                    received=True;content.append(text);yield ('text',text)
    if not finished or not (received or calls): raise StreamError(0,'模型流连接提前结束或返回空内容，未标记为成功')
    yield ('done',{'content':''.join(content),'tool_calls':list(calls.values()),'finish_reason':'stop'})
