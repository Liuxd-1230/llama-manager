"""The actual durable producer/subscriber race, not a provider mock."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from backend.atelier import jobs, store


class AgentDelivery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.patch=patch.object(store,'DATABASE_PATH',Path(self.temp.name)/'jobs.db')
        self.patch.start();store.initialize()

    async def asyncTearDown(self):
        await jobs.close();self.patch.stop();self.temp.cleanup()

    async def test_producer_finishes_while_subscriber_is_sending_previous_batch(self):
        release=asyncio.Event()
        async def producer():
            yield 'data: {"type":"text","delta":"前"}\n\n'
            await release.wait()
            yield 'data: {"type":"text","delta":"后"}\n\n'
            yield 'data: {"type":"done","message":{"content":"前后"}}\n\n'
        identifier=jobs.start_agent(producer(),'race',{'session_id':'race'})
        task=jobs.active[identifier]
        subscription=jobs.stream_agent(identifier)
        first=await anext(subscription)
        while '"type"' not in first: first=await anext(subscription)
        release.set();await task
        frames=[first,*[frame async for frame in subscription]]
        events=[json.loads(line[6:]) for frame in frames for line in frame.splitlines() if line.startswith('data: ')]
        self.assertEqual(''.join(e['delta'] for e in events if e.get('type')=='text'),'前后')
        self.assertEqual([e for e in events if e.get('type')][-1]['type'],'done')

    async def test_cancelled_subscriber_receives_terminal_status_without_done(self):
        started=asyncio.Event()
        async def producer():
            started.set()
            yield 'data: {"type":"text","delta":"partial"}\n\n'
            await asyncio.sleep(60)
        identifier=jobs.start_agent(producer(),'cancel',{})
        await started.wait()
        task=jobs.active[identifier];task.cancel()
        await task
        frames=[frame async for frame in jobs.stream_agent(identifier)]
        self.assertIn('"status": "cancelled"', ''.join(frames))

    async def test_cancel_before_response_headers_prevents_late_request_execution(self):
        from backend.moss_server import agent
        from backend.moss_server.routes import sessions as api
        with patch.object(api.db,'get_session',return_value={'id':'session'}):
            result=await api.cancel_session_request('session',api.CancelRunBody(request_id='early-stop'))
            self.assertEqual(result['status'],'cancelled')
            with patch.object(agent,'run_agent',side_effect=AssertionError('cancelled request must not call model/tools')):
                response=await api.run_session('session',api.RunBody(page_id='page',doc={},message='stop me',request_id='early-stop'))
                text=''.join([part async for part in response.body_iterator])
                self.assertIn('"status": "cancelled"',text)
