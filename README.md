# 離線記事 PWA — 離線持久化最小可行性驗證（PoC）

驗證一個純前端、純靜態的跨平台 PWA 能否：可安裝到主畫面、離線冷啟動、用
**OPFS（Origin Private File System）+ SyncAccessHandle** 持久化資料，並在不支援時
**自動 fallback 到 IndexedDB**；同時把 `navigator.storage` 的
`persist() / persisted() / estimate()` 行為攤開來實測。

> ⚠️ **誠實聲明**：本專案在一個沒有實體行動裝置與瀏覽器的環境中產出。
> 所有「程式碼層面」的正確性我已做靜態檢查（見最後），但下方驗收表中標記
> **「待裝置實測」** 的項目，我**沒有**在真實 iOS / Android 上跑過。
> 表內「預期」欄是依據各平台已知行為（知識截止 2026-01）所做的推測，
> 你必須在真機上勾選確認，尤其是 **iOS 的 7 天驅逐** 這種需要等時間才能觀察的項目。

---

## 1. 檔案結構

```
.
├── index.html          # 單頁 UI（含 iOS standalone meta 標籤、inline CSS）
├── app.js              # 主執行緒：UI、SW 註冊、與 worker 橋接、狀態面板。不做同步 I/O
├── storage-worker.js   # Web Worker：OPFS SyncAccessHandle 主路徑 + IndexedDB fallback
├── sw.js               # Service Worker：install 預快取 app shell、fetch cache-first
├── manifest.json       # name / icons / display:standalone / start_url / theme_color
├── icons/
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── maskable-512.png
│   └── gen_icons.py    # 產生上面 PNG 的腳本（部署不需要）
└── README.md
```

## 2. 核心設計

### 2.1 持久化主路徑：OPFS + SyncAccessHandle（在 Worker 內）
- 主執行緒透過 `postMessage` 把 `init / getAll / add / clear` 丟給 `storage-worker.js`，
  以 request-id 配對回應（`app.js` 的 `call()`），主執行緒**完全不做同步 I/O**。
- Worker 內：
  ```
  navigator.storage.getDirectory()
    → getFileHandle('notes.json', { create:true })
      → createSyncAccessHandle()
        → getSize() / read() / truncate() / write() / flush() / close()
  ```
  記事以 **單一 JSON 檔** `notes.json` 存放（陣列）。每次寫入：`truncate(0)` →
  `write(at:0)` → `flush()` → `close()`，避免殘留舊內容、確保落盤。

### 2.2 Fallback：IndexedDB
- Worker `init()` 會**實際嘗試開一次** `createSyncAccessHandle()`（而非只看方法存不存在），
  因為某些瀏覽器「方法存在但呼叫會丟例外」。探測失敗即切到 IndexedDB
  （`notes-poc-db` → object store `kv` → key `notes` 存同一個陣列）。
- UI 狀態面板的「儲存後端」會明確顯示目前用的是 **OPFS** 還是 **IndexedDB（fallback）**，
  並把 OPFS 探測失敗訊息記到事件記錄。

### 2.3 離線可開：Service Worker
- `install`：`cache.addAll(APP_SHELL)` 預快取 HTML / JS / manifest / icons。
- `fetch`：**cache-first**。導覽請求離線時退回快取的 `index.html`，確保飛航模式冷啟動可開。
- 所有路徑都用 `new URL('./x', self.location)` 相對解析，**可直接部署到 GitHub Pages 子路徑**。

### 2.4 安裝 / standalone
- `manifest.json`：`display:standalone`、相對 `start_url:"./"`、`scope:"./"`、icons 192/512 + maskable。
- iOS 另外靠 `index.html` 的 `apple-mobile-web-app-capable` / `apple-mobile-web-app-status-bar-style`
  / `apple-touch-icon` 才能以 standalone 隱藏網址列。

---

## 3. 部署到 GitHub Pages 並在手機上測試

PWA 需要 **HTTPS**（`localhost` 例外）。GitHub Pages 免費提供 HTTPS，最省事。

### 3.1 部署
1. 把本專案推到 GitHub repo（本 PoC 分支：`claude/pwa-offline-persistence-poc-zo10I`）。
   正式測試建議合併到 `main` 或你要發佈的分支。
2. GitHub repo → **Settings → Pages**。
3. **Build and deployment → Source** 選 **Deploy from a branch**。
4. 選分支（例如 `main`）與資料夾 **`/ (root)`**，按 **Save**。
5. 等 1～2 分鐘，頁面會顯示網址，形如：
   `https://<你的帳號>.github.io/<repo 名>/`
6. 用該 **https** 網址打開（本 PoC 用相對路徑，子路徑可正常運作）。

> Cloudflare Pages 也可：connect repo、build command 留空、output 目錄填 `/`（純靜態，免建置）。

### 3.2 在手機上測試
**Android（Chrome）**
1. 用 Chrome 開上面的 https 網址。
2. 右上選單 →「**安裝應用程式 / 加到主畫面**」（或網址列出現安裝提示）。
3. 從主畫面圖示開啟 → 應為 standalone（無網址列）。
4. 開飛航模式 → 從主畫面重新冷啟動 → app 應可開。
5. 新增幾筆記事 → 從最近 app 列表**完全關閉** → 重開 → 記事應仍在。
6. 狀態面板按「請求持久化」，記錄 `persist()` 結果與 `persisted()`。

**iOS（Safari）**
1. 用 **Safari**（不是其他瀏覽器）開該 https 網址。
2. 分享鈕 →「**加入主畫面**」→ 確認 icon / 名稱 → 加入。
3. 從主畫面圖示開啟 → 應為 standalone（無網址列）。
4. 飛航模式冷啟動測試、新增→完全關閉→重開測試，同上。
5. **驅逐測試**：記錄今天日期，之後**不要開這個網站**，過 7 天以上再開主畫面 app，
   看記事是否還在（這是 iOS 最大的風險點，必須等時間驗證）。

### 3.3 本機快速測試（選用）
```bash
# 任一靜態伺服器即可（PWA 在 localhost 不需要 HTTPS）
python3 -m http.server 8000
# 開 http://localhost:8000
# 手機與電腦同網段時，亦可用電腦區網 IP，但 SW/OPFS 在非 localhost 的 http 不會啟用 → 仍建議用 GitHub Pages 做真機測試
```
Chrome DevTools → Application 分頁可檢視 Manifest、Service Workers、Storage（含 OPFS）。

---

## 4. 驗收實測表

> 勾選規則：`[x]` = 我已在該平台實測通過；`[ ]` = **待裝置實測**。
> 「預期」是依平台已知行為的推測，請你在真機上覆核。

| 驗收項目 | Android (Chrome) | iOS (Safari) | 預期 / 備註 |
|---|---|---|---|
| 可加入主畫面 / 安裝，icon 與名稱正確 | [ ] 待測 | [ ] 待測 | 兩者預期可。Android 有原生安裝提示；iOS 須用「分享→加入主畫面」 |
| 以 standalone 開啟，無瀏覽器網址列 | [ ] 待測 | [ ] 待測 | 兩者預期可（manifest `display:standalone` + iOS apple meta 標籤已備） |
| 飛航模式（離線）下可冷啟動並開啟 app | [ ] 待測 | [ ] 待測 | 兩者預期可（SW 預快取 + cache-first） |
| 新增記事後，完全關閉 app 再重開，記事仍在 | [ ] 待測 | [ ] 待測 | 短期內兩者預期可。iOS 長期受 7 天驅逐影響（見下） |
| `persist()` 回傳結果與 `persisted()` 狀態 | [ ] 待測 | [ ] 待測 | Android：安裝後/高互動常為 `true`。iOS：常為 `false`（見下） |
| `estimate()` 的 usage/quota 能正確顯示 | [ ] 待測 | [ ] 待測 | 兩者預期可顯示數值；iOS quota 通常較保守 |

填寫範例（請替換成你的真機結果）：

```
裝置：Pixel 8 / Android 15 / Chrome 1xx
- 安裝：OK，icon/名稱正確
- standalone：OK，無網址列
- 離線冷啟動：OK
- 關閉重開記事：OK（後端顯示 OPFS）
- persist()：true；persisted()：true
- estimate：usage ~xx KB / quota ~xx GB

裝置：iPhone 1x / iOS 1x.x / Safari
- ...
```

---

## 5. 需要回報的觀察（依目前平台知識，待真機覆核）

### 5.1 各平台是否支援 OPFS SyncAccessHandle / 是否 fallback
- **Android Chrome / 桌面 Chrome、Edge**：支援 OPFS 與 Worker 內 `createSyncAccessHandle`。**預期走 OPFS 主路徑，不 fallback**。
- **Firefox（桌面/Android）**：較新版本支援 Worker 內 SyncAccessHandle，預期走 OPFS。
- **iOS / iPadOS Safari 16.4+**：支援 OPFS 與 Worker 內 SyncAccessHandle，預期走 OPFS。
  - ⚠️ **已知風險**：早期 Safari 實作的 `read/write/truncate/getSize` 介面與後來定案的規格曾有差異
    （早期版本部分方法回傳 Promise、或參數形式不同）。若在較舊 iOS 上 `init()` 探測拋例外，
    本 PoC 會**自動 fallback 到 IndexedDB**，UI 會顯示 fallback 及錯誤訊息——這正是設計來吸收這類差異的安全網。
- **舊版 / WebView / 第三方 iOS 瀏覽器**：iOS 上所有瀏覽器底層都是 WebKit；非 Safari 的 app 內瀏覽器可能不支援 standalone 安裝，OPFS 行為以 WebKit 版本為準。

> 實測時請看狀態面板「儲存後端」與「SyncAccessHandle」兩列，以及事件記錄裡的探測訊息，據此填表。

### 5.2 iOS Safari 的 `persist()` 行為
- 依已知行為，**iOS Safari 的 `navigator.storage.persist()` 多半回傳 `false`**（未授予），
  storage 維持 best-effort。`persisted()` 也多為 `false`。
- 加到主畫面的 standalone web app 在較新 iOS 上有獨立的 storage 範疇，實際是否較不易被驅逐，
  **需以真機 + 時間驗證**，不要假設。
- Android Chrome 安裝為 PWA 後，`persist()` 通常被授予（`true`），驅逐風險低。

### 5.3 iOS Safari 的 storage 驅逐行為
- WebKit 對「可被腳本寫入的 storage」（IndexedDB、OPFS、Cache Storage 等）有
  **約 7 天未與該網站互動就清除** 的政策（針對一般 Safari 瀏覽情境）。
- 加到主畫面的 web app 是否套用同一條 7 天規則、或有不同範疇，各 iOS 版本行為不一致，
  **這是本 PoC 最大的不確定點**，必須用「3.2 步驟 5」等 7 天以上實測。
- 因此結論層面：**不要把 iOS 上的 OPFS/IndexedDB 當成可靠長期保存**；
  真要長期保存應考慮可同步到後端、或引導使用者匯出。

---

## 6. 結論（PoC 層級）

**成立（程式碼/架構層面已具備，預期可通過，待真機覆核）**
- 純靜態、無後端、vanilla JS、可直接上 GitHub Pages 取得免費 HTTPS。✅
- OPFS 主路徑 + SyncAccessHandle 全部在 Worker、主執行緒零同步 I/O。✅
- 偵測不支援即 fallback IndexedDB，且 UI 明確標示用哪一種。✅
- Service Worker 預快取 + cache-first，離線冷啟動的機制完整。✅
- 安裝 / standalone 所需 manifest 與 iOS meta 標籤齊備。✅

**有風險（需真機/時間驗證）**
- **iOS 7 天驅逐**：最大風險。短期測試會通過，長期可能掉資料。必須等 7 天實測。
- **iOS `persist()` 很可能不授予**：不能依賴它防驅逐。
- **舊版 Safari 的 SyncAccessHandle 介面差異**：可能觸發 fallback（PoC 已能吸收，但要確認實際走哪條路）。
- iOS 安裝體驗較差（無自動安裝提示，需手動「加入主畫面」），影響可用性而非技術可行性。

**建議下一步**
1. 真機跑完 §4 表，特別是排程一個 7 天後的 iOS 回測。
2. 若 iOS 長期保存不可靠 → 加「匯出 / 匯入 JSON」與（未來）後端同步，把本地 storage 當快取而非真相來源。
3. 若要正式產品化：補 SW 版本升級流程、icon 設計、錯誤回報、以及 OPFS 寫入的併發/鎖處理。

---

## 附：靜態檢查
- `node --check` 對 `app.js`、`storage-worker.js`、`sw.js` 通過（語法無誤）。
- icons 為合法 PNG（192 / 512 / maskable-512）。
- 仍**未**做真機行為驗證，原因見頂部誠實聲明。
