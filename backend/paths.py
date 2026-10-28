"""Atelier data root and atomic, verified migration from Llama Manager."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time


def copy_database(source: Path, target: Path) -> None:
    with closing(sqlite3.connect(source)) as src, closing(sqlite3.connect(target)) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError(f'数据库校验失败：{source.name}')


def migrate_data(legacy: Path, target: Path) -> Path:
    if (target / 'migration.json').exists() or not legacy.exists():
        target.mkdir(parents=True, exist_ok=True)
        return target
    # Never merge into an unmarked, populated destination or modify the source.
    if target.exists() and any(target.iterdir()):
        return target
    staging = target.with_name(target.name + '.migrating')
    backup = target.parent / 'Atelier-backups' / str(time.time_ns())
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(legacy, backup, ignore=shutil.ignore_patterns('*.db-wal','*.db-shm','*.gguf','*.safetensors','*.ninfer'))
    try:
        for source in legacy.rglob('*.db'):
            dest=backup/source.relative_to(legacy)
            dest.parent.mkdir(parents=True,exist_ok=True)
            copy_database(source,dest)
        if staging.exists():
            raise RuntimeError(f'存在未完成迁移，请检查：{staging}')
        shutil.copytree(backup, staging, ignore=shutil.ignore_patterns('*.db-wal', '*.db-shm', '*.gguf', '*.safetensors', '*.ninfer'))
        for source in legacy.rglob('*.db'):
            dest = staging / source.relative_to(legacy)
            dest.parent.mkdir(parents=True, exist_ok=True)
            copy_database(source, dest)
        source = staging / 'manager.db'
        combined = staging / 'atelier.db'
        if source.exists():
            copy_database(source, combined)
        studio = staging / 'moss' / 'workspace.db'
        counts = {}
        if studio.exists():
            with closing(sqlite3.connect(combined)) as dst, closing(sqlite3.connect(studio)) as src:
                for name, sql in src.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
                    dst.execute(sql)
                    rows = src.execute(f'SELECT * FROM "{name}"').fetchall()
                    if rows:
                        dst.executemany(f'INSERT INTO "{name}" VALUES ({",".join("?" for _ in rows[0])})', rows)
                    count = dst.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
                    if count != len(rows):
                        raise RuntimeError(f'迁移记录数不匹配：{name}')
                    counts[name] = count
                dst.commit()
        (staging / 'migration.json').write_text(json.dumps({'version': 1, 'backup': str(backup), 'source': str(legacy), 'counts': counts}, ensure_ascii=False, indent=2), encoding='utf-8')
        if target.exists():
            target.rmdir()
        staging.replace(target)
        return target
    except Exception:
        # Leave staging and backup intact for recovery; fail before switching roots.
        raise RuntimeError(f'Atelier 数据迁移失败，原数据未修改，备份位于 {backup}') from None


def data_root() -> Path:
    override = os.getenv('ATELIER_DATA_DIR')
    if override:
        path = Path(override).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path
    target = Path(os.getenv('LOCALAPPDATA', str(Path.home() / '.local' / 'share'))) / 'Atelier'
    return migrate_data(Path.home() / 'llama-manager', target)


APP_DATA_DIR = data_root()
DATABASE_PATH = APP_DATA_DIR / 'atelier.db'
