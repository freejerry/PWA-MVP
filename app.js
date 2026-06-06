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

function render(notes) {
  const ul = $('notes');
  ul.innerHTML = '';
  $('count').textContent = String(notes.length);
  $('notes-empty').style.display = notes.length ? 'none' : '';
  // 新的在上面
  for (const n of [...notes].reverse()) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'note-text';
    text.textContent = n.text;
    const meta = document.createElement('div');
    meta.className = 'note-meta';
    meta.textContent = new Date(n.ts).toLocaleString();
    li.append(text, meta);
    ul.appendChild(li);
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
    log(`已新增記事，目前共 ${notes.length} 筆`);
    refreshEstimate();
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
}

boot();
