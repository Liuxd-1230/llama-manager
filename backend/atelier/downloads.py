"""Web adapter for the original, resumable HF Mirror Downloader core."""
from __future__ import annotations
import asyncio
from dataclasses import asdict
from pathlib import Path, PurePosixPath
import json
import os
import shutil
from ..hf_download.core.download_engine import DownloadEngine
from ..hf_download.core.history import HistoryStore
from ..hf_download.core.hf_client import list_repo_files_full
from ..hf_download.core.url_parser import parse_input
from ..hf_download.core.cache_utils import build_hf_command, resolve_hub_cache_dir
from ..hf_download.models import BatchSpec, RepoFile
from ..paths import APP_DATA_DIR, DATABASE_PATH, copy_database
from ..secrets import read_secret
from . import store


def token():
    return os.getenv('HF_TOKEN') or read_secret('hf_token') or None


def safe_filename(name: str):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
        raise ValueError('仓库文件路径无效')


class Downloads:
    def __init__(self):
        self.engine = None
        self.monitor = None
        self.batches = {}
        self.listings = {}

    async def initialize(self):
        self.engine = DownloadEngine(token, HistoryStore(DATABASE_PATH))
        if not os.getenv('ATELIER_DATA_DIR'):
            await asyncio.to_thread(self.import_legacy_history)
        self.monitor = asyncio.create_task(self.watch())

    def import_legacy_history(self):
        import sqlite3
        from contextlib import closing
        import hashlib
        from ..hf_download.core.secure_store import TokenStore
        from ..secrets import write_secret
        roots=[Path(__file__).resolve().parents[2].parent/'HF Mirror Downloader',Path(os.getenv('LOCALAPPDATA',str(Path.home())))/'HFMirrorDownloader']
        for root in roots:
            source=root/'history.db'
            if not source.is_file(): continue
            marker='hf_migration_'+hashlib.sha256(str(source).encode()).hexdigest()[:12]
            with store.connection() as db:
                if db.execute('SELECT 1 FROM atelier_objects WHERE id=?',(marker,)).fetchone(): continue
            backup=APP_DATA_DIR/'backups'/f'{marker}.db';backup.parent.mkdir(exist_ok=True)
            copy_database(source,backup)
            with closing(sqlite3.connect(backup)) as legacy,store.connection() as db:
                columns=[row[1] for row in legacy.execute('PRAGMA table_info(downloads)') if row[1]!='id']
                if not columns: continue
                names=','.join(columns);mapping={}
                for row in legacy.execute(f'SELECT id,{names} FROM downloads'):
                    cursor=db.execute(f'INSERT INTO downloads({names}) VALUES({",".join("?" for _ in columns)})',row[1:])
                    mapping[str(row[0])]=cursor.lastrowid
                db.execute('INSERT INTO atelier_objects VALUES(?,?,?,?,?)',(marker,'migration','HF 下载历史',json.dumps({'source':str(source),'backup':str(backup),'id_map':mapping}),__import__('time').time()))
            saved=TokenStore(root).load()
            if saved and not token(): write_secret('hf_token',saved)

    async def inspect(self, text: str, endpoint: str):
        if endpoint not in ('https://hf-mirror.com','https://hf-mirror.net','https://huggingface.co'):
            raise ValueError('请选择 Hugging Face 或受支持的镜像')
        parsed = parse_input(text)
        files = await asyncio.to_thread(list_repo_files_full, endpoint, parsed.repo_id, parsed.revision, token())
        self.listings[(parsed.repo_id,parsed.revision,endpoint)] = {f.path:f for f in files}
        return {**asdict(parsed),'files':[{**asdict(f),'category':f.category} for f in files]}

    def submit(self, data: dict, identifier: str | None = None):
        available = self.listings.get((data['repo_id'],data.get('revision','main'),data['endpoint']))
        if available is None:
            raise ValueError('请先解析仓库，再选择文件')
        names = data.get('files') or []
        if not names or any(name not in available for name in names):
            raise ValueError('文件选择无效')
        manifest={name:{'size':available[name].size,'sha256':available[name].lfs_sha256,'git_oid':available[name].oid} for name in names}
        if identifier:
            if not data.get('file_manifest'):
                raise ValueError('旧任务没有保存文件版本，无法安全自动恢复；请重新解析并新建下载，已有断点会保留')
            if data['file_manifest']!=manifest:
                raise ValueError('仓库文件版本已改变，旧断点已保留；请重新解析并确认后新建下载')
        data={**data,'file_manifest':manifest}
        for name in names:
            safe_filename(name)
        mode = data.get('mode','local_dir')
        if mode not in ('cache','local_dir'):
            raise ValueError('下载模式无效')
        directory = Path(data.get('directory','')).expanduser()
        if not directory.is_absolute():
            raise ValueError('请选择绝对目标目录')
        directory.mkdir(parents=True, exist_ok=True)
        size = sum(available[n].size or 0 for n in names)
        if not identifier and shutil.disk_usage(directory).free < size:
            raise ValueError('目标磁盘剩余空间不足')
        workers = int(data.get('workers',4))
        if workers not in (1,2,4,8):
            raise ValueError('并发数必须为 1、2、4 或 8')
        self.engine.set_max_workers(workers)
        spec = BatchSpec(repo_id=data['repo_id'],revision=data.get('revision','main'),files=[available[n] for n in dict.fromkeys(names)],mode=mode,endpoint=data['endpoint'],local_dir=str(directory) if mode=='local_dir' else None,cache_dir=resolve_hub_cache_dir(str(directory)) if mode=='cache' else None)
        task = store.job(identifier) if identifier else store.create_job('download', f"下载 {spec.repo_id}", data)
        batch = self.engine.submit(spec)
        self.batches[task['id']] = batch
        return store.update_job(task['id'],status='running',result={'batch_id':batch})

    async def watch(self):
        previous = {}
        while True:
            grouped={}
            for snapshot in self.engine.snapshot(): grouped.setdefault(snapshot['batch_id'],[]).append(snapshot)
            for identifier,batch in list(self.batches.items()):
                snapshots = grouped.get(batch,[])
                encoded = json.dumps(snapshots,sort_keys=True)
                if previous.get(identifier)==encoded:
                    continue
                previous[identifier] = encoded
                states = {t['state'] for t in snapshots}
                status='running'
                if states and states <= {'已完成','失败','已取消'}:
                    status='failed' if '失败' in states else 'cancelled' if '已取消' in states else 'succeeded'
                elif states and states <= {'已完成','失败','已取消','已暂停'}: status='paused'
                store.update_job(identifier,status=status,result={'batch_id':batch,'files':snapshots})
            await asyncio.sleep(1)

    def action(self, identifier: str, action: str):
        current = store.job(identifier)
        if action not in ('pause','resume','cancel','retry'):
            raise ValueError('下载操作无效')
        if identifier not in self.batches:
            if action in ('resume','retry'):
                data=current['data']
                return data  # caller reparses repository metadata before restoring a batch
            return store.update_job(identifier,status='paused' if action=='pause' else 'cancelled')
        for task in self.engine.snapshot():
            if task['batch_id']==self.batches[identifier]:
                getattr(self.engine,action)(task['task_id'])
        return current

    async def close(self):
        if self.engine:
            await asyncio.to_thread(self.engine.shutdown)
        if self.monitor:
            self.monitor.cancel()
            try:
                await self.monitor
            except asyncio.CancelledError:
                pass


downloads = Downloads()
