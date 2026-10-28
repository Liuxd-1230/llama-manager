"""Shared SQLite persistence for projects, assets and durable background jobs."""
from __future__ import annotations
from contextlib import contextmanager
import gzip
import json
from pathlib import Path
import sqlite3
import time
import uuid
from ..paths import DATABASE_PATH


@contextmanager
def connection():
    db=sqlite3.connect(DATABASE_PATH,timeout=15)
    db.row_factory=sqlite3.Row
    try:
        db.execute('PRAGMA busy_timeout=15000')
        with db:
            yield db
    finally:
        db.close()


def initialize():
    with connection() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS atelier_objects(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,updated_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS atelier_objects_kind ON atelier_objects(kind,updated_at);
        CREATE TABLE IF NOT EXISTS atelier_dictionary(kind TEXT NOT NULL,name TEXT NOT NULL,search TEXT NOT NULL,popularity INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,name));
        CREATE TABLE IF NOT EXISTS atelier_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,result TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS atelier_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,event TEXT NOT NULL,created_at REAL NOT NULL);
        ''')
        db.execute("UPDATE atelier_jobs SET status='interrupted',error='服务已重启，请检查结果后手动重试' WHERE status IN ('queued','running')")
        # Existing series join the default project without changing their IDs.
        project = db.execute("SELECT id FROM atelier_objects WHERE kind='project' LIMIT 1").fetchone()
        if not project:
            db.execute('INSERT INTO atelier_objects VALUES(?,?,?,?,?)', ('project_default','project','我的创作', '{}', time.time()))


def objects(kind: str, query: str = '') -> list[dict]:
    with connection() as db:
        rows = db.execute('SELECT * FROM atelier_objects WHERE kind=? AND (name LIKE ? OR data LIKE ?) ORDER BY updated_at DESC LIMIT 1000', (kind, '%'+query+'%', '%'+query+'%')).fetchall()
    return [{**dict(r), 'data': json.loads(r['data'])} for r in rows]


def get_object(identifier: str) -> dict:
    with connection() as db:
        r = db.execute('SELECT * FROM atelier_objects WHERE id=?', (identifier,)).fetchone()
    if not r:
        raise KeyError('记录不存在')
    return {**dict(r), 'data': json.loads(r['data'])}


def put_object(kind: str, name: str, data: dict, identifier: str | None = None) -> dict:
    identifier = identifier or uuid.uuid4().hex
    with connection() as db:
        db.execute('INSERT INTO atelier_objects VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=excluded.updated_at', (identifier,kind,name.strip() or '未命名',json.dumps(data,ensure_ascii=False),time.time()))
    return get_object(identifier)


def create_job(kind: str, title: str, data: dict) -> dict:
    identifier = uuid.uuid4().hex
    with connection() as db:
        db.execute('INSERT INTO atelier_jobs(id,kind,title,status,data,updated_at) VALUES(?,?,?,?,?,?)', (identifier,kind,title,'queued',json.dumps(data,ensure_ascii=False),time.time()))
    return update_job(identifier, status='queued')


def jobs(kind: str | None = None, page_id: str | None = None, limit: int = 100) -> list[dict]:
    filters=[];params=[]
    if kind:
        filters.append('kind=?');params.append(kind)
    if page_id:
        filters.append("json_extract(data,'$.page_id')=?");params.append(page_id)
    where=' WHERE '+' AND '.join(filters) if filters else ''
    with connection() as db:
        rows = db.execute('SELECT * FROM atelier_jobs'+where+' ORDER BY updated_at DESC LIMIT ?', (*params,max(1,min(limit,500)))).fetchall()
    return [{**dict(r),'data':json.loads(r['data']),'result':json.loads(r['result'])} for r in rows]


def job(identifier: str) -> dict:
    with connection() as db:
        row = db.execute('SELECT * FROM atelier_jobs WHERE id=?',(identifier,)).fetchone()
    if not row:
        raise KeyError('任务不存在')
    return {**dict(row),'data':json.loads(row['data']),'result':json.loads(row['result'])}


def update_job(identifier: str, *, status: str | None = None, result: dict | None = None, error: str | None = None) -> dict:
    with connection() as db:
        for column,value in (('status',status),('result',json.dumps(result,ensure_ascii=False) if result is not None else None),('error',error)):
            if value is not None:
                db.execute(f'UPDATE atelier_jobs SET {column}=?,updated_at=? WHERE id=?',(value,time.time(),identifier))
        payload = {'status':status,'result':result,'error':error}
        db.execute('INSERT INTO atelier_events(job_id,event,created_at) VALUES(?,?,?)',(identifier,json.dumps(payload,ensure_ascii=False),time.time()))
    return job(identifier)


def import_dictionary():
    folder=Path(__file__).resolve().parents[1]/'data'
    with connection() as db:
        for kind,filename in (('tag','danbooru_tags.tsv.gz'),('character','danbooru_characters.tsv.gz')):
            if db.execute('SELECT 1 FROM atelier_dictionary WHERE kind=? LIMIT 1',(kind,)).fetchone(): continue
            path=folder/filename
            if not path.exists(): continue
            rows=[]
            with gzip.open(path,'rt',encoding='utf-8') as stream:
                for position,line in enumerate(stream):
                    fields=line.rstrip('\n').split('\t')
                    if kind=='tag':
                        name=fields[0];pop=int(fields[1]);data={'name':name,'aliases':fields[2] if len(fields)>2 else '', 'prompt':name,'builtin':True}
                    else:
                        name=fields[0];pop=100000-position;data={'name':name,'series':fields[1],'appearance':fields[2],'clothing':fields[3],'aliases':fields[4] if len(fields)>4 else '', 'builtin':True}
                    rows.append((kind,name,' '.join(fields).lower(),pop,json.dumps(data,ensure_ascii=False)))
            db.executemany('INSERT OR IGNORE INTO atelier_dictionary VALUES(?,?,?,?,?)',rows)
