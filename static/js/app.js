// auto-detect backend base URL for Live Server vs Flask
// If page port is 5001 (Flask default) assume same-origin; otherwise use explicit backend base.
const pagePort = (location && location.port) ? location.port : '';
const API_BASE = (pagePort && pagePort !== '5001') ? 'http://127.0.0.1:5001' : '';

// helpers
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const startBtn = $('#startBtn');
const urlInput = $('#url');
const qualitySelect = $('#quality');
const taskList = $('#taskList');
const historyList = $('#historyList');
const refreshHistoryBtn = $('#refreshHistory');
const clearHistoryBtn = $('#clearHistory');
const clearTasksBtn = $('#clearTasks');
const yearSpan = $('#year');

yearSpan.textContent = new Date().getFullYear();

function apiPath(p){
  // p should start with /api or /download
  if(API_BASE) return API_BASE + p;
  return p;
}

function make(html){
  const tmp = document.createElement('div');
  tmp.innerHTML = html.trim();
  return tmp.firstChild;
}

function toast(txt){
  // minimal non-blocking toast
  const el = document.createElement('div');
  el.textContent = txt;
  el.style.position = 'fixed';
  el.style.right = '18px';
  el.style.bottom = '18px';
  el.style.background = 'rgba(0,0,0,0.6)';
  el.style.color = '#fff';
  el.style.padding = '10px 12px';
  el.style.borderRadius = '8px';
  el.style.zIndex = 9999;
  document.body.appendChild(el);
  setTimeout(()=> el.remove(), 2500);
}

// start download
startBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const quality = qualitySelect.value;
  if(!url){ toast('Enter a video URL'); return; }
  startBtn.disabled = true; startBtn.textContent = 'Starting...';
  try{
    const res = await fetch(apiPath('/api/start'), {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ url, quality })
    });
    const j = await res.json();
    if(j.task_id){
      addTaskToList(j.task_id, url);
      urlInput.value = '';
      loadHistory();
    } else {
      toast('Could not start task');
    }
  } catch(e){
    console.error(e);
    toast('Network error — is backend running?');
  } finally {
    startBtn.disabled = false; startBtn.textContent = 'Start';
  }
});

function addTaskToList(taskId, url){
  const empty = taskList.querySelector('.empty'); if(empty) empty.remove();
  const node = make(`
    <div class="task" id="task-${taskId}">
      <div class="meta">
        <div>
          <div class="title">Task: <span class="tid">${taskId.slice(0,8)}</span></div>
          <div class="small muted url">${url}</div>
        </div>
        <div class="small"><span id="badge-${taskId}" class="badge queued">Queued</span></div>
      </div>
      <div class="progress"><i id="bar-${taskId}"></i></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
        <div class="small" id="msg-${taskId}">Waiting...</div>
        <div style="flex:1"></div>
        <button id="dl-${taskId}" class="btn ghost" style="display:none">Download</button>
        <button id="cancel-${taskId}" class="btn danger">❌ Cancel</button>
      </div>
    </div>
  `);
  taskList.prepend(node);
  pollTask(taskId);
}

async function pollTask(taskId){
  const badge = $(`#badge-${taskId}`);
  const bar = $(`#bar-${taskId}`);
  const msg = $(`#msg-${taskId}`);
  const dlbtn = $(`#dl-${taskId}`);
  const cancelBtn = $(`#cancel-${taskId}`);
  let stopped=false;
  
  cancelBtn.onclick = async () => {
    if (!confirm("Cancel this download?")) return;

    await fetch(apiPath(`/api/cancel/${taskId}`), {
        method: "POST"
    });

    msg.textContent = "Download Cancelled";
    badge.className = "badge err";
    cancelBtn.style.display = "none";
    stopped = true;
};
  while(!stopped){
    try{
      const r = await fetch(apiPath(`/api/status/${taskId}`));
      if(!r.ok){ msg.textContent='Task not found'; badge.className='badge err'; break; }
      const j = await r.json();
      const p = Math.min(100, j.progress || 0);
      bar.style.width = p + '%';
      msg.textContent = (j.status || 'unknown') + (j.title ? ' — ' + j.title : '');
      if(j.status === 'finished'){
        badge.className = 'badge done';
        cancelBtn.style.display = "none";
        dlbtn.style.display = 'inline-block';
        dlbtn.onclick = () => {
          const url = apiPath(`/download/${taskId}`);
          // open download in same origin or via API_BASE
          window.location = url;
        };
        stopped = true;
      } 
    
else if(j.status === 'downloading' || j.status === 'starting'){
         badge.className = "badge down";
}
else if(j.status === 'cancelled'){
    badge.className = 'badge err';
    msg.textContent = 'Download Cancelled';
    cancelBtn.style.display = 'none';
    stopped = true;
}
   
       else if(j.status === 'error'){
        badge.className = 'badge err';
        msg.textContent = 'Error: ' + (j.error || 'unknown');
        cancelBtn.style.display = "none";
        stopped = true;
      } else {
        badge.className = 'badge queued';
      }
    } catch(e){
      console.error(e);
      msg.textContent = 'Network error';
    }
    if(!stopped) await new Promise(r => setTimeout(r, 1500));
  }
}

// history
async function loadHistory(){
  try{
    const r = await fetch(apiPath('/api/history'));
    const data = await r.json();
    historyList.innerHTML = '';
    if(!Array.isArray(data) || data.length===0){
      historyList.innerHTML = `<li class="empty">No history yet</li>`;
      return;
    }
    data.forEach(item=>{
      const li = document.createElement('li');
      li.className = 'history-item';
      const title = item.title || '(unknown)';
      const status = item.status || 'unknown';
      const badge = status === 'finished' ? `<span class="badge done">Finished</span>` :
                    status === 'error' ? `<span class="badge err">Error</span>` :
                    `<span class="badge queued">${status}</span>`;

      li.innerHTML = `<div>
        <div class="title">${escapeHtml(title)}</div>
        <div class="small muted">${item.quality || ''} • ${item.created_at || ''}</div>
      </div>
      <div>
        ${badge}
        ${status === 'finished' ? `<a class="btn ghost small" href="${apiPath('/download/' + item.id)}">Download</a>` : ''}
      </div>`;
      historyList.appendChild(li);
    });
  }catch(e){
    console.error(e);
    historyList.innerHTML = `<li class="empty">Could not load history</li>`;
  }
}

refreshHistoryBtn.addEventListener('click', loadHistory);
clearTasksBtn.addEventListener('click', ()=>{
  document.querySelectorAll('.task').forEach(t=>{
    const badge = t.querySelector('.badge');
    if(badge && badge.className.includes('done')) t.remove();
  });
});
clearHistoryBtn.addEventListener('click', async () => {

  if (!confirm("Do you want to delete all download history?")) {
    return;
  }

  try {
    const response = await fetch('/api/history/clear', {
      method: 'POST'
    });

    const result = await response.json();

    if (result.success) {
      alert("History deleted successfully!");
      loadHistory();
    } else {
      alert("Unable to delete history.");
    }

  } catch (err) {
    alert("Something went wrong.");
    console.error(err);
  }

});

function escapeHtml(s){ if(!s) return ''; return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// theme
const themeToggle = $('#themeToggle');
function setDark(d){
  if(d) document.documentElement.style.setProperty('--card','#0f1724');
  localStorage.setItem('vd_dark', d ? '1' : '0');
}
themeToggle.addEventListener('click', ()=>{
  const cur = localStorage.getItem('vd_dark') === '1';
  setDark(!cur);
  toast('Theme toggled');
});
if(localStorage.getItem('vd_dark') === '1') setDark(true);

loadHistory();
