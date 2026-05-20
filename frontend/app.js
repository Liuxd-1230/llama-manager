// ── State ──
let ws=null, wsCompile=null, wsDownload=null, statusTimer=null, chatHistory=[];
let folderCallback=null, currentBrowsePath='';
let browseMode='folder', browseFilter='.gguf', selectedFilePath='';
let isWindows = navigator.platform.indexOf('Win')>=0;
let configDirty=false, lastSavedSnapshot='';

// ── Theme ──
function toggleTheme(){
  const html=document.documentElement;
  const isDark=html.getAttribute('data-theme')==='dark';
  if(isDark){html.removeAttribute('data-theme');localStorage.setItem('theme','light')}
  else{html.setAttribute('data-theme','dark');localStorage.setItem('theme','dark')}
  const use=document.querySelector('#themeBtn use');
  if(use) use.setAttribute('href',isDark?'#i-moon':'#i-sun');
  document.getElementById('themeBtn')?.setAttribute('aria-checked',isDark?'false':'true');
}

// ── Navigation ──
document.querySelectorAll('#sidebar button').forEach(btn => {
  btn.addEventListener('click', () => {
    const leavingConfig=document.querySelector('#page-config.active,#page-sampling.active,#page-prompt.active');
    if(configDirty && leavingConfig && !confirm('配置已修改但未保存，确定离开？'))return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('#sidebar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const page = btn.dataset.page;
    document.getElementById('page-' + page).classList.add('active');
    if(page==='server') connectLogWS();
    if(page==='chat') loadChatModels();
    if(page==='webui') refreshWebUI();
    if(page==='update') connectCompileWS();
    if(page==='download') connectDownloadWS();
    if(page==='optimize') connectOptimizeWS();
    if(page==='logs') connectLogWS();
    if(page==='params') buildParamPreview();
  });
});

// ── Unsaved changes tracking ──
function markDirty(){configDirty=true;updateDirtyIndicator()}
function clearDirty(){configDirty=false;lastSavedSnapshot=JSON.stringify(cfgFromUI());updateDirtyIndicator()}
function updateDirtyIndicator(){
  const el=document.getElementById('configDirtyBadge');
  if(el)el.style.display=configDirty?'inline':'none';
}
function checkDirtyBeforeUnload(e){if(configDirty){e.preventDefault();e.returnValue=''}}
window.addEventListener('beforeunload',checkDirtyBeforeUnload);
// Watch config inputs — just flag dirty, no expensive comparison
document.addEventListener('input',e=>{
  if(e.target.closest('#page-config')||e.target.closest('#page-sampling')||e.target.closest('#page-prompt'))markDirty();
});
document.addEventListener('change',e=>{
  if(e.target.closest('#page-config')||e.target.closest('#page-sampling')||e.target.closest('#page-prompt'))markDirty();
});

// ── Helpers ──
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function syncR(n){document.getElementById(n+'Val').value=document.getElementById(n+'Range').value}
function syncV(n){document.getElementById(n+'Range').value=document.getElementById(n+'Val').value}
function toggleSamp(n){
  const e=document.getElementById(n+'Enabled'),g=document.getElementById(n+'Group');
  g.classList.toggle('group-disabled',!e.checked);
}
function toggleMTP(){const e=document.getElementById('mtpEnabled'),g=document.getElementById('mtpGroup');g.classList.toggle('group-disabled',!e.checked)}
function onModeChange(){const m=document.getElementById('serverMode').value;document.getElementById('serverHost').value=m==='lan'?'0.0.0.0':'127.0.0.1'}
async function api(u,o={}){const r=await fetch(u,{headers:{'Content-Type':'application/json'},...o});return r.json()}

// ── Config <-> UI ──
function cfgFromUI(){
  return {
    llama_cpp_dir:document.getElementById('llamaCppDir').value,
    model_path:document.getElementById('modelPath').value,
    mmproj_path:document.getElementById('mmprojPath').value,
    basic:{
      ctx_size:+document.getElementById('ctxSize').value,
      ngl:+document.getElementById('ngl').value,
      threads:+document.getElementById('threads').value,
      parallel:+document.getElementById('parallel').value,
      mmap:document.getElementById('mmap').checked,
      mlock:document.getElementById('mlock').checked,
      n_cpu_moe:+document.getElementById('nCpuMoe').value,
      kv_cache_quant_k:document.getElementById('kvCacheQuantK').value,
      kv_cache_quant_v:document.getElementById('kvCacheQuantV').value,
      enable_thinking:document.getElementById('enableThinking').checked,
      kv_offload:document.getElementById('kvOffload').checked,
      flash_attn:document.getElementById('flashAttn').checked,
      fit_target:+document.getElementById('fitTarget').value,
      kv_unified:document.getElementById('kvUnified').checked,
      batch_size:+document.getElementById('batchSize').value,
      ubatch_size:+document.getElementById('ubatchSize').value,
      context_shift:document.getElementById('contextShift').checked,
      cache_ram:+document.getElementById('cacheRam').value,
    },
    sampling:{
      temperature:+document.getElementById('tempVal').value,
      top_k:+document.getElementById('topkVal').value,
      top_p:+document.getElementById('toppVal').value,
      min_p_enabled:document.getElementById('minpEnabled').checked,
      min_p:+document.getElementById('minpVal').value,
      repeat_penalty_enabled:document.getElementById('repeatEnabled').checked,
      repeat_penalty:+document.getElementById('repeatVal').value,
      presence_penalty_enabled:document.getElementById('presenceEnabled').checked,
      presence_penalty:+document.getElementById('presenceVal').value,
    },
    mtp:{
      enabled:document.getElementById('mtpEnabled').checked,
      spec_type:document.getElementById('mtpSpecType').value,
      draft_n_max:+document.getElementById('mtpDraftNMax').value,
      draft_n_min:+document.getElementById('mtpDraftNMin').value||0,
      p_min:+document.getElementById('mtpPMin').value,
      p_split:+document.getElementById('mtpPSplit').value,
    },
    system_prompt:document.getElementById('systemPrompt').value,
    extra_params:document.getElementById('extraParams').value,
    server:{host:document.getElementById('serverHost').value,port:+document.getElementById('serverPort').value,mode:document.getElementById('serverMode').value},
    compile:{command:document.getElementById('compileCmd').value},
  };
}

function uiFromCfg(c){
  document.getElementById('llamaCppDir').value=c.llama_cpp_dir||'';
  document.getElementById('modelPath').value=c.model_path||'';
  document.getElementById('mmprojPath').value=c.mmproj_path||'';
  const b=c.basic||{};
  document.getElementById('ctxSize').value=b.ctx_size??4096;
  document.getElementById('ngl').value=b.ngl??99;
  document.getElementById('threads').value=b.threads??8;
  document.getElementById('parallel').value=b.parallel??1;
  document.getElementById('mmap').checked=b.mmap??true;
  document.getElementById('mlock').checked=b.mlock??false;
  document.getElementById('nCpuMoe').value=b.n_cpu_moe??0;
  document.getElementById('kvCacheQuantK').value=b.kv_cache_quant_k||'';
  document.getElementById('kvCacheQuantV').value=b.kv_cache_quant_v||'';
  document.getElementById('enableThinking').checked=b.enable_thinking??false;
  document.getElementById('kvOffload').checked=b.kv_offload??true;
  document.getElementById('flashAttn').checked=b.flash_attn??false;
  document.getElementById('fitTarget').value=b.fit_target??0;
  document.getElementById('kvUnified').checked=b.kv_unified??true;
  document.getElementById('batchSize').value=b.batch_size??2048;
  document.getElementById('ubatchSize').value=b.ubatch_size??512;
  document.getElementById('contextShift').checked=b.context_shift??false;
  document.getElementById('cacheRam').value=b.cache_ram??-1;
  const s=c.sampling||{};
  ['temp',s.temperature??0.7],['topk',s.top_k??40],['topp',s.top_p??0.95],['minp',s.min_p??0.05],['repeat',s.repeat_penalty??1.1],['presence',s.presence_penalty??0].forEach(()=>{});
  document.getElementById('tempVal').value=s.temperature??0.7;document.getElementById('tempRange').value=s.temperature??0.7;
  document.getElementById('topkVal').value=s.top_k??40;document.getElementById('topkRange').value=s.top_k??40;
  document.getElementById('toppVal').value=s.top_p??0.95;document.getElementById('toppRange').value=s.top_p??0.95;
  document.getElementById('minpEnabled').checked=s.min_p_enabled??false;document.getElementById('minpVal').value=s.min_p??0.05;document.getElementById('minpRange').value=s.min_p??0.05;
  document.getElementById('repeatEnabled').checked=s.repeat_penalty_enabled??false;document.getElementById('repeatVal').value=s.repeat_penalty??1.1;document.getElementById('repeatRange').value=s.repeat_penalty??1.1;
  document.getElementById('presenceEnabled').checked=s.presence_penalty_enabled??false;document.getElementById('presenceVal').value=s.presence_penalty??0;document.getElementById('presenceRange').value=s.presence_penalty??0;
  toggleSamp('minp');toggleSamp('repeat');toggleSamp('presence');
  const m=c.mtp||{};
  document.getElementById('mtpEnabled').checked=m.enabled??false;
  document.getElementById('mtpSpecType').value=m.spec_type||'draft-mtp';
  document.getElementById('mtpDraftNMax').value=m.draft_n_max??3;
  document.getElementById('mtpPMin').value=m.p_min??0.0;
  document.getElementById('mtpPSplit').value=m.p_split??0.10;
  toggleMTP();
  document.getElementById('systemPrompt').value=c.system_prompt||'';
  document.getElementById('extraParams').value=c.extra_params||'';
  const sv=c.server||{};
  document.getElementById('serverMode').value=sv.mode||'local';
  document.getElementById('serverHost').value=sv.host||'127.0.0.1';
  document.getElementById('serverPort').value=sv.port??8080;
  document.getElementById('compileCmd').value=c.compile?.command||'cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release -j12';
  document.getElementById('listenAddr').textContent=sv.host+':'+sv.port;
}

async function loadInitCfg(){const c=await api('/api/config');uiFromCfg(c);refreshCfgList();clearDirty()}
async function saveConfig(){
  const name=document.getElementById('configName').value.trim()||'default';
  await api('/api/config/save-as',{method:'POST',body:JSON.stringify({name,config:cfgFromUI()})});
  clearDirty();
  showToast('配置已保存: '+name);refreshCfgList()
}
async function refreshCfgList(){const{configs}=await api('/api/config/list');const s=document.getElementById('configList');s.innerHTML='<option value="">-- 已保存配置 --</option>';configs.forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;s.appendChild(o)})}
async function loadSavedConfig(){const n=document.getElementById('configList').value;if(!n)return;const c=await api('/api/config/load',{method:'POST',body:JSON.stringify({name:n})});uiFromCfg(c);document.getElementById('configName').value=n;clearDirty()}
async function deleteConfig(){
  const name=document.getElementById('configName').value.trim()||'default';
  if(name==='default'){alert('不能删除默认配置');return}
  if(!confirm('确定删除配置 "'+name+'" ?'))return;
  await api('/api/config/delete',{method:'POST',body:JSON.stringify({name})});
  showToast('已删除: '+name);document.getElementById('configName').value='default';refreshCfgList();clearDirty()
}
function exportConfig(){const b=new Blob([JSON.stringify(cfgFromUI(),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='llama-manager-config.json';a.click()}
function importConfig(){document.getElementById('importFile').click()}
async function handleImport(e){const f=e.target.files[0];if(!f)return;const t=await f.text();const c=await api('/api/config/import',{method:'POST',body:JSON.stringify({content:t})});uiFromCfg(c);clearDirty();e.target.value=''}

// ── Toast ──
function showToast(msg){
  const t=document.createElement('div');
  t.className='toast';
  t.innerHTML='<i class="icon icon-sm lucide-check-circle"></i> '+esc(msg);
  document.body.appendChild(t);
  setTimeout(()=>{t.classList.add('hide');setTimeout(()=>t.remove(),150)},2500);
}

// ── Folder / File browser ──
let nativePickerTarget='';
function openFolderPicker(targetInput){
  browseMode='folder';
  browseFilter='';
  selectedFilePath='';
  document.getElementById('folderModalTitle').textContent='📂 浏览文件夹';
  document.getElementById('folderSelectBtn').textContent='选择此文件夹';
  document.getElementById('selectedFileInfo').style.display='none';
  folderCallback=(path)=>{document.getElementById(targetInput).value=path;if(targetInput==='llamaCppDir')setTimeout(detectServer,200)};
  currentBrowsePath=document.getElementById(targetInput).value||'';
  document.getElementById('folderModal').classList.add('show');
  loadDriveList();
  if(currentBrowsePath) browseTo(currentBrowsePath); else browseTo(isWindows?'C:\\':'/');
}
function handleNativeFolder(e){
  const files=e.target.files;
  if(files&&files.length>0){
    const fp=files[0].webkitRelativePath;
    const fullPath=files[0].path||'';
    let dir='';
    if(fullPath){dir=fullPath.replace(/[\\/][^\\/]*$/,'')}
    else if(fp){dir=fp.split('/')[0]}
    if(dir&&nativePickerTarget){
      document.getElementById(nativePickerTarget).value=dir;
      if(nativePickerTarget==='llamaCppDir')setTimeout(detectServer,200);
    }
  }
  e.target.value='';
}
function openFilePicker(targetInput,ext){
  nativePickerTarget=targetInput;
  document.getElementById('nativeFilePicker').click();
}
function handleNativeFile(e){
  const f=e.target.files[0];
  if(f){
    let p=f.path||f.name;
    if(nativePickerTarget)document.getElementById(nativePickerTarget).value=p;
  }
  e.target.value='';
}
// File browser (for model/mmproj) — same modal but picks files
function openFileBrowser(targetInput, filter){
  browseMode='file';
  browseFilter=filter||'.gguf';
  selectedFilePath='';
  const title=targetInput==='modelPath'?'🧠 选择模型':'🖼️ 选择 mmproj 文件';
  document.getElementById('folderModalTitle').textContent=title;
  document.getElementById('folderSelectBtn').textContent='选择此文件';
  document.getElementById('selectedFileInfo').style.display='none';
  folderCallback=(path)=>{document.getElementById(targetInput).value=path};
  // Start from current path's parent, or default to common model locations
  const currentVal=document.getElementById(targetInput).value;
  if(currentVal){
    let p=currentVal.replace(/[\\/][^\\/]*$/,'');
    currentBrowsePath=p||currentVal;
  }else{
    // Default to common model locations instead of llamaCppDir
    currentBrowsePath=isWindows?'C:\\':'/';
  }
  document.getElementById('folderModal').classList.add('show');
  loadDriveList();
  browseTo(currentBrowsePath);
}
function closeFolderModal(){document.getElementById('folderModal').classList.remove('show')}
async function loadDriveList(){
  const r=await api('/api/drives');
  const dl=document.getElementById('driveList');
  if(r.drives&&r.drives.length>1){
    dl.innerHTML='';
    r.drives.forEach(d=>{
      const btn=document.createElement('button');
      btn.className='btn btn-secondary';
      btn.style.cssText='padding:3px 10px;font-size:12px';
      btn.dataset.browse=d+'\\';
      btn.textContent=d;
      dl.appendChild(btn);
    });
    dl.style.display='flex';
  }else{dl.style.display='none'}
}
async function browseTo(path){
  if(path!==undefined) currentBrowsePath=path;
  document.getElementById('folderPathInput').value=currentBrowsePath;
  updateBreadcrumb();
  const r=await api('/api/browse?dir='+encodeURIComponent(currentBrowsePath));
  const list=document.getElementById('folderList');
  if(!r.entries||!r.entries.length){list.innerHTML='<div style="color:var(--fg-muted);padding:12px;text-align:center">空目录</div>';return}
  // Always show directories
  list.innerHTML='';
  r.entries.filter(e=>e.is_dir).forEach(e=>{
    const div=document.createElement('div');
    div.className='file-item';
    div.dataset.browse=e.path;
    div.innerHTML='<span class="file-icon">📁</span>';
    const span=document.createElement('span');
    span.textContent=e.name;
    div.appendChild(span);
    list.appendChild(div);
  });
  // In file mode, also show .gguf files
  if(browseMode==='file'){
    const files=r.entries.filter(e=>!e.is_dir && e.name.toLowerCase().endsWith(browseFilter));
    if(files.length){
      files.forEach(e=>{
        const sizeMB=(e.size_mb||(e.size||0)/(1024*1024)).toFixed(0);
        const div=document.createElement('div');
        div.className='file-item';
        div.dataset.file=e.path;
        div.dataset.name=e.name;
        const icon=document.createElement('span');
        icon.className='file-icon';
        icon.textContent='📄';
        const nameSpan=document.createElement('span');
        nameSpan.style.flex='1';
        nameSpan.textContent=e.name;
        const sizeSpan=document.createElement('span');
        sizeSpan.className='file-size';
        sizeSpan.textContent=sizeMB+' MB';
        div.append(icon, nameSpan, sizeSpan);
        list.appendChild(div);
      });
    }
    // Auto-scan hint if no gguf found
    if(!files.length && r.entries.length>0){
      const hint=document.createElement('div');
      hint.style.cssText='color:var(--fg-muted);padding:8px 10px;font-size:12px;text-align:center';
      hint.textContent='此目录无 '+browseFilter+' 文件';
      list.appendChild(hint);
    }
  }
}
function updateBreadcrumb(){
  const bc=document.getElementById('folderBreadcrumb');
  const parts=currentBrowsePath.replace(/\\/g,'/').split('/').filter(Boolean);
  bc.innerHTML='';
  const root=document.createElement('span');
  root.dataset.browse='/';
  root.textContent='/';
  bc.appendChild(root);
  let acc='';
  parts.forEach(p=>{
    acc+='/'+p;
    const span=document.createElement('span');
    span.dataset.browse=acc;
    span.textContent=p;
    bc.appendChild(document.createTextNode(' '));
    bc.appendChild(span);
    bc.appendChild(document.createTextNode(' / '));
  });
}
// Event delegation for all browse clicks
document.addEventListener('click',function(e){
  const el=e.target.closest('[data-browse]');
  if(el){e.preventDefault();browseTo(el.dataset.browse)}
  const fileEl=e.target.closest('[data-file]');
  if(fileEl){
    e.preventDefault();
    // Select this file
    selectedFilePath=fileEl.dataset.file;
    // Highlight
    document.querySelectorAll('#folderList .file-item').forEach(i=>i.classList.remove('selected'));
    fileEl.classList.add('selected');
    // Show selection info
    const info=document.getElementById('selectedFileInfo');
    info.textContent='✅ 已选择: '+fileEl.dataset.name;
    info.style.display='block';
  }
});
function selectFolder(){
  if(browseMode==='file'){
    // In file mode, use selected file or try to find .gguf in current dir
    if(selectedFilePath){
      if(folderCallback)folderCallback(selectedFilePath);
    }else{
      // Auto-scan current directory for .gguf files
      scanAndPickFile();
      return;
    }
  }else{
    if(folderCallback)folderCallback(currentBrowsePath);
  }
  closeFolderModal();
}
async function scanAndPickFile(){
  const r=await api('/api/scan-models?dir='+encodeURIComponent(currentBrowsePath));
  if(r.models&&r.models.length){
    // Auto-select if only one, otherwise pick first
    const picked=r.models[0].path;
    if(folderCallback)folderCallback(picked);
    showToast('自动检测到 '+r.models.length+' 个模型，已选择: '+r.models[0].name);
  }else{
    showToast('⚠️ 此目录未找到 .gguf 文件');
    return;
  }
  closeFolderModal();
}
function goUpOneLevel(){
  let p=currentBrowsePath.replace(/\\/g,'/').replace(/\/$/,'');
  let idx=p.lastIndexOf('/');
  if(idx>0){browseTo(p.substring(0,idx)+(isWindows&&idx<=2?'/':''))}
  else if(isWindows&&p.length>=2){browseTo(p.substring(0,2)+'\\')}
}

// ── Model picker (uses unified file browser) ──
function openModelPicker(){
  openFileBrowser('modelPath', '.gguf');
}

// ── Server detect ──
async function detectServer(){
  const d=document.getElementById('llamaCppDir').value;
  if(!d)return;
  const r=await api('/api/detect-server?llama_cpp_dir='+encodeURIComponent(d));
  const el=document.getElementById('serverBinStatus');
  if(r.found){el.textContent='✅ '+r.path;el.style.color='var(--green)'}
  else{el.innerHTML='❌ 未找到 llama-server'+(isWindows?'.exe':'')+'，请确认已编译或检查目录';el.style.color='var(--red)'}
}
async function onDirChange(){setTimeout(detectServer,100)}

// ── Server control ──
let healthPollTimer=null;
async function startServer(){document.getElementById('btnStart').disabled=true;await api('/api/config',{method:'POST',body:JSON.stringify(cfgFromUI())});const r=await api('/api/server/start',{method:'POST'});if(r.error){alert('启动失败: '+r.error);document.getElementById('btnStart').disabled=false;return}connectLogWS();refreshStatus();startHealthPoll()}
async function stopServer(){document.getElementById('btnStop').disabled=true;stopHealthPoll();await api('/api/server/stop',{method:'POST'});refreshStatus()}
function startHealthPoll(){
  stopHealthPoll();
  const badge=document.getElementById('statusBadge');
  badge.textContent='● 启动中...';
  badge.className='status-pill st-starting';
  let attempts=0;
  const maxAttempts=60;
  healthPollTimer=setInterval(async()=>{
    attempts++;
    try{
      const r=await api('/api/server/health');
      if(r.ready){
        stopHealthPoll();
        badge.className='status-pill st-running';
        badge.textContent='● 就绪';
        showToast('✅ llama-server 已就绪，可以开始对话');
        refreshStatus();
        if('Notification' in window&&Notification.permission==='granted'){
          new Notification('llama-server 已就绪',{body:'服务启动成功，可以开始对话',icon:'🖥️'});
        }
        return;
      }
    }catch{}
    if(attempts>=maxAttempts){
      stopHealthPoll();
      showToast('⚠️ 健康检查超时，请查看日志确认服务状态');
    }
  },2000);
}
function stopHealthPoll(){if(healthPollTimer){clearInterval(healthPollTimer);healthPollTimer=null}}
async function refreshStatus(){const s=await api('/api/server/status');const b=document.getElementById('statusBadge'),info=document.getElementById('serverInfo');b.className='status-pill';if(s.state==='running'){b.classList.add('st-running');b.textContent='● 运行中';document.getElementById('btnStart').disabled=true;document.getElementById('btnStop').disabled=false;info.textContent=`PID ${s.pid} | ${Math.floor(s.uptime_seconds/60)}m${Math.floor(s.uptime_seconds%60)}s`}else{b.classList.add('st-stopped');b.textContent='● 已停止';document.getElementById('btnStart').disabled=false;document.getElementById('btnStop').disabled=true;info.textContent=s.error||''}}

// ── WebSocket logs ──
function connectLogWS(){if(ws&&ws.readyState<=1)return;ws=new WebSocket(`ws://${location.host}/ws/logs`);ws.onmessage=e=>appendLog('serverLog',e.data);ws.onclose=()=>setTimeout(connectLogWS,3000)}
function connectCompileWS(){if(wsCompile&&wsCompile.readyState<=1)return;wsCompile=new WebSocket(`ws://${location.host}/ws/compile`);wsCompile.onmessage=e=>appendLog('compileLog',e.data);wsCompile.onclose=()=>setTimeout(connectCompileWS,3000)}
function connectDownloadWS(){if(wsDownload&&wsDownload.readyState<=1)return;wsDownload=new WebSocket(`ws://${location.host}/ws/download`);wsDownload.onmessage=e=>appendLog('downloadLog',e.data);wsDownload.onclose=()=>setTimeout(connectDownloadWS,3000)}
function appendLog(boxId,text){const box=document.getElementById(boxId);const line=document.createElement('div');line.style.marginBottom='1px';if(text.includes('ERROR')||text.includes('error'))line.className='log-error';if(text.includes('[manager]')||text.includes('[download]'))line.className='log-info';line.textContent=text;box.appendChild(line);if(boxId==='serverLog'){const full=document.getElementById('fullLog');const l2=line.cloneNode(true);full.appendChild(l2);if(document.getElementById('autoScroll2')?.checked)full.scrollTop=full.scrollHeight}if(document.getElementById('autoScroll')?.checked)box.scrollTop=box.scrollHeight}
async function clearLogs(){await api('/api/server/logs/clear',{method:'POST'});['serverLog','fullLog'].forEach(id=>document.getElementById(id).innerHTML='')}
function downloadLogs(){const t=document.getElementById('fullLog').innerText;const b=new Blob([t],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`llama-server-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.log`;a.click()}

// ── Chat ──
async function loadChatModels(){try{const r=await api('/api/chat/models');const s=document.getElementById('chatModel');s.innerHTML='';if(r.data&&r.data.length){r.data.forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.id;s.appendChild(o)})}else{s.innerHTML='<option>服务器未启动</option>'}}catch{document.getElementById('chatModel').innerHTML='<option>服务器未启动</option>'}}
function appendChatMsg(role,content){const box=document.getElementById('chatMessages');if(box.querySelector('[style*="text-align:center"]'))box.innerHTML='';const d=document.createElement('div');d.className='chat-msg '+(role==='user'?'chat-user':'chat-ai');d.textContent=content;box.appendChild(d);box.scrollTop=box.scrollHeight;return d}
async function sendChat(){const inp=document.getElementById('chatInput');const msg=inp.value.trim();if(!msg)return;inp.value='';chatHistory.push({role:'user',content:msg});appendChatMsg('user',msg);const body={model:document.getElementById('chatModel').value,messages:chatHistory,temperature:parseFloat(document.getElementById('chatTemp').value),max_tokens:parseInt(document.getElementById('chatMaxTokens').value),stream:true};const aiDiv=appendChatMsg('assistant','⏳ 生成中...');document.getElementById('btnSend').disabled=true;try{const resp=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const reader=resp.body.getReader();const decoder=new TextDecoder();let full='',buffer='';while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.startsWith('data: '))continue;const data=line.slice(6).trim();if(data==='[DONE]')continue;try{const j=JSON.parse(data);const d=j.choices?.[0]?.delta?.content||'';full+=d;aiDiv.textContent=full;document.getElementById('chatMessages').scrollTop=999999}catch{}}}if(!full)aiDiv.textContent='(空回复)';chatHistory.push({role:'assistant',content:full})}catch(e){aiDiv.textContent='❌ '+e.message}document.getElementById('btnSend').disabled=false}
function clearChat(){chatHistory=[];document.getElementById('chatMessages').innerHTML='<div style="text-align:center;color:var(--fg-muted);padding:60px 0">对话已清空</div>'}
document.addEventListener('DOMContentLoaded',()=>{const ci=document.getElementById('chatInput');if(ci)ci.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}})});

// ── WebUI ──
function refreshWebUI(){const s=cfgFromUI().server;const url=`http://${s.host==='0.0.0.0'?location.hostname:s.host}:${s.port}`;document.getElementById('webuiFrame').src=url}
function openWebUI(){const s=cfgFromUI().server;window.open(`http://${s.host==='0.0.0.0'?location.hostname:s.host}:${s.port}`,'_blank')}

// ── Update ──
async function checkUpdate(){const r=await api('/api/update/check');const el=document.getElementById('updateInfo');if(r.error){el.textContent='❌ '+r.error;el.style.color='var(--red)';return}if(r.has_update){el.innerHTML=`🔄 有更新: <b>${esc(r.current_commit)}</b> → <b>${esc(r.remote_commit)}</b>`;el.style.color='var(--yellow)'}else{el.textContent=`✅ 已是最新 (${r.current_commit})`;el.style.color='var(--green)'}}
async function pullUpdate(force=false){const r=await api('/api/update/pull',{method:'POST',body:JSON.stringify({force}),headers:{'Content-Type':'application/json'}});const el=document.getElementById('updateInfo');if(r.success){el.textContent='✅ '+r.output;el.style.color='var(--green)'}else{el.textContent='❌ '+(r.error||r.output);el.style.color='var(--red)'}}
async function stopCompile(){await api('/api/update/compile/stop',{method:'POST'});document.getElementById('btnCompile').disabled=false;document.getElementById('btnCompileStop').disabled=true}
async function startCompile(){document.getElementById('btnCompile').disabled=true;document.getElementById('btnCompileStop').disabled=false;await api('/api/config',{method:'POST',body:JSON.stringify(cfgFromUI())});const r=await api('/api/update/compile',{method:'POST'});if(r.error){alert(r.error);document.getElementById('btnCompile').disabled=false;return}connectCompileWS()}

// ── Download ──
async function stopDownload(){await api('/api/download/stop',{method:'POST'});document.getElementById('btnDownload').disabled=false;document.getElementById('btnDownloadStop').disabled=true}
async function startDownload(){const dir=document.getElementById('downloadDir').value;if(!dir){alert('请填写目标文件夹');return}document.getElementById('btnDownload').disabled=true;document.getElementById('btnDownloadStop').disabled=false;const r=await api('/api/download/start',{method:'POST',body:JSON.stringify({target_dir:dir})});if(r.error){alert(r.error);document.getElementById('btnDownload').disabled=false;return}connectDownloadWS()}

// ── Param preview ──
function buildParamPreview(){
  const c=cfgFromUI();
  const lines=[];
  const add=(flag,val,comment)=>{lines.push({flag,val,comment:comment||''})};
  const bin=c.llama_cpp_dir?(c.llama_cpp_dir+(isWindows?'\\build\\bin\\llama-server':'/build/bin/llama-server')):'llama-server';
  add(bin,'','llama-server binary');
  add('-m',c.model_path||'<model_path>','模型文件');
  if(c.mmproj_path) add('--mmproj',c.mmproj_path,'mmproj 多模态');
  add('-c',c.basic.ctx_size,'上下文长度');
  add('-ngl',c.basic.ngl,'GPU 卸载层数');
  add('-t',c.basic.threads,'CPU 线程数');
  add('-np',c.basic.parallel,'并行数');
  add(c.basic.mmap?'--mmap':'--mmap=0','','内存映射');
  if(c.basic.mlock) add('--mlock','','锁定内存');
  if(c.basic.n_cpu_moe>0) add('--n-cpu-moe',c.basic.n_cpu_moe,'MoE CPU 卸载层数');
  if(c.basic.kv_cache_quant_k) add('--cache-type-k',c.basic.kv_cache_quant_k,'KV 缓存量化 K');
  if(c.basic.kv_cache_quant_v) add('--cache-type-v',c.basic.kv_cache_quant_v,'KV 缓存量化 V');
  if(c.basic.enable_thinking) add('--reasoning','on','思维链');
  if(!c.basic.kv_offload) add('--no-kv-offload','','KV缓存不卸载到GPU');
  if(c.basic.flash_attn) add('--flash-attn','on','Flash Attention');
  if(c.basic.fit_target>0) add('--fit-target',c.basic.fit_target,'GPU显存余量限制(MiB)');
  if(!c.basic.kv_unified) add('--no-kv-unified','','禁用Unified KV缓存');
  if(c.basic.batch_size!==2048) add('-b',c.basic.batch_size,'逻辑批大小');
  if(c.basic.ubatch_size!==512) add('-ub',c.basic.ubatch_size,'物理批大小');
  if(c.basic.context_shift) add('--context-shift','','上下文自动切换');
  if(c.basic.cache_ram>=0) add('--cache-ram',c.basic.cache_ram,'缓存RAM上限(MiB)');
  add('--temp',c.sampling.temperature,'');
  add('--top-k',c.sampling.top_k,'');
  add('--top-p',c.sampling.top_p,'');
  if(c.sampling.min_p_enabled) add('--min-p',c.sampling.min_p,'');
  if(c.sampling.repeat_penalty_enabled) add('--repeat-penalty',c.sampling.repeat_penalty,'');
  if(c.sampling.presence_penalty_enabled) add('--presence-penalty',c.sampling.presence_penalty,'');
  if(c.mtp.enabled){
    add('--spec-type',c.mtp.spec_type,'MTP 投机解码');
    add('--spec-draft-n-max',c.mtp.draft_n_max,'最大草稿 token');
    if(c.mtp.draft_n_min>0) add('--spec-draft-n-min',c.mtp.draft_n_min,'最小草稿 token');
    if(c.mtp.p_min!==0.0) add('--spec-draft-p-min',c.mtp.p_min,'草稿置信阈值');
    if(c.mtp.p_split!==0.10) add('--spec-draft-p-split',c.mtp.p_split,'分裂概率阈值');
  }
  if(c.system_prompt) add('--system-prompt','"'+c.system_prompt.slice(0,50)+'..."','');
  add('--host',c.server.host,'');add('--port',c.server.port,'');
  if(c.extra_params.trim()) add('# extra:',c.extra_params,'额外参数');
  const el=document.getElementById('paramPreview');
  el.innerHTML=lines.map(l=>`<div class="param-line"><span class="flag">${esc(l.flag)}</span> <span class="value">${esc(l.val)}</span>${l.comment?` <span class="comment"># ${esc(l.comment)}</span>`:''}</div>`).join('\n');
  // Also update cmdPreview
  const cmd=lines.filter(l=>!l.flag.startsWith('#')).map(l=>l.flag+(l.val?' '+l.val:'')).join(' ');
  document.getElementById('cmdPreview').textContent=cmd;
}
function copyParams(){const t=document.getElementById('paramPreview').innerText;navigator.clipboard.writeText(t);showToast('已复制到剪贴板')}

// ── Optimizer ──
let wsOptimize=null;
let optResults=[];

function connectOptimizeWS(){
  if(wsOptimize&&wsOptimize.readyState<=1)return;
  wsOptimize=new WebSocket(`ws://${location.host}/ws/optimize`);
  wsOptimize.onmessage=e=>{
    const text=e.data;
    // Try to parse as JSON status update
    try{
      const data=JSON.parse(text);
      if(data.type==='status'){
        document.getElementById('optProgress').textContent=`进度: ${data.current_trial}/${data.total_trials}`;
        if(data.best){
          document.getElementById('optProgress').textContent+=` | 最优: tg=${data.best.tg} t/s`;
        }
      }else if(data.type==='result'){
        optResults.push(data);
        appendResultRow(data);
      }
    }catch{
      // Plain text log line
      appendLog('optimizeLog',text);
    }
  };
  wsOptimize.onclose=()=>{if(document.getElementById('btnOptStop').disabled===false)wsOptimize=null};
}

function appendResultRow(r){
  const tbody=document.getElementById('optResultBody');
  if(tbody.querySelector('td[colspan]'))tbody.innerHTML='';
  const tr=document.createElement('tr');
  const fields=[r.trial,r.ngl,r.n_cpu_moe,r.ctx,r.kv,r.pp,r.tg,r.status==='ok'?'✓':'✗'];
  fields.forEach((v,i)=>{
    const td=document.createElement('td');
    if(i===5)td.style.fontWeight='600';
    if(i===6)td.style.cssText='font-weight:600;color:var(--accent)';
    td.textContent=v;
    tr.appendChild(td);
  });
  const td=document.createElement('td');
  const btn=document.createElement('button');
  btn.className='btn btn-secondary btn-sm';
  btn.textContent='应用';
  btn.addEventListener('click',()=>applyOptResult(r));
  td.appendChild(btn);
  tr.appendChild(td);
  tbody.appendChild(tr);
  // Sort by tg descending
  const rows=Array.from(tbody.querySelectorAll('tr'));
  rows.sort((a,b)=>{
    const tgA=parseFloat(a.querySelectorAll('td')[6]?.textContent||'0');
    const tgB=parseFloat(b.querySelectorAll('td')[6]?.textContent||'0');
    return tgB-tgA;
  });
  tbody.innerHTML='';
  rows.forEach(r=>tbody.appendChild(r));
}

function applyOptResult(r){
  // Apply the result to config page
  document.getElementById('ngl').value=r.ngl;
  document.getElementById('nCpuMoe').value=r.n_cpu_moe;
  document.getElementById('ctxSize').value=r.ctx;
  document.getElementById('kvCacheQuantK').value=r.kv;
  document.getElementById('kvCacheQuantV').value=r.kv;
  showToast(`已应用: ngl=${r.ngl}, n_cpu_moe=${r.n_cpu_moe}, ctx=${r.ctx}, kv=${r.kv}`);
  markDirty();
  // Switch to config tab
  document.querySelector('[data-page="config"]').click();
}

async function startOptimize(){
  const ctxOptions=Array.from(document.querySelectorAll('.opt-ctx:checked')).map(e=>+e.value);
  const kvOptions=Array.from(document.querySelectorAll('.opt-kv:checked')).map(e=>e.value);
  if(!ctxOptions.length){alert('请至少选择一个上下文长度');return}
  if(!kvOptions.length){alert('请至少选择一个KV缓存类型');return}
  // 先保存当前配置，确保模型路径等是最新的
  await api('/api/config',{method:'POST',body:JSON.stringify(cfgFromUI())});
  const body={
    ngl_range:[+document.getElementById('optNglMin').value,+document.getElementById('optNglMax').value],
    n_cpu_moe_range:[+document.getElementById('optMoeMin').value,+document.getElementById('optMoeMax').value],
    ctx_options:ctxOptions,
    kv_options:kvOptions,
    n_trials:+document.getElementById('optTrials').value,
  };
  document.getElementById('btnOptStart').disabled=true;
  document.getElementById('btnOptStop').disabled=false;
  document.getElementById('optResultBody').innerHTML='<tr><td colspan="9" style="padding:12px;text-align:center;color:var(--fg-muted)">运行中...</td></tr>';
  optResults=[];
  const r=await api('/api/optimize/start',{method:'POST',body:JSON.stringify(body)});
  if(r.error){alert(r.error);document.getElementById('btnOptStart').disabled=false;document.getElementById('btnOptStop').disabled=true;return}
  connectOptimizeWS();
}

async function stopOptimize(){
  await api('/api/optimize/stop',{method:'POST'});
  document.getElementById('btnOptStart').disabled=false;
  document.getElementById('btnOptStop').disabled=true;
}

// ── Init ──
// Set theme icon on load
(function(){
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const use=document.querySelector('#themeBtn use');
  const btn=document.getElementById('themeBtn');
  if(use) use.setAttribute('href',isDark?'#i-sun':'#i-moon');
  if(btn) btn.setAttribute('aria-checked',isDark?'true':'false');
})();
loadInitCfg();
statusTimer=setInterval(refreshStatus,5000);
refreshStatus();