import logging
import threading
import unittest
from unittest.mock import patch
from uvicorn.logging import AccessFormatter
from backend.secrets import SecretFilter
from backend.hf_download.core.download_engine import DownloadEngine
from backend.hf_download.models import DownloadTask, TaskState

class ReliabilityEdges(unittest.TestCase):
    def test_redaction_preserves_uvicorn_structured_access_arguments(self):
        record=logging.LogRecord('uvicorn.access',logging.INFO,'',0,'%s - "%s %s HTTP/%s" %d',
            ('127.0.0.1:42','GET','/?token=hf_TESTSECRET','1.1',200),None)
        SecretFilter().filter(record)
        result=AccessFormatter('%(message)s',use_colors=False).format(record)
        self.assertNotIn('hf_TESTSECRET',result)
        self.assertIn('200',result)

    def test_cancel_during_retry_wait_always_signals_transport(self):
        engine=DownloadEngine(lambda:None)
        task=DownloadTask('a/b','main','file',100,'local_dir','C:/test',None,'https://huggingface.co','batch')
        engine._tasks[task.task_id]=task
        task.set_state(TaskState.PENDING,note='等待重试')
        engine.cancel(task.task_id)
        self.assertTrue(task.cancel_event.is_set())

    def test_paused_not_published_until_worker_has_exited(self):
        engine=DownloadEngine(lambda:None)
        task=DownloadTask('a/b','main','file',100,'local_dir','C:/test',None,'https://huggingface.co','batch')
        engine._tasks[task.task_id]=task;task.set_state(TaskState.DOWNLOADING)
        with patch.object(threading.Thread,'is_alive',return_value=True):
            engine._threads[task.task_id]=threading.Thread()
            engine.pause(task.task_id)
        self.assertNotEqual(task.state,TaskState.PAUSED)

    def test_agent_local_request_uses_profile_thinking_default(self):
        from backend.atelier import providers
        from backend.models import AppConfig
        config=AppConfig()
        with patch.object(providers,'request_settings',return_value={'provider_id':'local'}), patch.object(providers.config_manager,'get_config',return_value=config):
            for value in (True,False):
                config.basic.enable_thinking=value
                payload=providers.build_request([])[3]
                self.assertEqual(payload['chat_template_kwargs']['enable_thinking'],value)

    def test_download_restart_rejects_changed_pinned_manifest(self):
        from backend.atelier.downloads import Downloads
        from backend.hf_download.models import RepoFile
        service=Downloads()
        service.listings[('org/repo','main','https://huggingface.co')]={'file':RepoFile('file',size=100,lfs_sha256='new')}
        data={'repo_id':'org/repo','endpoint':'https://huggingface.co','files':['file'],'file_manifest':{'file':{'size':100,'sha256':'old','git_oid':None}}}
        with self.assertRaisesRegex(ValueError,'版本已改变'):service.submit(data,identifier='original-job')

    def test_old_download_without_version_is_not_silently_replayed(self):
        from backend.atelier.downloads import Downloads
        from backend.hf_download.models import RepoFile
        service=Downloads()
        service.listings[('org/repo','main','https://huggingface.co')]={'file':RepoFile('file',size=100)}
        with self.assertRaisesRegex(ValueError,'无法安全自动恢复'):
            service.submit({'repo_id':'org/repo','endpoint':'https://huggingface.co','files':['file']},identifier='old')
