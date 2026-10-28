"""Atelier integration tests use isolated data and deterministic external services."""
import asyncio
from contextlib import ExitStack, closing
import copy
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from backend.main import app
from backend import config_manager, secrets
from backend.models import AppConfig
from backend.paths import migrate_data
from backend.storage import Database
from backend.atelier import store, compiler, generation, mcp
from backend.atelier.downloads import safe_filename
from backend.moss_server import db as studio
from backend.moss_server.ops import Workbench, ToolError


class MigrationTests(unittest.TestCase):
    def test_migration_copies_studio_and_chat_preserving_ids_and_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);old=root/'old';target=root/'Atelier'
            (old/'moss').mkdir(parents=True)
            with closing(sqlite3.connect(old/'manager.db')) as db: db.execute('CREATE TABLE conversations(id TEXT PRIMARY KEY)');db.execute("INSERT INTO conversations VALUES('chat_original')");db.commit()
            with closing(sqlite3.connect(old/'moss'/'workspace.db')) as db: db.execute('CREATE TABLE pages(id TEXT PRIMARY KEY,doc TEXT)');db.execute('INSERT INTO pages VALUES(?,?)',('page_original','{"kind":"caption"}'));db.commit()
            (old/'moss'/'attachment.txt').write_text('preserve')
            migrate_data(old,target)
            with closing(sqlite3.connect(target/'atelier.db')) as db:
                self.assertEqual(db.execute('SELECT id FROM pages').fetchone()[0],'page_original')
                self.assertEqual(db.execute('SELECT id FROM conversations').fetchone()[0],'chat_original')
            self.assertEqual((target/'moss'/'attachment.txt').read_text(),'preserve')
            first=(target/'migration.json').read_text()
            migrate_data(old,target)
            self.assertEqual((target/'migration.json').read_text(),first)
            self.assertTrue((old/'manager.db').exists())

    def test_failed_migration_preserves_original_and_does_not_switch(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);old=root/'old';old.mkdir();target=root/'Atelier'
            (old/'manager.db').write_bytes(b'not a database')
            with self.assertRaises(RuntimeError): migrate_data(old,target)
            self.assertEqual((old/'manager.db').read_bytes(),b'not a database')
            self.assertFalse((target/'migration.json').exists())


class AtelierAPITests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.stack=ExitStack();self.path=self.root/'atelier.db'
        self.stack.enter_context(patch('backend.main.database',Database(self.path)))
        self.stack.enter_context(patch.object(store,'DATABASE_PATH',self.path))
        self.stack.enter_context(patch.object(studio,'DB_PATH',self.path))
        self.stack.enter_context(patch.object(config_manager,'CONFIG_DIR',self.root/'config'))
        (self.root/'config').mkdir()
        self.stack.enter_context(patch.object(config_manager,'_current_config',AppConfig()))
        self.stack.enter_context(patch.object(config_manager,'_current_name','default'))
        self.stack.enter_context(patch('backend.atelier.store.import_dictionary'))
        self.stack.enter_context(patch('backend.atelier.downloads.DATABASE_PATH',self.path))
        self.stack.enter_context(patch.object(secrets,'APP_DATA_DIR',self.root))
        self.client=self.stack.enter_context(TestClient(app))

    def tearDown(self):
        self.stack.close();self.temp.cleanup()

    def test_projects_isolate_series_and_create_initial_page(self):
        before=self.client.get('/api/v1/moss/workspace').json()['series']
        project=self.client.post('/api/v1/objects/project',json={'name':'新项目','data':{}}).json()
        selected=self.client.post(f"/api/v1/projects/{project['id']}/select").json()['series']
        self.assertEqual(len(selected),1)
        self.assertNotEqual(before[0]['id'],selected[0]['id'])
        restored=self.client.post('/api/v1/projects/project_default/select').json()['series']
        self.assertEqual(restored[0]['id'],before[0]['id'])

    def test_segments_and_references_round_trip(self):
        page=self.client.get('/api/v1/moss/workspace').json()['series'][0]['pages'][0]
        doc=page['doc'];doc['caption']={'caption':'a\nb','segments':[{'id':'a','name':'主体','text':'a','locked':True},{'id':'b','name':'光线','text':'b'}]};doc['asset_ids']=['ref'];doc['compile_target']='anima'
        saved=self.client.put('/api/v1/moss/pages/'+page['id'],json={'doc':doc}).json()['doc']
        self.assertEqual(saved,doc)
        next_page=studio.create_page(page['series_id'],'下一页')
        self.assertEqual(next_page['doc']['asset_ids'],['ref'])

    def test_stale_proposal_is_rejected(self):
        series=self.client.get('/api/v1/moss/workspace').json()['series'][0];page=series['pages'][0]
        session=studio.create_session(series['id'])
        base=page['doc'];changed=copy.deepcopy(base);changed['caption']['caption']='new'
        message=studio.add_message(session['id'],'assistant','proposal',{'proposals':[{'page_id':page['id'],'base':base,'proposed':changed,'status':'pending'}]})
        studio.update_page(page['id'],doc=changed)
        response=self.client.post(f"/api/v1/moss/messages/{message['id']}/proposal",json={'page_id':page['id'],'status':'accepted','expected_doc':base})
        self.assertEqual(response.status_code,409)
        self.assertEqual(studio.get_page(page['id'])['doc'],changed)

    def test_sse_replays_all_events_and_respects_cursor(self):
        task=store.create_job('test','test',{})
        for index in range(120): store.update_job(task['id'],result={'index':index})
        store.update_job(task['id'],status='succeeded')
        first=self.client.get(f"/api/v1/jobs/{task['id']}/events").text
        ids=[int(line[4:]) for line in first.splitlines() if line.startswith('id: ')]
        self.assertEqual(len(ids),122)
        second=self.client.get(f"/api/v1/jobs/{task['id']}/events",headers={'Last-Event-ID':str(ids[-2])}).text
        self.assertEqual(second.count('id: '),1)

    def test_page_generation_history_survives_the_global_recent_job_limit(self):
        original=store.create_job('generation','old result',{'page_id':'page_original'})
        for index in range(105): store.create_job('compile',str(index),{'page_id':'other'})
        self.assertNotIn(original['id'],[record['id'] for record in self.client.get('/api/v1/jobs').json()])
        scoped=self.client.get('/api/v1/jobs?kind=generation&page_id=page_original').json()
        self.assertEqual([record['id'] for record in scoped],[original['id']])

    def test_restart_marks_jobs_interrupted_without_replay(self):
        task=store.create_job('generation','pending',{})
        store.update_job(task['id'],status='running')
        store.initialize()
        self.assertEqual(store.job(task['id'])['status'],'interrupted')

    def test_asset_update_preserves_builtin_and_local_fields(self):
        asset=self.client.post('/api/v1/objects/lora',json={'name':'my LoRA','data':{'description':'local','weight':.8}}).json()
        self.assertIn('id',asset)
        self.assertEqual(self.client.get('/api/v1/objects/lora?q=my').json()[0]['data']['description'],'local')
        response=self.client.post('/api/v1/generations',json={'positive':'x','width':-1})
        self.assertEqual(response.status_code,422)
        self.assertIn('request_id',response.json())

    def test_plain_compilation_strips_labels_and_translation(self):
        doc={'kind':'caption','caption':{'segments':[{'name':'主体','text':'a girl','translation':'女孩'},{'name':'光','text':'warm light'}]}}
        result=self.client.post('/api/v1/compile',json={'doc':doc,'target':'plain'}).json()
        self.assertEqual(result['prompt'],'a girl\nwarm light')

    def test_compilation_snapshots_references_for_every_target(self):
        asset=self.client.post('/api/v1/objects/lora',json={'name':'Ink','data':{'triggers':'inkwash, hand drawn','weight':.8}}).json()
        doc={'kind':'caption','caption':{'caption':'a quiet studio'},'asset_ids':[asset['id']]}
        result=self.client.post('/api/v1/compile',json={'doc':doc,'target':'plain'}).json()
        self.assertIn('inkwash, hand drawn',result['prompt'])
        self.assertEqual(result['source_doc'],doc)
        self.assertEqual(len(result['source_hash']),64)
        self.client.put('/api/v1/objects/lora/'+asset['id'],json={'name':'changed','data':{'triggers':'changed'}})
        job=self.client.get('/api/v1/jobs/'+result['job_id']).json()
        self.assertEqual(job['data']['assets'][0]['data']['triggers'],'inkwash, hand drawn')
        moss=self.client.post('/api/v1/compile',json={'doc':doc,'target':'moss'})
        self.assertEqual(moss.status_code,200)
        self.assertIn('changed',moss.json()['prompt'])
        missing=self.client.post('/api/v1/compile',json={'doc':{'kind':'caption','caption':{'caption':'draft'},'asset_ids':['removed']},'target':'plain'}).json()
        self.assertIn('引用素材已被移除',missing['diagnostics'][0])

    def test_download_registration_keeps_active_profile(self):
        model=self.root/'downloaded.gguf';model.write_bytes(b'fixture')
        current=config_manager.get_config()
        result=self.client.post('/api/v1/models/register',json={'name':'downloaded','data':{'path':str(model)}})
        self.assertEqual(result.status_code,200)
        self.assertEqual(config_manager.get_current_name(),'default')
        self.assertIs(config_manager.get_config(),current)
        self.assertEqual(config_manager.read_config('downloaded').model_path,str(model))

    def test_route_errors_carry_request_id_and_idle_suspend_is_safe(self):
        response=self.client.post('/api/v1/chat',json={'messages':'invalid'})
        self.assertEqual(response.status_code,400)
        self.assertEqual(response.json()['request_id'],response.headers['x-request-id'])
        self.assertEqual(response.json()['code'],'request_error')
        self.assertTrue(response.json()['message'])
        from backend.routers import runtime
        with patch.object(runtime,'_suspended_profile',None):
            paused=self.client.post('/api/v1/server/suspend')
        self.assertEqual(paused.status_code,200)

    def test_unexpected_errors_use_the_same_envelope_without_internal_details(self):
        with patch.object(store,'objects',side_effect=RuntimeError('internal private detail')):
            response=self.client.get('/api/v1/objects/character')
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json()['code'],'internal_error')
        self.assertEqual(response.json()['request_id'],response.headers['x-request-id'])
        self.assertNotIn('private detail',response.text)

    def test_generation_endpoint_submits_on_application_event_loop(self):
        workflow={'nodes':{'1':{'class_type':'CLIPTextEncode','inputs':{'text':'workflow default'}}},'bindings':{'positive':{'node':'1','input':'text'}}}
        with patch.object(generation,'active_workflow',return_value=workflow),patch.object(generation,'run',new_callable=AsyncMock) as run:
            response=self.client.post('/api/v1/generations',json={'positive':'a ceramic cup'})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['kind'],'generation')
        self.assertEqual(run.call_args.args[0],response.json()['id'])
        with patch.object(generation,'active_workflow',return_value=workflow),patch.object(generation,'run',new_callable=AsyncMock):
            default=self.client.post('/api/v1/generations',json={})
        self.assertEqual(default.status_code,200)
        self.assertEqual(default.json()['data']['positive'],'workflow default')
        with patch.object(generation,'active_workflow',return_value=workflow):
            stale=self.client.post('/api/v1/generations',json={'positive':'draft','source_hash':'outdated','doc':{'kind':'caption'}})
        self.assertEqual(stale.status_code,400)
        self.assertIn('版本',stale.json()['message'])

    def test_reedit_restores_workflow_and_all_parameters_without_submitting(self):
        nodes={'1':{'class_type':'CLIPTextEncode','inputs':{'text':'saved prompt'}}}
        record=store.create_job('generation','saved',{'workflow':nodes,'workflow_name':'original','seed':42,'sampler':'euler','scheduler':'sgm_uniform','steps':2})
        with patch.object(generation,'load_settings',return_value={'comfy_workflows':{}}),patch.object(generation,'save_settings') as save,patch.object(generation,'submit') as submit:
            response=self.client.post('/api/v1/generations/'+record['id']+'/restore')
        self.assertEqual(response.status_code,200)
        settings=save.call_args.args[0]
        self.assertEqual(settings['comfy_params']['scheduler'],'sgm_uniform')
        self.assertEqual(settings['comfy_workflows'][settings['comfy_active']]['nodes'],nodes)
        submit.assert_not_called()

    def test_workflow_params_and_late_writes_are_scoped(self):
        from backend.moss_server import api as studio_api
        settings={'comfy_workflows':{},'comfy_active':'','comfy_url':'http://127.0.0.1:1','comfy_params':{'cfg':7,'steps':20,'scheduler':'normal'}}
        def save(value): settings.clear();settings.update(copy.deepcopy(value));return settings
        def workflow(node, cfg):
            return {str(node):{'class_type':'KSampler','inputs':{'seed':1,'steps':28,'cfg':cfg,'sampler_name':'euler','scheduler':'sgm_uniform'}}}
        with patch.object(studio_api,'load_settings',side_effect=lambda:copy.deepcopy(settings)),patch.object(studio_api,'save_settings',side_effect=save):
            first=self.client.post('/api/v1/moss/comfy/import',json={'workflow':json.dumps(workflow(3,4.5)),'name':'A'}).json()['id']
            second=self.client.post('/api/v1/moss/comfy/import',json={'workflow':json.dumps(workflow(103,5.5)),'name':'B'}).json()['id']
            status=self.client.get('/api/v1/moss/comfy/status').json()
            self.assertEqual(status['params']['cfg'],5.5)
            self.assertEqual(status['params']['steps'],28)
            self.assertEqual(status['params']['scheduler'],'sgm_uniform')
            self.client.put('/api/v1/moss/comfy/params',json={'workflow_id':first,'cfg':3})
            self.assertEqual(settings['comfy_workflows'][first]['params'],{'cfg':3})
            self.assertEqual(settings['comfy_workflows'][second]['params'],{})
            bad=self.client.put('/api/v1/moss/comfy/bindings',json={'workflow_id':second,'bindings':{'cfg':{'node':'3','input':'cfg'}}})
            self.assertEqual(bad.status_code,400)
            self.client.put('/api/v1/moss/comfy/layout',json={'workflow_id':first,'positions':{'3':{'x':50,'y':70}}})
            self.assertEqual(settings['comfy_workflows'][first]['layout']['3']['x'],50)
            self.assertEqual(settings['comfy_workflows'][second]['layout'],{})
            self.client.put('/api/v1/moss/comfy/workflows/active',json={'id':first})
            self.assertEqual(self.client.get('/api/v1/moss/comfy/status').json()['params']['cfg'],3)
            self.client.put('/api/v1/moss/comfy/params',json={'workflow_id':first,'reset':True})
            self.assertEqual(self.client.get('/api/v1/moss/comfy/status').json()['params']['cfg'],4.5)
        records=store.jobs(kind='workflow')
        self.assertEqual(len(records),2)
        self.assertTrue(all(job['status']=='succeeded' for job in records))

    def test_native_picker_is_local_and_same_origin_only(self):
        with patch('backend.native_picker.pick_path',AsyncMock(return_value='D:\\Models')) as picker:
            self.assertEqual(self.client.post('/api/v1/files/pick',json={'mode':'folder'},headers={'Origin':'https://other.example'}).status_code,403)
            picker.assert_not_called()
            response=self.client.post('/api/v1/files/pick',json={'mode':'folder'},headers={'Origin':'http://testserver'})
            self.assertEqual(response.status_code,200)
            picker.assert_awaited_once()
            self.assertEqual(self.client.post('/api/v1/files/pick',json={'mode':'shell'}).status_code,400)

    def test_repeated_agent_request_replays_original_job_without_execution(self):
        from contextlib import nullcontext
        workspace=self.client.get('/api/v1/moss/workspace').json()
        series=workspace['series'][0];page=series['pages'][0]
        session=studio.create_session(series['id'],'Fixture')
        count=[]
        async def agent(**kwargs):
            count.append(1)
            yield 'data: '+json.dumps({'type':'text','delta':'完整中文'})+'\n\n'
            yield 'data: '+json.dumps({'type':'done','message':{'id':'fixture','content':'完整中文'}})+'\n\n'
        body={'page_id':page['id'],'doc':page['doc'],'message':'fixture','request_id':'stable-fixture-id'}
        with patch('backend.moss_server.api.run_agent',side_effect=agent),patch('backend.atelier.providers.frozen_request',return_value=nullcontext()),patch('backend.atelier.providers.request_settings',return_value={'provider_id':'local','model':'fixture'}):
            first=self.client.post(f"/api/v1/moss/sessions/{session['id']}/run",json=body)
            self.assertEqual(first.status_code,200)
            second=self.client.post(f"/api/v1/moss/sessions/{session['id']}/run",json=body)
        self.assertEqual(second.status_code,200)
        self.assertEqual(first.headers['X-Atelier-Job'],second.headers['X-Atelier-Job'])
        self.assertEqual(len(count),1)
        self.assertIn('完整中文',first.text)

    def test_native_protocol_connection_probe_uses_shared_adapter(self):
        from types import SimpleNamespace
        async def events(*args,**kwargs):
            yield ('text','ping')
            yield ('done',{'content':'ping','tool_calls':[]})
        resolved={'provider':SimpleNamespace(id='native',kind='anthropic',default_model='test'), 'base_url':'https://example.test/v1','api_key':'fixture'}
        with patch('backend.moss_server.api._resolve_creds',return_value=('https://example.test/v1','fixture')),patch('backend.moss_server.bridge.resolve',return_value=resolved),patch('backend.atelier.providers.stream',side_effect=events):
            response=self.client.post('/api/v1/moss/settings/test',json={'provider_id':'native'})
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.json()['stream_ok'])
        self.assertTrue(response.json()['ok'])

    def test_fixed_segment_cannot_be_changed_by_agent(self):
        series=studio.workspace()['series'][0];page=series['pages'][0];doc=page['doc']
        doc['caption']={'caption':'fixed\nchange','segments':[{'id':'fixed','text':'fixed','locked':True},{'id':'other','text':'change'}]}
        studio.update_page(page['id'],doc=doc)
        wb=Workbench(series['id'],page['id']);wb.set_current_doc(page['id'],doc)
        with self.assertRaises(ToolError): wb.run('update_segments',{'segments':[{'id':'fixed','text':'bad'}]})
        wb.run('update_segments',{'segments':[{'id':'other','text':'better'}]})
        self.assertEqual(wb.doc()['caption']['caption'],'fixed\nbetter')

    def test_saved_secret_is_ciphertext_and_masked_in_responses(self):
        value='test-sensitive-key'
        secrets.write_secret('test',value)
        self.assertNotIn(value,(self.root/'secrets'/'vault.json').read_text())
        self.assertEqual(secrets.read_secret('test'),value)

    def test_download_rejects_unlisted_files(self):
        response=self.client.post('/api/v1/downloads',json={'repo_id':'org/repo','files':['../../bad'],'directory':str(self.root),'endpoint':'https://hf-mirror.com'})
        self.assertEqual(response.status_code,400)
        for filename in ('../x','/x','C:/x','a\\b',''):
            with self.assertRaises(ValueError): safe_filename(filename)


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.stack=ExitStack();self.stack.enter_context(patch.object(store,'DATABASE_PATH',self.root/'atelier.db'));store.initialize()

    async def asyncTearDown(self):
        await __import__('backend.atelier.jobs',fromlist=['close']).close()
        self.stack.close();self.temp.cleanup()

    async def test_anima_preserves_entity_ownership_and_returns_diagnostics(self):
        parsed={'entities':[{'name':'Alice','clothing':'red swimsuit','action':'holds a cup'},{'name':'Bob','clothing':'blue coat'}],'statements':[{'entity':'Alice','facet':'clothing','effect':'red swimsuit'}],'scene':'','relations':[{'from':'Alice','type':'beside','to':'Bob'}],'diagnostics':['Which Bob?']}
        with patch.object(compiler.providers,'complete',AsyncMock(return_value={'content':json.dumps(parsed)})) as upstream:
            result=await compiler.compile_anima({'kind':'caption','caption':{'caption':'Alice wears a red swimsuit and holds a cup. Bob wears a blue coat.'}},[])
        self.assertIn('Alice: red swimsuit, holds a cup',result['prompt'])
        self.assertIn('Bob: blue coat',result['prompt'])
        self.assertIn('Alice beside Bob.',result['prompt'])
        self.assertNotIn("{'from'",result['prompt'])
        self.assertEqual(result['diagnostics'],['Which Bob?'])
        self.assertIn('Do not invent',upstream.call_args.args[0][0]['content'])

    async def test_mcp_stdio_discovers_calls_and_honors_disabled(self):
        script=self.root/'mcp_fixture.py'
        script.write_text("from mcp.server import MCPServer\nserver=MCPServer('test')\n@server.tool()\ndef echo(value:str)->str:\n    return value\nserver.run()\n",encoding='utf-8')
        asset=store.put_object('mcp','local fixture',{'transport':'stdio','command':sys.executable,'args':[str(script)],'enabled':True})
        tools=await mcp.discover(asset['id'])
        store.put_object('mcp',asset['name'],{**asset['data'],'tools':tools,'enabled_tools':['echo']},asset['id'])
        schemas=await mcp.tool_schemas()
        self.assertEqual(schemas[0]['function']['parameters']['properties']['value']['type'],'string')
        result=await mcp.call(schemas[0]['function']['name'],{'value':'Atelier'})
        self.assertIn('Atelier',result)
        store.put_object('mcp',asset['name'],{**asset['data'],'enabled':False,'tools':tools},asset['id'])
        with self.assertRaises(ValueError): await mcp.call(schemas[0]['function']['name'],{'value':'no'})

    async def test_mcp_http_transport(self):
        import socket,subprocess
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        script=self.root/'mcp_http.py'
        script.write_text(f"from mcp.server import MCPServer\nserver=MCPServer('http-test')\n@server.tool()\ndef ping()->str: return 'pong'\nserver.run(transport='streamable-http',port={port})\n",encoding='utf-8')
        process=subprocess.Popen([sys.executable,str(script)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            for _ in range(100):
                try:
                    reader,writer=await asyncio.open_connection('127.0.0.1',port);writer.close();await writer.wait_closed();break
                except OSError: await asyncio.sleep(.1)
            asset=store.put_object('mcp','http fixture',{'transport':'http','url':f'http://127.0.0.1:{port}/mcp','enabled':True})
            tools=await mcp.discover(asset['id'])
            self.assertEqual(tools[0]['name'],'ping')
        finally:
            process.terminate();await asyncio.to_thread(process.wait,10)

    async def test_generation_captures_workflow_snapshot_and_all_images(self):
        nodes={'1':{'class_type':'CLIPTextEncode','inputs':{'text':'old'}}}
        with patch.object(generation,'APP_DATA_DIR',self.root),patch.object(generation,'load_settings',return_value={'comfy_url':'http://fixture'}),patch.object(generation,'active_workflow',return_value={'name':'test','nodes':nodes,'bindings':{'positive':{'node':'1','input':'text'}}}),patch.object(generation.comfy,'submit',AsyncMock(return_value='prompt-owned')),patch.object(generation.comfy,'wait_for_images',AsyncMock(return_value=[{},{}])),patch.object(generation.comfy,'fetch_image',AsyncMock(return_value=(b'png','image.png'))):
            task=generation.submit({'positive':'new','doc':{'version':1}})
            await generation.tasks[task['id']]
            result=store.job(task['id'])
            self.assertEqual(result['status'],'succeeded')
            self.assertEqual(len(result['result']['images']),2)
            self.assertEqual(result['data']['workflow']['1']['inputs']['text'],'new')
            self.assertEqual(nodes['1']['inputs']['text'],'old')


if __name__=='__main__': unittest.main()
