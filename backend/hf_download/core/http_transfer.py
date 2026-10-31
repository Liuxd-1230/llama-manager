"""Durable HTTP Range transport with version-bound partial files.

Hub 1.33 creates random temporary names and restarts HTTP transfers. Atelier
therefore owns this small transport; Hub still resolves authoritative metadata.
"""
from __future__ import annotations
import hashlib,json,os,shutil
from pathlib import Path,PurePosixPath
from urllib.parse import urlsplit
import requests
from filelock import FileLock
from .errors import FriendlyError,KIND_NETWORK,classify_status

CHUNK=256*1024

def _save(path,data):
    temp=path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');os.replace(temp,path)

def _digest(path,sha256):
    digest=hashlib.sha256() if sha256 else hashlib.sha1()
    if not sha256:digest.update(f'blob {path.stat().st_size}\0'.encode())
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()

def download_file(task,token,commit_lookup):
    from huggingface_hub import get_hf_file_metadata,hf_hub_url
    from huggingface_hub.errors import FileMetadataError,HfHubHTTPError
    relative=PurePosixPath(task.filename)
    if relative.is_absolute() or '..' in relative.parts or '\\' in task.filename or ':' in task.filename:raise ValueError('文件路径无效')
    task.set_state(task.state,phase='connecting',note='正在连接下载源')
    url=hf_hub_url(task.repo_id,task.filename,revision=task.revision,endpoint=task.endpoint)
    notice=''
    commit=None;etag=task.lfs_sha256 or task.git_oid;size=task.size
    try:
        meta=get_hf_file_metadata(url,token=token or False,timeout=15)
        url=meta.location;commit=meta.commit_hash;etag=meta.etag or etag;size=meta.size if meta.size is not None else size
        pinned=task.lfs_sha256 or task.git_oid
        if pinned and meta.etag and pinned!=meta.etag:raise FriendlyError('version_changed','仓库文件版本已改变，请重新解析仓库并确认文件后下载')
    except FileMetadataError:pass
    except HfHubHTTPError as exc:
        status=getattr(exc.response,'status_code',0)
        message=f'下载源需要登录或授权（HTTP {status}）。请配置 HF Token，并确认已接受模型许可后重试。' if status in (401,403) else f'下载源元数据返回 HTTP {status}，请检查仓库、文件与分支'
        raise FriendlyError(classify_status(status),message) from None
    if not task.lfs_sha256 and not task.git_oid and etag:
        if len(etag)==64:task.lfs_sha256=etag
        elif len(etag)==40:task.git_oid=etag
    expected=task.lfs_sha256 or task.git_oid
    if task.mode=='cache' and not etag:raise ValueError('下载源缺少版本标识，无法可靠写入 HF 缓存，请改用指定目录')
    identity=hashlib.sha256(json.dumps([task.endpoint,task.repo_id,task.revision,task.filename,etag],ensure_ascii=False).encode()).hexdigest()
    if task.mode=='cache':
        cache=Path(task.cache_dir)/('models--'+task.repo_id.replace('/','--'))
        part=cache/'blobs'/(etag+'.incomplete');final=cache/'blobs'/etag
        metadata=cache/'blobs'/(etag+'.atelier.json')
    else:
        final=Path(task.local_dir)/task.filename
        hidden=Path(task.local_dir)/'.cache'/'atelier'/identity
        part=hidden/'download.incomplete';metadata=hidden/'identity.json'
    part.parent.mkdir(parents=True,exist_ok=True);final.parent.mkdir(parents=True,exist_ok=True)
    with FileLock(str(part)+'.lock',timeout=30):
        try:previous=json.loads(metadata.read_text(encoding='utf-8'))
        except (FileNotFoundError,ValueError):previous={}
        # Completed existing content is only reused with a matching identity or
        # a matching authoritative digest. Same name/size alone is not enough.
        cached=final.exists() and (size is None or final.stat().st_size==size)
        if cached and expected:
            task.set_state(task.state,phase='verifying',note='校验现有文件')
            cached=_digest(final,bool(task.lfs_sha256))==expected
        elif cached:cached=previous.get('identity')==identity and previous.get('complete') is True
        if not cached:
            resume=part.stat().st_size if part.exists() and etag and previous.get('identity')==identity else 0
            if size is not None and resume>size:resume=0
            if not resume and part.exists():
                if not etag: notice=task.note='下载源未提供稳定版本标识，已从头下载'
                part.unlink()
            if size is not None and shutil.disk_usage(part.parent).free<max(0,size-resume):raise FriendlyError('disk','目标磁盘空间不足，请释放空间后恢复')
            headers={'Accept-Encoding':'identity'}
            if token and urlsplit(url).netloc==urlsplit(task.endpoint).netloc:headers['Authorization']='Bearer '+token
            if resume:
                headers['Range']=f'bytes={resume}-'
                if previous.get('http_etag'):headers['If-Range']=previous['http_etag']
            info={'identity':identity,'etag':etag,'commit':commit,'size':size,'complete':False}
            _save(metadata,info)
            if size is None or resume<size:
                try:
                    with requests.get(url,headers=headers,stream=True,timeout=(10,15),allow_redirects=True) as response:
                        status=response.status_code;task.http_status=status;task.resumed_from=resume
                        if status not in (200,206):raise FriendlyError(classify_status(status),f'下载源返回 HTTP {status}，请检查授权或更换下载源')
                        content_range=response.headers.get('Content-Range','')
                        if resume and status==206:
                            import re
                            matched=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+|\*)',content_range)
                            if not matched or int(matched[1])!=resume:raise FriendlyError(KIND_NETWORK,'下载源返回了错误的续传范围，请重试')
                            task.range_supported=True
                            if matched[3]!='*':size=int(matched[3])
                        elif resume:
                            resume=0;task.range_supported=False;notice=task.note='下载源未接受断点，已从头下载'
                        else:task.range_supported=response.headers.get('Accept-Ranges','').lower()=='bytes' or status==206
                        if size is None and response.headers.get('Content-Length'):size=int(response.headers['Content-Length'])+resume
                        info['http_etag']=response.headers.get('ETag');info['size']=size;_save(metadata,info)
                        task.begin_transfer(resume,size)
                        if not task.note or task.note=='正在连接下载源':task.note=''
                        with part.open('ab' if resume else 'wb') as stream:
                            for chunk in response.iter_content(chunk_size=CHUNK):
                                if chunk:stream.write(chunk);task.note_bytes(len(chunk))
                            stream.flush();os.fsync(stream.fileno())
                except requests.RequestException:raise FriendlyError(KIND_NETWORK,'网络接收中断，断点已保留，可恢复或重试') from None
            if not part.exists():raise FriendlyError(KIND_NETWORK,'下载未产生文件，请重试')
            if size is not None and part.stat().st_size!=size:raise FriendlyError(KIND_NETWORK,'接收字节数与文件大小不一致，断点已保留')
            task.set_state(task.state,phase='verifying',note='正在校验文件完整性')
            if expected and _digest(part,bool(task.lfs_sha256))!=expected:
                part.unlink();raise FriendlyError(KIND_NETWORK,'下载文件完整性校验失败，已移除损坏的断点，请重试')
            os.replace(part,final);info['complete']=True;_save(metadata,info)
        if task.mode=='cache':
            commit=commit or commit_lookup(task,token)
            if not commit:raise FriendlyError(KIND_NETWORK,'文件已接收，但无法确认仓库版本；请恢复以完成缓存登记')
            snapshot=cache/'snapshots'/commit/task.filename;snapshot.parent.mkdir(parents=True,exist_ok=True)
            if not snapshot.exists():
                try:os.symlink(os.path.relpath(final,snapshot.parent),snapshot)
                except OSError:shutil.copy2(final,snapshot)
            revision=PurePosixPath(task.revision)
            if not revision.is_absolute() and '..' not in revision.parts:
                ref=cache/'refs'/task.revision;ref.parent.mkdir(parents=True,exist_ok=True);ref.write_text(commit,encoding='utf-8')
            final=snapshot
        task.bytes_done=final.stat().st_size;task.size=size
        task.set_state(task.state,phase='completed',note='已校验缓存文件，无需重复下载' if cached else notice)
        return str(final)
