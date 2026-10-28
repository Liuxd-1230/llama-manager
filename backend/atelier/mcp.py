"""MCP clients are scoped to each call; stdio children close with their session."""
from __future__ import annotations
from contextlib import asynccontextmanager
import asyncio
import json
import hashlib
from . import store


@asynccontextmanager
async def session(config: dict):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamable_http_client
    if config.get('transport')=='stdio':
        if not config.get('command'):
            raise ValueError('请填写 MCP 启动命令')
        transport = stdio_client(StdioServerParameters(command=config['command'],args=config.get('args',[])))
    else:
        url=config.get('url','')
        if not url.startswith(('http://','https://')):
            raise ValueError('MCP HTTP 地址无效')
        transport=streamable_http_client(url)
    async with transport as streams:
        async with ClientSession(streams[0],streams[1]) as client:
            await client.initialize()
            yield client


async def discover(identifier: str):
    config=store.get_object(identifier)['data']
    async with asyncio.timeout(20), session(config) as client:
        tools=await client.list_tools()
        return [tool.model_dump(by_alias=True) for tool in tools.tools]


async def tool_schemas():
    result=[]
    for item in store.objects('mcp'):
        if not item['data'].get('enabled'):
            continue
        for tool in item['data'].get('tools',[]):
            if tool['name'] not in item['data'].get('enabled_tools',[]): continue
            result.append({'type':'function','function':{'name':f"mcp_{item['id'][:12]}_{hashlib.sha256(tool['name'].encode()).hexdigest()[:12]}",'description':tool.get('description',''),'parameters':tool.get('inputSchema',{'type':'object','properties':{}})}})
    return result


async def call(name: str, args: dict):
    for item in store.objects('mcp'):
        prefix=f"mcp_{item['id'][:12]}_"
        if name.startswith(prefix):
            config=item['data']
            tool=next((t['name'] for t in item['data'].get('tools',[]) if hashlib.sha256(t['name'].encode()).hexdigest()[:12]==name[len(prefix):]),'')
            if not config.get('enabled') or tool not in config.get('enabled_tools',[]) or tool not in {t['name'] for t in config.get('tools',[])}:
                raise ValueError('MCP 工具未启用')
            task=store.create_job('mcp',f"{item['name']} · {tool}",{'tool':tool})
            try:
                async with asyncio.timeout(60),session(config) as client:
                    result=await client.call_tool(tool,args)
                    data=result.model_dump(mode='json')
                    store.update_job(task['id'],status='failed' if result.is_error else 'succeeded',result=data)
                    return json.dumps(data,ensure_ascii=False)
            except Exception as exc:
                store.update_job(task['id'],status='failed',error=type(exc).__name__)
                raise
    raise KeyError('MCP 工具不存在')


async def shutdown():
    pass  # Each transport is closed by its owning call, including cancellation.
