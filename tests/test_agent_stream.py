"""Controlled provider streams; no external models or paid API calls."""
import copy
import json
import unittest
from unittest.mock import patch
import httpx
from backend.atelier import providers
from backend.models import AppConfig
from backend.provider_manager import ProviderConfig


class ByteStream(httpx.AsyncByteStream):
    def __init__(self, content): self.content=content.encode('utf-8')
    async def __aiter__(self):
        for byte in self.content: yield bytes([byte])


class ProviderStreams(unittest.IsolatedAsyncioTestCase):
    async def collect(self, content, kind='openai_chat', status=200, **kwargs):
        client_factory=httpx.AsyncClient
        transport=httpx.MockTransport(lambda request:httpx.Response(status,stream=ByteStream(content)))
        with patch.object(providers,'build_request',return_value=('https://fixture.test/v1',{},kind,{'model':'fixture'})),patch.object(providers.httpx,'AsyncClient',side_effect=lambda **kw:client_factory(transport=transport,**kw)):
            return [event async for event in providers.stream([{'role':'user','content':'fixture'}],**kwargs)]

    async def test_chat_chinese_and_fragmented_tool_arguments(self):
        values=[{'choices':[{'delta':{'content':'画面'}}]}, {'choices':[{'delta':{'tool_calls':[{'index':0,'id':'call-1','function':{'name':'read_page','arguments':'{"页'}}]}}]}, {'choices':[{'delta':{'tool_calls':[{'index':0,'function':{'arguments':'":"一"}'}}]}}]}, {'choices':[{'delta':{},'finish_reason':'tool_calls'}]}]
        events=await self.collect(''.join('data:'+json.dumps(v,ensure_ascii=False)+'\r\n\r\n' for v in values)+'data: [DONE]\r\n\r\n')
        self.assertIn(('text','画面'),events)
        self.assertEqual(events[-1][1]['tool_calls'][0],{'id':'call-1','name':'read_page','arguments':'{"页":"一"}'})
        self.assertIn(('tool_delta',{'name':'read_page'}),events)

    async def test_empty_and_truncated_streams_do_not_pass(self):
        for content in ['', 'data: [DONE]\n\n','data: {"choices":[{"delta":{"content":"半段"}}]}\n\n']:
            with self.assertRaises(providers.StreamError): await self.collect(content)

    async def test_anthropic_and_responses_complete_tool_events(self):
        events=await self.collect('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"ping"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\ndata: {"type":"message_stop"}\n\n',kind='anthropic')
        self.assertEqual(events[-1][1]['tool_calls'][0]['arguments'],'{}')
        events=await self.collect('data: {"type":"response.output_text.delta","delta":"完成"}\n\ndata: {"type":"response.completed"}\n\n',kind='openai_responses')
        self.assertEqual(events[-1][1]['content'],'完成')

    async def test_tool_rejection_uses_one_common_error(self):
        with self.assertRaises(providers.ToolsUnsupported): await self.collect('function calling unsupported',status=400,tools=[{}])


class ProviderSnapshots(unittest.TestCase):
    def test_connection_model_and_config_remain_frozen_across_rounds(self):
        original=ProviderConfig(id='fixture',kind='openai_chat',name='fixture',base_url='http://127.0.0.1:12345/v1',default_model='one',models=['one'])
        settings={'provider_id':'fixture','model':'one'}
        with patch.object(providers,'load_settings',side_effect=lambda:copy.deepcopy(settings)),patch.object(providers.provider_manager,'get_provider',return_value=original),patch.object(providers.config_manager,'get_config',return_value=AppConfig()),patch.object(providers,'_provider_headers',return_value={}):
            with providers.frozen_request():
                original.base_url='http://127.0.0.1:54321/v1';settings['model']='two'
                target,_,_,payload=providers.build_request([{'role':'user','content':'fixture'}],temperature=0)
                self.assertEqual(target,'http://127.0.0.1:12345/v1/chat/completions')
                self.assertEqual(payload['model'],'one')
                self.assertEqual(payload['temperature'],0)

    def test_native_parameters_keep_zero_and_output_limit(self):
        for kind in ['anthropic','openai_responses']:
            provider=ProviderConfig(id='fixture',kind=kind,name='fixture',base_url='http://127.0.0.1:12345/v1',default_model='one')
            with patch.object(providers,'load_settings',return_value={'provider_id':'fixture'}),patch.object(providers.provider_manager,'get_provider',return_value=provider),patch.object(providers,'_provider_headers',return_value={}):
                *_,payload=providers.build_request([{'role':'user','content':'fixture'}],temperature=0,top_p=.8,max_tokens=123)
            self.assertEqual(payload['temperature'],0)
            self.assertEqual(payload['top_p'],.8)
            self.assertEqual(payload['max_tokens' if kind=='anthropic' else 'max_output_tokens'],123)
