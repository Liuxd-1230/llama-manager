"""Explicit local Windows dialogs; caller data travels through environment, not code."""
import asyncio
import base64
import os
import subprocess
import json
import ctypes
import logging
from ctypes import wintypes
from collections import deque

_lock = asyncio.Lock()
_process = None
_cancelled = False
_request_id = ''
_cancelled_requests = deque(maxlen=128)


def cancel_picker(request_id: str = ''):
    global _cancelled
    if request_id:
        _cancelled_requests.append(request_id)
        if request_id != _request_id: return
    _cancelled = True
    if _process and _process.returncode is None:
        try: _process.kill()
        except ProcessLookupError: pass


async def pick_path(mode: str, initial: str = '', extension: str = '', request_id: str = '', anchor: dict | None = None) -> str | None:
    global _process, _cancelled, _request_id
    if os.name != 'nt': raise ValueError('系统选择窗口仅适用于 Windows，请使用目录浏览')
    if _lock.locked(): raise ValueError('已有系统选择窗口打开，请先完成或取消')
    script = r'''
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
if ($env:ATELIER_PICK_MODE -eq 'folder') {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Atelier - 选择文件夹'
  if (Test-Path -LiteralPath $env:ATELIER_PICK_INITIAL -PathType Container) { $dialog.SelectedPath = $env:ATELIER_PICK_INITIAL }
} else {
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Atelier - 选择文件'
  $dialog.CheckFileExists = $true
  $dialog.Filter = '所有文件 (*.*)|*.*'
  if ($env:ATELIER_PICK_EXTENSION) { $dialog.Filter = '模型文件|*' + $env:ATELIER_PICK_EXTENSION + '|所有文件 (*.*)|*.*' }
  if (Test-Path -LiteralPath $env:ATELIER_PICK_INITIAL -PathType Container) { $dialog.InitialDirectory = $env:ATELIER_PICK_INITIAL }
  elseif (Test-Path -LiteralPath $env:ATELIER_PICK_INITIAL -PathType Leaf) { $dialog.InitialDirectory = [System.IO.Path]::GetDirectoryName($env:ATELIER_PICK_INITIAL); $dialog.FileName = [System.IO.Path]::GetFileName($env:ATELIER_PICK_INITIAL) }
}
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
public class AtelierWindow : System.Windows.Forms.IWin32Window {
  public System.IntPtr Handle { get; private set; }
  public AtelierWindow(System.IntPtr handle) { Handle = handle; }
}
'@
$fallback = $null
if ($env:ATELIER_PICK_OWNER -and $env:ATELIER_PICK_OWNER -ne '0') {
  $owner = New-Object AtelierWindow([IntPtr]::new([Int64]$env:ATELIER_PICK_OWNER))
} else {
  $fallback = New-Object System.Windows.Forms.Form
  $fallback.Text = 'Atelier 文件选择'
  $fallback.StartPosition = 'CenterScreen'
  $fallback.Size = New-Object System.Drawing.Size(360,160)
  $owner = $fallback
}
if ($fallback -and $env:ATELIER_PICK_ANCHOR) {
  $anchor = $env:ATELIER_PICK_ANCHOR | ConvertFrom-Json
  $center = New-Object System.Drawing.Point([int]($anchor.left + $anchor.width / 2), [int]($anchor.top + $anchor.height / 2))
  $area = [System.Windows.Forms.Screen]::FromPoint($center).WorkingArea
  $owner.StartPosition = 'Manual'
  $owner.Location = New-Object System.Drawing.Point([Math]::Max($area.Left,[Math]::Min($center.X-180,$area.Right-360)), [Math]::Max($area.Top,[Math]::Min($center.Y-80,$area.Bottom-160)))
}
if ($fallback) { $fallback.Show() }
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    if ($env:ATELIER_PICK_MODE -eq 'folder') { [Console]::Write($dialog.SelectedPath) } else { [Console]::Write($dialog.FileName) }
  }
} finally { $dialog.Dispose(); if ($fallback) { $fallback.Close(); $fallback.Dispose() } }
'''
    async with _lock:
        if request_id and request_id in _cancelled_requests: return None
        _cancelled = False
        _request_id=request_id
        user32=ctypes.windll.user32
        user32.GetForegroundWindow.restype=wintypes.HWND
        user32.IsWindowEnabled.argtypes=[wintypes.HWND]
        user32.EnableWindow.argtypes=[wintypes.HWND,wintypes.BOOL]
        user32.GetAncestor.argtypes=[wintypes.HWND,wintypes.UINT]
        user32.GetAncestor.restype=wintypes.HWND
        foreground=user32.GetForegroundWindow()
        owner=user32.GetAncestor(foreground,3) or foreground
        owner_enabled=bool(owner and user32.IsWindowEnabled(owner))
        env = {**os.environ, 'ATELIER_PICK_MODE': mode, 'ATELIER_PICK_INITIAL': initial, 'ATELIER_PICK_EXTENSION': extension, 'ATELIER_PICK_ANCHOR':json.dumps(anchor) if anchor else '', 'ATELIER_PICK_OWNER':str(owner or 0)}
        process = await asyncio.create_subprocess_exec('powershell.exe', '-NoProfile', '-STA', '-EncodedCommand',
            base64.b64encode(script.encode('utf-16le')).decode('ascii'), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
        _process = process
        if _cancelled or request_id and request_id in _cancelled_requests: process.kill()
        try: output, errors = await asyncio.wait_for(process.communicate(), 180)
        except (TimeoutError, asyncio.CancelledError):
            process.kill(); await process.wait()
            raise ValueError('系统选择已超时，请重新打开或使用目录浏览')
        finally:
            _process = None;_request_id=''
            # A terminated helper cannot run WinForms' modal cleanup. Restore
            # only the owner that this request found enabled before opening.
            if owner and owner_enabled:user32.EnableWindow(owner,True)
        if _cancelled: return None
        if process.returncode:
            logging.getLogger(__name__).warning('Native picker failed: %s',errors.decode('utf-8','replace')[:400])
            raise ValueError('无法打开系统选择窗口，请使用目录浏览')
        return output.decode('utf-8-sig').strip() or None
