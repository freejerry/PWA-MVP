/*
 * sw.js — Service Worker
 *  - install：預快取整個 app shell（HTML / JS / manifest / icons）。
 *  - fetch：cache-first，確保關掉網路後仍能冷啟動並開啟整個 app。
 *
 * 注意：所有路徑都相對於 SW 所在目錄，方便部署在 GitHub Pages 的子路徑
 *      （例如 https://user.github.io/repo/）。
 */

const CACHE = 'notes-poc-v1';

// 相對於 sw.js 位置解析，確保子路徑部署也正確。
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './storage-worker.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
].map((p) => new URL(p, self.location).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 導覽請求（開啟 app）：cache-first，離線時退回快取的 index.html。
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).catch(() => caches.match(new URL('./index.html', self.location).toString()))
      )
    );
    return;
  }

  // 其餘資源：cache-first，命中即回；未命中則抓網路並順手寫入快取。
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
