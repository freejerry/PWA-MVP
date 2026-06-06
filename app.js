/*
 * app.js — 主執行緒：UI、Service Worker 註冊、與 storage-worker 的橋接、狀態面板。
 * 主執行緒不做任何同步 I/O；所有 OPFS/IndexedDB 操作都丟給 Worker。
 */

const $ = (id) => document.getElementById(id);

function log(msg) {
  const t = new Date().toLocaleTimeString();
  const el = $('log');
  el.textContent += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

/* --------------------- 與 storage-worker 的請求/回應橋接 -------------------- */

const worker = new Worker('./storage-worker.js');
const pending = new Map();
let seq = 0;
let backend = null;

worker.onmessage = (ev) => {
  const { id, ok, result, error, backend: be } = ev.data || {};
  if (be) backend = be;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error));
};
worker.onerror = (e) => log('Worker 錯誤: ' + (e.message || e));

function call(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

/* ------------------------------- 記事 UI -------------------------------- */

let allNotes = []; // 含 tombstone 的完整本機快取

function visibleNotes(notes) {
  return (notes || []).filter((n) => !n.deleted);
}

function render(notes) {
  allNotes = notes || [];
  const shown = visibleNotes(allNotes);
  const ul = $('notes');
  ul.innerHTML = '';
  $('count').textContent = String(shown.length);
  $('notes-empty').style.display = shown.length ? 'none' : '';
  // 新的在上面
  for (const n of [...shown].reverse()) {
    const li = document.createElement('li');
    li.style.display = 'flex';
    li.style.justifyContent = 'space-between';
    li.style.gap = '8px';

    const body = document.createElement('div');
    body.style.flex = '1';
    const text = document.createElement('div');
    text.className = 'note-text';
    text.textContent = n.text;
    const meta = document.createElement('div');
    meta.className = 'note-meta';
    meta.textContent = new Date(n.ts).toLocaleString();
    body.append(text, meta);

    const del = document.createElement('button');
    del.className = 'secondary';
    del.textContent = '刪除';
    del.style.alignSelf = 'flex-start';
    del.addEventListener('click', () => deleteNote(n.id));

    li.append(body, del);
    ul.appendChild(li);
  }
}

async function deleteNote(id) {
  try {
    const notes = await call('delete', { id });
    render(notes);
    log('已刪除（tombstone）一筆記事');
    refreshEstimate();
    autoSyncSoon();
  } catch (e) {
    log('刪除失敗: ' + e.message);
  }
}

async function loadNotes() {
  try {
    const notes = await call('getAll');
    render(notes);
    log(`讀回 ${notes.length} 筆記事（後端：${backend}）`);
  } catch (e) {
    log('讀取失敗: ' + e.message);
  }
}

async function saveNote() {
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  $('save').disabled = true;
  try {
    const notes = await call('add', { text });
    render(notes);
    input.value = '';
    log(`已新增記事，目前共 ${visibleNotes(notes).length} 筆`);
    refreshEstimate();
    autoSyncSoon();
  } catch (e) {
    log('儲存失敗: ' + e.message);
  } finally {
    $('save').disabled = false;
  }
}

async function clearAll() {
  if (!confirm('確定要清空全部記事？')) return;
  try {
    const notes = await call('clear');
    render(notes);
    log('已清空全部記事');
    refreshEstimate();
  } catch (e) {
    log('清空失敗: ' + e.message);
  }
}

/* ----------------------------- 狀態面板 ------------------------------ */

function pill(el, text, cls) {
  el.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'pill' + (cls ? ' ' + cls : '');
  span.textContent = text;
  el.appendChild(span);
}

function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]} (${n.toLocaleString()} bytes)`;
}

function showBackend() {
  if (backend === 'opfs') pill($('backend'), 'OPFS + SyncAccessHandle', 'opfs');
  else if (backend === 'idb') pill($('backend'), 'IndexedDB（fallback）', 'idb');
  else pill($('backend'), '偵測中…');
}

async function refreshEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      $('usage').textContent = fmtBytes(usage);
      $('quota').textContent = fmtBytes(quota);
    } else {
      $('usage').textContent = $('quota').textContent = '不支援 estimate()';
    }
  } catch (e) {
    log('estimate() 失敗: ' + e.message);
  }
}

async function refreshPersisted() {
  try {
    if (navigator.storage && navigator.storage.persisted) {
      const p = await navigator.storage.persisted();
      pill($('persisted'), p ? 'true（已持久化）' : 'false（best-effort）', p ? 'ok' : 'no');
    } else {
      pill($('persisted'), '不支援 persisted()', 'no');
    }
  } catch (e) {
    log('persisted() 失敗: ' + e.message);
  }
}

async function requestPersist() {
  $('persist').disabled = true;
  try {
    if (!(navigator.storage && navigator.storage.persist)) {
      $('persist-result').textContent = '此平台不支援 navigator.storage.persist()';
      log('persist() 不支援');
      return;
    }
    const granted = await navigator.storage.persist();
    $('persist-result').textContent = granted
      ? 'true — 已授予 persistent storage'
      : 'false — 未授予（仍為 best-effort，可能被驅逐）';
    log('persist() 回傳：' + granted);
    refreshPersisted();
  } catch (e) {
    $('persist-result').textContent = '錯誤：' + e.message;
    log('persist() 失敗: ' + e.message);
  } finally {
    $('persist').disabled = false;
  }
}

function refreshStatus() {
  showBackend();
  refreshEstimate();
  refreshPersisted();
}

/* ------------------------------ 網路狀態 ------------------------------ */

function showNet() {
  const online = navigator.onLine;
  pill($('net-badge'), online ? '線上' : '離線', online ? 'ok' : 'no');
}
window.addEventListener('online', () => { showNet(); log('網路：線上'); });
window.addEventListener('offline', () => { showNet(); log('網路：離線'); });

/* --------------------------- Service Worker --------------------------- */

function registerSW() {
  if (!('serviceWorker' in navigator)) { log('此平台不支援 Service Worker'); return; }
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => log('Service Worker 已註冊（scope: ' + reg.scope + '）'))
    .catch((e) => log('Service Worker 註冊失敗: ' + e.message));
}

/* ----------------------------- 跨裝置同步 ----------------------------- */
/*
 * vanilla union-merge：本機（OPFS/IDB）當快取，Cloudflare Worker + KV 當匯流點。
 * 一次 POST 同時完成 push+pull：把本機資料送上去，伺服器 union-merge 後回傳完整集合，
 * 再寫回本機。記事 append-only + tombstone，依 id 取聯集、deleted 勝出 → 天然無衝突。
 */

const LS = {
  url: 'sync.url',
  code: 'sync.code',
  enabled: 'sync.enabled',
};

const sync = {
  get url() { return (localStorage.getItem(LS.url) || '').trim(); },
  get code() { return (localStorage.getItem(LS.code) || '').trim(); },
  get enabled() { return localStorage.getItem(LS.enabled) === '1'; },
  set enabled(v) { localStorage.setItem(LS.enabled, v ? '1' : '0'); },
  inFlight: false,
  timer: null,
  rev: null,
};

// 與後端相同的合併規則（防禦性：即使後端沒合好，本機也不會壞）。
function mergeNotes(a, b) {
  const map = new Map();
  for (const n of [...(a || []), ...(b || [])]) {
    if (!n || !n.id) continue;
    const ex = map.get(n.id);
    if (!ex) { map.set(n.id, { ...n }); continue; }
    map.set(n.id, {
      ...ex, ...n,
      ts: ex.ts || n.ts,
      text: ex.text != null ? ex.text : n.text,
      deleted: Boolean(ex.deleted || n.deleted),
      updated: Math.max(ex.updated || ex.ts || 0, n.updated || n.ts || 0),
    });
  }
  return [...map.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
}

function buildSyncUrl() {
  const base = sync.url;
  if (!base) throw new Error('未設定同步 API 網址');
  if (!sync.code) throw new Error('未設定同步碼');
  const u = new URL(base);
  u.searchParams.set('code', sync.code);
  return u.toString();
}

function setSyncState(text, cls) { pill($('sync-state'), text, cls); }

async function syncNow(reason) {
  if (!sync.enabled) return;
  if (!sync.url || !sync.code) { setSyncState('缺少網址或同步碼', 'no'); return; }
  if (!navigator.onLine) { setSyncState('離線，已排入待同步', 'idb'); return; }
  if (sync.inFlight) return; // 避免重入
  sync.inFlight = true;
  setSyncState('同步中…' + (reason ? '（' + reason + '）' : ''));
  try {
    const local = await call('getAll');
    const res = await fetch(buildSyncUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: local }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const merged = mergeNotes(local, data.notes || []);
    // 只有在內容真的不同時才寫回本機，避免無謂 I/O。
    if (JSON.stringify(merged) !== JSON.stringify(local)) {
      await call('setAll', { notes: merged });
      render(merged);
      refreshEstimate();
    }
    sync.rev = data.rev;
    $('sync-rev').textContent = data.rev != null ? String(data.rev) : '—';
    $('sync-last').textContent = new Date().toLocaleString();
    setSyncState('已同步', 'ok');
    log(`同步成功（${reason || '手動'}），rev=${data.rev}，共 ${visibleNotes(merged).length} 筆`);
  } catch (e) {
    setSyncState('同步失敗', 'no');
    log('同步失敗: ' + e.message);
  } finally {
    sync.inFlight = false;
  }
}

let syncDebounce = null;
function autoSyncSoon() {
  if (!sync.enabled) return;
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => syncNow('變更'), 800); // debounce 連續輸入
}

function applySyncUiFromStorage() {
  $('sync-url').value = sync.url;
  $('sync-code').value = sync.code;
  $('sync-toggle').textContent = sync.enabled ? '停用自動同步' : '啟用自動同步';
  setSyncState(sync.enabled ? '已啟用' : '未啟用', sync.enabled ? 'ok' : null);
}

function wireSyncUi() {
  $('sync-url').addEventListener('change', () => localStorage.setItem(LS.url, $('sync-url').value.trim()));
  $('sync-code').addEventListener('change', () => localStorage.setItem(LS.code, $('sync-code').value.trim()));
  $('sync-toggle').addEventListener('click', () => {
    // 切換前先存好輸入框內容
    localStorage.setItem(LS.url, $('sync-url').value.trim());
    localStorage.setItem(LS.code, $('sync-code').value.trim());
    sync.enabled = !sync.enabled;
    applySyncUiFromStorage();
    if (sync.enabled) { log('已啟用自動同步'); syncNow('啟用'); }
    else log('已停用自動同步');
  });
  $('sync-now').addEventListener('click', () => {
    localStorage.setItem(LS.url, $('sync-url').value.trim());
    localStorage.setItem(LS.code, $('sync-code').value.trim());
    if (!sync.enabled) { sync.enabled = true; applySyncUiFromStorage(); }
    syncNow('手動');
  });

  // 回到前景 / 上線時自動 pull —— iOS standalone app 會被凍結，resume 時很重要。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow('回前景');
  });
  window.addEventListener('pageshow', () => syncNow('pageshow'));
  window.addEventListener('online', () => syncNow('上線'));
}

/* -------------------------------- 啟動 -------------------------------- */

async function boot() {
  showNet();
  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  log('啟動。display 模式：' + (standalone ? 'standalone（已安裝）' : 'browser（瀏覽器分頁）'));

  registerSW();

  try {
    const info = await call('init');
    backend = info.backend;
    showBackend();
    $('sah').textContent = info.backend === 'opfs'
      ? '可用（OPFS 主路徑）'
      : '不可用 → fallback IndexedDB' + (info.sahError ? '（' + info.sahError + '）' : '');
    log('儲存後端：' + backend + (info.sahError ? '；OPFS 探測訊息：' + info.sahError : ''));
  } catch (e) {
    log('Worker 初始化失敗: ' + e.message);
    $('sah').textContent = '初始化失敗：' + e.message;
  }

  await loadNotes();
  refreshStatus();

  $('save').addEventListener('click', saveNote);
  $('reload').addEventListener('click', loadNotes);
  $('clear').addEventListener('click', clearAll);
  $('persist').addEventListener('click', requestPersist);
  $('refresh-status').addEventListener('click', refreshStatus);
  // Ctrl/Cmd+Enter 快速儲存
  $('input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveNote();
  });

  // 同步：載入設定、接線、若已啟用則開機同步一次
  applySyncUiFromStorage();
  wireSyncUi();
  if (sync.enabled) syncNow('開機');
}

boot();
