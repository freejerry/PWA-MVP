/*
 * storage-worker.js
 * 在 Web Worker 內負責所有持久化 I/O。
 *
 * 主路徑：OPFS（Origin Private File System）+ SyncAccessHandle
 *   navigator.storage.getDirectory()
 *     -> getFileHandle('notes.json', { create:true })
 *       -> createSyncAccessHandle()  // 只有在 Worker 內才被多數瀏覽器允許
 *
 * Fallback：偵測到不支援（方法不存在或實際呼叫拋例外）時，改用 IndexedDB。
 *
 * 所有同步 I/O（read/write/truncate/flush/getSize）都只在這個 Worker 裡發生，
 * 主執行緒永遠不做同步 I/O。
 */

const FILE_NAME = 'notes.json';
const enc = new TextEncoder();
const dec = new TextDecoder();

let backend = null; // 'opfs' | 'idb'，由 init() 決定

/* ----------------------------- OPFS 路徑 ----------------------------- */

async function opfsGetFileHandle() {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(FILE_NAME, { create: true });
}

// 嘗試實際開一次 SyncAccessHandle 來確認真的可用（method 存在 ≠ 可用）。
async function opfsProbe() {
  if (!(self.navigator && navigator.storage && navigator.storage.getDirectory)) {
    throw new Error('navigator.storage.getDirectory 不存在');
  }
  if (typeof FileSystemFileHandle === 'undefined' ||
      typeof FileSystemFileHandle.prototype.createSyncAccessHandle !== 'function') {
    throw new Error('createSyncAccessHandle 不存在');
  }
  const fh = await opfsGetFileHandle();
  const handle = await fh.createSyncAccessHandle(); // 不可用時這裡會 throw
  handle.close();
}

function opfsReadAll() {
  // 注意：此函式回傳 Promise（createSyncAccessHandle 為 async），
  // 但檔案 read 本身是同步的。
  return opfsGetFileHandle().then((fh) => fh.createSyncAccessHandle()).then((handle) => {
    try {
      const size = handle.getSize();
      if (size === 0) return [];
      const buf = new ArrayBuffer(size);
      handle.read(buf, { at: 0 });
      const text = dec.decode(buf);
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } finally {
      handle.close();
    }
  });
}

function opfsWriteAll(notes) {
  return opfsGetFileHandle().then((fh) => fh.createSyncAccessHandle()).then((handle) => {
    try {
      const bytes = enc.encode(JSON.stringify(notes));
      handle.truncate(0);
      handle.write(bytes, { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
  });
}

/* --------------------------- IndexedDB 路徑 -------------------------- */

const IDB_NAME = 'notes-poc-db';
const IDB_STORE = 'kv';
const IDB_KEY = 'notes';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReadAll() {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  }));
}

function idbWriteAll(notes) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(notes, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

/* ------------------------------ 統一 API ----------------------------- */

const readAll = () => (backend === 'opfs' ? opfsReadAll() : idbReadAll());
const writeAll = (notes) => (backend === 'opfs' ? opfsWriteAll(notes) : idbWriteAll(notes));

async function init() {
  try {
    await opfsProbe();
    backend = 'opfs';
  } catch (e) {
    backend = 'idb';
    return { backend, sahError: String(e && e.message || e) };
  }
  return { backend, sahError: null };
}

async function addNote(text) {
  const notes = await readAll();
  const note = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), text, ts: Date.now() };
  notes.push(note);
  await writeAll(notes);
  return notes;
}

async function clearAll() {
  await writeAll([]);
  return [];
}

/* ----------------------------- 訊息橋接 ------------------------------ */

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data || {};
  try {
    let result;
    switch (type) {
      case 'init':    result = await init(); break;
      case 'getAll':  result = await readAll(); break;
      case 'add':     result = await addNote(payload.text); break;
      case 'clear':   result = await clearAll(); break;
      default: throw new Error('未知訊息類型: ' + type);
    }
    self.postMessage({ id, ok: true, result, backend });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err), backend });
  }
};
