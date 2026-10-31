"""Hardening guards: data backup endpoint and remote-scoped filesystem browsing."""
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import config_manager as cfg
from backend.atelier import store
from backend.main import app
from backend.models import AppConfig


class DataBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(store, 'DATABASE_PATH', self.root / 'atelier.db'))
        self.stack.enter_context(patch.object(cfg, 'CONFIG_DIR', self.root / 'config'))
        self.stack.enter_context(patch('backend.atelier.api.APP_DATA_DIR', self.root))
        (self.root / 'config').mkdir()
        (self.root / 'moss').mkdir()
        store.initialize()
        cfg.save_config(AppConfig(llama_cpp_dir='C:/engines'), name='default')
        (self.root / 'moss' / 'skills.json').write_text('{"skills": []}', encoding='utf-8')
        self.addCleanup(self.stack.close)
        self.addCleanup(self.temp.cleanup)
        self.client = TestClient(app)

    def test_backup_snapshots_db_profiles_and_moss_settings(self):
        response = self.client.post('/api/v1/data/backup')
        self.assertEqual(response.status_code, 200)
        archive = Path(response.json()['path'])
        self.assertTrue(archive.exists())
        with zipfile.ZipFile(archive) as zf:
            names = set(zf.namelist())
            with zf.open('atelier.db') as fh:
                copy_path = archive.with_suffix('.copy.db')
                copy_path.write_bytes(fh.read())
        copy = sqlite3.connect(copy_path)
        self.assertEqual(
            copy.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='atelier_jobs'").fetchone()[0],
            'atelier_jobs',
        )
        copy.close()
        copy_path.unlink()
        self.assertIn('config/default.json', names)
        self.assertIn('moss/skills.json', names)

    def test_backup_retains_the_newest_ten(self):
        backup_dir = self.root / 'backups'
        backup_dir.mkdir(exist_ok=True)
        for index in range(12):
            (backup_dir / f'atelier-backup-{index:08d}-000000.zip').write_bytes(b'old')
        response = self.client.post('/api/v1/data/backup')
        self.assertEqual(response.status_code, 200)
        remaining = sorted(backup_dir.glob('atelier-backup-*.zip'))
        self.assertEqual(len(remaining), 10)
        self.assertNotIn('atelier-backup-00000000-000000.zip', {p.name for p in remaining})


class RemoteBrowseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(cfg, 'CONFIG_DIR', self.root / 'config'))
        (self.root / 'config').mkdir()
        cfg.save_config(AppConfig(model_path=str(self.root / 'models' / 'm.gguf')), name='default')
        (self.root / 'models').mkdir()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.temp.cleanup)
        self.remote = TestClient(app, client=('192.168.5.4', 5000))

    def _enable_remote(self):
        return patch('backend.main._remote_api_enabled', return_value=True)

    def test_remote_browse_is_confined_to_configured_roots(self):
        with self._enable_remote():
            inside = self.remote.get('/api/v1/browse', params={'dir': str(self.root / 'models')})
            self.assertEqual(inside.status_code, 200)
            self.assertEqual(inside.json()['current'], str((self.root / 'models').resolve()))

            outside = self.remote.get('/api/v1/browse', params={'dir': 'C:\\Windows'})
            self.assertEqual(outside.status_code, 403)

    def test_remote_drives_only_show_configured_roots(self):
        with self._enable_remote():
            response = self.remote.get('/api/v1/drives')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['drives'], [self.root.drive + '\\'])

    def test_local_browse_still_sees_everything(self):
        client = TestClient(app)
        response = client.get('/api/v1/browse', params={'dir': str(self.root)})
        self.assertEqual(response.status_code, 200)


class ChatDownTests(unittest.TestCase):
    """With the managed engine stopped, chat must fail with an actionable 502
    instead of leaking connection errors as 400s or echoing another local
    service's response."""

    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)

    def test_dead_local_engine_returns_actionable_502(self):
        with patch('backend.routers.chat._local_base_url', return_value='http://127.0.0.1:59999'):
            response = self.client.post('/api/v1/chat', json={
                'provider': 'local',
                'messages': [{'role': 'user', 'content': 'ping'}],
                'stream': False,
            })
        self.assertEqual(response.status_code, 502)
        self.assertIn('本地引擎未运行', response.json()['error'])


if __name__ == '__main__':
    unittest.main()
