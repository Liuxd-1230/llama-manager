"""One owned process per active file: an interrupted read can always be stopped.

Hub resolves metadata; Atelier owns Range recovery, locks and cache writes. The web
process never mutates the Hub's global client/chunk settings or kills a shared
transport. Progress comes only from bytes received by the worker.
"""
from __future__ import annotations
import multiprocessing
import os
import time
from .errors import FriendlyError, KIND_NETWORK, translate_exception
from ..models import DownloadTask, TaskState


def _windows_lifetime(process):
    """Close-on-parent-exit job also prevents abandoned download workers."""
    if os.name!='nt': return None
    import ctypes
    from ctypes import wintypes as w
    class Basic(ctypes.Structure):
        _fields_=[('user',ctypes.c_longlong),('job',ctypes.c_longlong),('flags',w.DWORD),('min_ws',ctypes.c_size_t),('max_ws',ctypes.c_size_t),('active',w.DWORD),('affinity',ctypes.c_size_t),('priority',w.DWORD),('scheduling',w.DWORD)]
    class IO(ctypes.Structure):
        _fields_=[(key,ctypes.c_ulonglong) for key in ['read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes']]
    class Limits(ctypes.Structure):
        _fields_=[('basic',Basic),('io',IO),('process_memory',ctypes.c_size_t),('job_memory',ctypes.c_size_t),('peak_process',ctypes.c_size_t),('peak_job',ctypes.c_size_t)]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateJobObjectW.restype=w.HANDLE
    kernel.SetInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]
    kernel.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]
    kernel.CloseHandle.argtypes=[w.HANDLE]
    job=kernel.CreateJobObjectW(None,None)
    limits=Limits();limits.basic.flags=0x2000
    if not job or not kernel.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job,w.HANDLE(process.sentinel)):
        if job: kernel.CloseHandle(job)
        return None
    return lambda:kernel.CloseHandle(job)


def _worker(fields, token, pipe):
    try:
        from .download_engine import DownloadEngine
        class ProgressTask(DownloadTask):
            _last_report=0.0
            def publish(self, force=False):
                now=time.monotonic()
                if not force and now-self._last_report<.1: return
                self._last_report=now
                pipe.send(('progress',self.snapshot(),list(self._samples),self._start_bytes))
            def note_bytes(self,n):
                super().note_bytes(n);self.publish()
            def begin_transfer(self,initial=0,total=None):
                super().begin_transfer(initial,total);self.publish(True)
            def set_state(self,state,**kwargs):
                super().set_state(state,**kwargs)
                if state is not TaskState.COMPLETED: self.publish(True)
        task=ProgressTask(**fields)
        engine=DownloadEngine(lambda:token,history=None,max_workers=1)
        engine._transfer_once(task)
        pipe.send(('done',task.snapshot()))
    except BaseException as exc:
        friendly=translate_exception(exc,fields.get('endpoint',''))
        try: pipe.send(('error',friendly.kind,friendly.message))
        except (BrokenPipeError,EOFError,OSError): pass
    finally:
        pipe.close()


def controlled_transfer(task: DownloadTask, token: str | None):
    from .download_engine import _TaskInterrupted
    if task.cancel_event.is_set(): raise _TaskInterrupted(task.stop_action)
    context=multiprocessing.get_context('spawn')
    reader,writer=context.Pipe(duplex=False)
    fields={key:getattr(task,key) for key in ['repo_id','revision','filename','size','mode','local_dir','cache_dir','endpoint','batch_id','task_id','lfs_sha256','git_oid']}
    process=context.Process(target=_worker,args=(fields,token,writer),daemon=True,name='Atelier-download-'+task.task_id)
    process.start();writer.close();lifetime=_windows_lifetime(process)
    task.worker_pid=process.pid;task.worker_guard=bool(lifetime)
    task.started_at=time.time();task.finished_at=None
    task.set_state(TaskState.DOWNLOADING,phase='connecting',note='正在连接下载源')
    result=None
    try:
        while True:
            if task.cancel_event.is_set(): raise _TaskInterrupted(task.stop_action)
            if reader.poll(.05):
                try: message=reader.recv()
                except EOFError: break
                if message[0]=='error': raise FriendlyError(message[1],message[2])
                snapshot=message[1]
                with task._lock:
                    for key in ['bytes_done','size','note','phase','range_supported','resumed_from','http_status']:
                        if key in snapshot: setattr(task,key,snapshot[key])
                    if message[0]=='progress': task._samples=message[2];task._start_bytes=message[3]
                if message[0]=='done':result=snapshot;break
            elif not process.is_alive(): break
        if not result: raise FriendlyError(KIND_NETWORK,'下载传输进程提前退出，请恢复或重试')
        process.join(timeout=2)
        if process.is_alive(): raise FriendlyError(KIND_NETWORK,'下载进程未正常结束，请重试')
        if task.cancel_event.is_set(): raise _TaskInterrupted(task.stop_action)
        task.set_state(TaskState.COMPLETED,local_path=result['local_path'],note=result['note'],phase='completed')
    finally:
        if process.is_alive():
            process.terminate();process.join(timeout=2)
            if process.is_alive():process.kill();process.join(timeout=2)
        reader.close()
        if lifetime:lifetime()
        process.close()
        task.worker_pid=None
