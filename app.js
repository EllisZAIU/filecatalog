'use strict';

let API = '';

let state = {
  q:        '',
  volumeId: '',
  page:     1,
  limit:    50,
  total:    0,
};

// ── Format file size ──────────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1)    + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(0)       + ' KB';
  return bytes + ' B';
}

// ── Build explorer path ───────────────────────────────────────────────────────
function explorerPath(row) {
  const p   = row.display_path || row.path;
  const sep = p.includes('\\') ? '\\' : '/';
  return p.substring(0, p.lastIndexOf(sep));
}

function openExplorer(row) {
  const dir = explorerPath(row);
  const uri = 'file:///' + dir.replace(/\\/g, '/');
  window.open(uri, '_blank');
}

function copyPath(row) {
  const dir = explorerPath(row);
  try {
    const ta = document.createElement('textarea');
    ta.value = dir;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    setStatus('📋 path copied to clipboard');
    setTimeout(() => setStatus(''), 2000);
  } catch {
    setStatus('<span class="err">clipboard access denied</span>');
  }
}

// ── Load volumes ──────────────────────────────────────────────────────────────
async function loadVolumes() {
  try {
    const res  = await fetch(`${API}/volumes`);
    const rows = await res.json();
    const sel  = document.getElementById('volumeSelect');

    // Clear existing options except "all volumes"
    while (sel.options.length > 1) sel.remove(1);

    rows.forEach(v => {
      const opt       = document.createElement('option');
      opt.value       = v.volume_id;
      opt.textContent = v.volume_name;
      sel.appendChild(opt);
    });

    document.getElementById('hdr-stats').textContent =
      `${rows.length} volume${rows.length !== 1 ? 's' : ''} indexed`;
  } catch {
    document.getElementById('hdr-stats').textContent = 'cannot reach API';
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
async function doSearch(page = 1) {
  const q        = document.getElementById('searchInput').value.trim() || state.q;
  const volumeId = document.getElementById('volumeSelect').value;

  if (q.length < 1) {
    setStatus('<span class="err">enter a search term or * for all files</span>');
    return;
  }

  state = { ...state, q, volumeId, page };

  document.getElementById('searchInput').value = '';
  setStatus('searching...');
  document.getElementById('searchBtn').disabled = true;

  try {
    const params = new URLSearchParams({
      q,
      page,
      limit:      state.limit,
      field:      document.getElementById('searchField').value,
      file_type:  document.getElementById('fileType').value,
      ...(volumeId ? { volume_id: volumeId } : {}),
      ...(page > 1 ? { known_total: state.total } : {}),
    });

    const res  = await fetch(`${API}/search?${params}`);
    const data = await res.json();

    state.total = data.total ?? 0;
    renderTable(data.results);
    renderPagination();

    const from = (page - 1) * state.limit + 1;
    const to   = Math.min(page * state.limit, state.total);

    setStatus(state.total === 0
      ? 'no results'
      : `showing <span class="count">${from}–${to}</span> of <span class="count">${state.total.toLocaleString()}</span> results`
    );
  } catch (err) {
    setStatus(`<span class="err">API error: ${err.message}</span>`);
    document.getElementById('tableWrap').innerHTML = '<div class="empty">could not reach server</div>';
  } finally {
    document.getElementById('searchBtn').disabled = false;
  }
}

// ── Render table ──────────────────────────────────────────────────────────────
function renderTable(rows) {
  const wrap = document.getElementById('tableWrap');

  if (!rows || rows.length === 0) {
    wrap.innerHTML = '<div class="empty">no results found</div>';
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th>Filename</th>
          <th>Path</th>
          <th>Volume</th>
          <th style="text-align:right">Size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row, i) => {
          window._rows = window._rows || [];
          window._rows[i] = row;
          const dir      = explorerPath(row);
          const isOnline = row.root_path && row.root_path.length > 0;
          return `
          <tr>
            <td class="td-filename" title="${esc(row.filename)}">${esc(row.filename)}</td>
            <td class="td-path" title="${esc(row.path)}">${esc(dir)}</td>
            <td class="td-volume">${esc(row.volume_name)}</td>
            <td class="td-size">${fmtSize(row.file_size)}</td>
            <td class="td-action">
              ${isOnline
                ? `<button class="btn-open" onclick="openExplorer(window._rows[${i}])">📁 open</button>
                   <button class="btn-open" onclick="copyPath(window._rows[${i}])">📋 copy</button>`
                : `<span class="badge-offline">OFFLINE</span>`
              }
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  window._rows = rows;
  wrap.innerHTML = html;
  makeFirstColumnResizable();
}

// ── Pagination ────────────────────────────────────────────────────────────────
function renderPagination() {
  const totalPages = Math.ceil(state.total / state.limit);
  const pg         = document.getElementById('pagination');

  if (totalPages <= 1) { pg.innerHTML = ''; return; }

  pg.innerHTML = `
    <button onclick="doSearch(${state.page - 1})" ${state.page <= 1 ? 'disabled' : ''}>← prev</button>
    <span>page ${state.page} of ${totalPages}</span>
    <button onclick="doSearch(${state.page + 1})" ${state.page >= totalPages ? 'disabled' : ''}>next →</button>
  `;
}

// ── Resizable first column ────────────────────────────────────────────────────
function makeFirstColumnResizable() {
  const table = document.querySelector('table');
  if (!table) return;

  const th = table.querySelector('thead th:first-child');
  if (!th) return;

  const handle = document.createElement('div');
  handle.style.cssText = `
    position: absolute; right: 0; top: 0; bottom: 0;
    width: 6px; cursor: col-resize;
    background: transparent;
  `;
  th.style.position = 'relative';
  th.appendChild(handle);

  let startX, startWidth;

  handle.addEventListener('mousedown', e => {
    startX     = e.clientX;
    startWidth = th.offsetWidth;
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = e => {
      const newWidth = Math.max(80, startWidth + (e.clientX - startX));
      table.querySelectorAll('tr td:first-child, tr th:first-child').forEach(cell => {
        cell.style.width    = newWidth + 'px';
        cell.style.maxWidth = newWidth + 'px';
      });
    };

    const onUp = () => {
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(html) {
  document.getElementById('status').innerHTML = html;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Event wiring ──────────────────────────────────────────────────────────────
document.getElementById('searchBtn').addEventListener('click', () => doSearch(1));
document.getElementById('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch(1);
});

// ── Scan modal ────────────────────────────────────────────────────────────────
let selectedScanPath = null;
let pollInterval     = null;

async function browseTo(dirPath) {
  const browser = document.getElementById('browser');
  browser.innerHTML = '<div class="empty">loading...</div>';

  try {
    const res  = await fetch(`${API}/browse?path=${encodeURIComponent(dirPath)}`);
    const data = await res.json();

    if (data.error) {
      browser.innerHTML = `<div class="empty">${esc(data.error)}</div>`;
      return;
    }

    document.getElementById('browserPath').textContent = data.current;
    selectedScanPath = data.current;

    let html = '';

    if (data.current !== data.parent) {
      html += `<div class="browser-item up" onclick="browseTo('${esc(data.parent)}')">
                 <span class="icon">↑</span> ..
               </div>`;
    }

    if (data.dirs.length === 0) {
      html += '<div class="empty" style="padding:1rem">no subdirectories</div>';
    } else {
      data.dirs.forEach(d => {
        html += `<div class="browser-item" onclick="browseTo('${esc(d.path)}')">
                   <span class="icon">📁</span> ${esc(d.name)}
                 </div>`;
      });
    }

    browser.innerHTML = html;
  } catch (err) {
    browser.innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`;
  }
}

function openScanModal() {
  document.getElementById('scanModal').classList.add('active');
  document.getElementById('scanVolume').value  = '';
  document.getElementById('scanUncPath').value = '';
  document.getElementById('progressWrap').classList.remove('active');
  document.getElementById('modalActions').style.display = 'flex';
  document.getElementById('cancelBtn').textContent = 'CANCEL';
  document.getElementById('startScanBtn').disabled = false;
  browseTo('/mnt');
}

function closeScanModal() {
  document.getElementById('scanModal').classList.remove('active');
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function startScan() {
  const volume = document.getElementById('scanVolume').value.trim();
  if (!volume)          { alert('Please enter a volume name.'); return; }
  if (!selectedScanPath){ alert('Please select a path.'); return; }

  document.getElementById('startScanBtn').disabled = true;
  document.getElementById('progressWrap').classList.add('active');
  document.getElementById('progressLabel').textContent  = 'Starting scan...';
  document.getElementById('progressCurrent').textContent = '';
  document.getElementById('progressBar').style.width   = '0%';
  document.getElementById('progressBar').style.opacity = '1';

  try {
    const res  = await fetch(`${API}/scan`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        path:    selectedScanPath,
        volume,
        uncPath: document.getElementById('scanUncPath').value.trim(),
      }),
    });
    const { jobId, error } = await res.json();
    if (error) { alert(`Error: ${error}`); return; }

    pollInterval = setInterval(async () => {
      const pRes = await fetch(`${API}/scan/${jobId}`);
      const job  = await pRes.json();

      if (job.status === 'running') {
        document.getElementById('progressLabel').textContent =
          `Cataloging... ${job.files.toLocaleString()} files`;
        document.getElementById('progressCurrent').textContent = job.current || '';
        // Pulse opacity on full-width bar
        document.getElementById('progressBar').style.width   = '100%';
        document.getElementById('progressBar').style.opacity =
          String((Math.sin(Date.now() / 400) + 1) / 2 * 0.7 + 0.3);

      } else if (job.status === 'done') {
        clearInterval(pollInterval);
        pollInterval = null;
        document.getElementById('progressBar').style.width   = '100%';
        document.getElementById('progressBar').style.opacity = '1';
        document.getElementById('progressLabel').textContent =
          `Done — ${job.files.toLocaleString()} files (${(job.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB)` +
          (job.dsRemoved > 0 ? ` · ${job.dsRemoved} .DS_Store removed` : '');
        document.getElementById('progressCurrent').textContent = '';
        document.getElementById('cancelBtn').textContent = 'CLOSE';
        await loadVolumes();

      } else if (job.status === 'error') {
        clearInterval(pollInterval);
        document.getElementById('progressLabel').textContent = `Error: ${job.error}`;
        document.getElementById('cancelBtn').textContent = 'CLOSE';
      }
    }, 1000);

  } catch (err) {
    alert(`Failed to start scan: ${err.message}`);
    document.getElementById('startScanBtn').disabled = false;
  }
}

document.getElementById('scanBtn').addEventListener('click', openScanModal);
document.getElementById('cancelBtn').addEventListener('click', closeScanModal);
document.getElementById('startScanBtn').addEventListener('click', startScan);
document.getElementById('scanModal').addEventListener('click', e => {
  if (e.target === document.getElementById('scanModal')) closeScanModal();
});

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('paneScan').style.display   = tab === 'scan'   ? 'block' : 'none';
  document.getElementById('paneDelete').style.display = tab === 'delete' ? 'block' : 'none';
  document.getElementById('tabScan').classList.toggle('active',   tab === 'scan');
  document.getElementById('tabDelete').classList.toggle('active', tab === 'delete');

  if (tab === 'delete') populateDeleteDropdown();
}

// ── Delete volume ─────────────────────────────────────────────────────────────
function populateDeleteDropdown() {
  const src = document.getElementById('volumeSelect');
  const dst = document.getElementById('deleteVolumeSelect');

  while (dst.options.length > 1) dst.remove(1);

  Array.from(src.options).forEach(opt => {
    if (!opt.value) return;
    const o = document.createElement('option');
    o.value       = opt.value;
    o.textContent = opt.textContent;
    dst.appendChild(o);
  });

  document.getElementById('deleteConfirm').style.display = 'none';
  document.getElementById('deleteConfirmInput').value    = '';
  document.getElementById('deleteBtn').disabled          = true;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('deleteVolumeSelect').addEventListener('change', function() {
    const confirm = document.getElementById('deleteConfirm');
    const input   = document.getElementById('deleteConfirmInput');
    const btn     = document.getElementById('deleteBtn');

    if (this.value) {
      const name = this.options[this.selectedIndex].textContent;
      confirm.style.display = 'block';
      input.placeholder     = name;
      input.value           = '';
      btn.disabled          = true;
    } else {
      confirm.style.display = 'none';
      btn.disabled          = true;
    }
  });

  document.getElementById('deleteConfirmInput').addEventListener('input', function() {
    const sel      = document.getElementById('deleteVolumeSelect');
    const expected = sel.options[sel.selectedIndex]?.textContent || '';
    document.getElementById('deleteBtn').disabled = this.value.trim() !== expected;
  });
});

async function deleteVolume() {
  const sel      = document.getElementById('deleteVolumeSelect');
  const volumeId = sel.value;
  const name     = sel.options[sel.selectedIndex].textContent;

  if (!volumeId) return;

  try {
    document.getElementById('deleteBtn').disabled = true;
    const res  = await fetch(`${API}/volumes/${volumeId}`, { method: 'DELETE' });
    const data = await res.json();

    if (data.error) {
      alert(`Error: ${data.error}`);
      return;
    }

    await loadVolumes();
    closeScanModal();
    setStatus(`🗑 Volume "${name}" deleted.`);
    setTimeout(() => setStatus(''), 3000);

  } catch (err) {
    alert(`Delete failed: ${err.message}`);
    document.getElementById('deleteBtn').disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const res    = await fetch('/api/config');
  const config = await res.json();
  API = config.apiBase + '/api';
  loadVolumes();
}

init();
