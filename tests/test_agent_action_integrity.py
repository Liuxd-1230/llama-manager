import json,tempfile,unittest
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch,AsyncMock
from backend.moss_server import agent,db,config

class AgentActionIntegrity(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.stack=ExitStack()
        self.stack.enter_context(patch.object(db,'DB_PATH',Path(self.temp.name)/'test.db'))
        self.stack.enter_context(patch.object(db,'LEGACY_HISTORY_PATH',Path(self.temp.name)/'absent.json'))
        self.stack.enter_context(patch('backend.atelier.providers.request_settings',return_value={**config.SETTINGS_DEFAULTS,'provider_id':'local','agent_protocol':'tools'}))
        self.stack.enter_context(patch('backend.moss_server.bridge.resolve',return_value={}))
        self.stack.enter_context(patch.object(agent,'_skills_block',return_value=''))
        self.stack.enter_context(patch.object(agent,'compile_checks',return_value=[]))
        self.stack.enter_context(patch.object(agent,'maybe_summarize',new=AsyncMock()))
        self.stack.enter_context(patch('backend.atelier.mcp.tool_schemas',new=AsyncMock(return_value=[])))
        db.init();s=db.create_series('fixture');self.page=db.create_page(s['id'],'fixture');self.session=db.create_session(s['id'])
    async def asyncTearDown(self):
        self.stack.close();self.temp.cleanup()
    async def collect(self,replies):
        count=0
        async def stream(*args,**kwargs):
            nonlocal count
            reply=replies[min(count,len(replies)-1)];count+=1
            if reply.get('content'):yield 'text',reply['content']
            yield 'done',reply
        with patch.object(agent.llm,'stream_chat',side_effect=stream):
            frames=[f async for f in agent.run_agent(session_id=self.session['id'],page_id=self.page['id'],doc=self.page['doc'],view=None,message='把整体光线改成柔和晨光。',selection=[],skill_ids=[],attachments=[],replace_from_seq=None,quick=None)]
        events=[json.loads(f.split('data: ',1)[1]) for f in frames]
        return count,events,events[-1]['message']
    async def test_fake_execution_ledger_is_repaired_with_real_tools(self):
        count,events,message=await self.collect([
            {'content':'已更新。\n[执行的操作] update_summary(caption="Soft morning light.")→成功\n[改动「fixture」：用户已采纳]'},
            {'content':'','tool_calls':[{'id':'fix','name':'update_summary','arguments':'{"caption":"Soft morning light."}'}]},
            {'content':'已提交晨光描述，请确认。'}])
        self.assertGreater(count,1)
        self.assertEqual(message['meta']['steps'][0]['name'],'update_summary')
        self.assertEqual(message['meta']['proposals'][0]['proposed']['layout']['summary']['caption'],'Soft morning light.')
        self.assertNotIn('[执行的操作]',message['content'])
        self.assertIn('text_reset',[e['type'] for e in events])
    async def test_repeated_fake_success_cannot_be_saved_as_success(self):
        count,events,message=await self.collect([{'content':'[执行的操作] update_summary()→成功\n[改动「fixture」：用户已采纳]'}])
        self.assertEqual(count,2)
        self.assertTrue(message['meta']['error'])
        self.assertEqual(message['meta']['proposals'],[])
        self.assertNotIn('用户已采纳',message['content'])
    async def test_discussion_does_not_retry_or_edit(self):
        count,events,message=await self.collect([{'content':'可以用侧窗的柔和光线，形成安静的氛围。'}])
        self.assertEqual(count,1);self.assertFalse(message['meta']['error']);self.assertFalse(message['meta']['proposals'])

    def test_unsupported_history_cannot_impersonate_applied_operations(self):
        text=agent._turn_text({'role':'assistant','content':'[执行的操作] update_summary()→成功\n[改动「fixture」：用户已采纳]','meta':{'steps':[],'proposals':[]}})
        self.assertNotIn('用户已采纳',text)
        self.assertIn('没有实际工具',text)

    def test_old_fake_success_is_flagged_without_rewriting_history(self):
        from backend.moss_server.api import session_messages
        message=db.add_message(self.session['id'],'assistant','[执行的操作] update_summary()→成功',{'steps':[],'proposals':[]})
        exposed=session_messages(self.session['id'])[-1]
        self.assertIn('画面未更新',exposed['meta']['error'])
        self.assertFalse(db.get_message(message['id'])['meta'].get('error'))
