# 離線記事 PWA — 離線持久化最小可行性驗證（PoC）

驗證一個純前端、純靜態的跨平台 PWA 能否：可安裝到主畫面、離線冷啟動、用
**OPFS（Origin Private File System）+ SyncAccessHandle** 持久化資料，並在不支援時
**自動 fallback 到 IndexedDB**；同時把 `navigator.storage` 的
`persist() / persisted() / estimate()` 行為攤開來實測。

**本階段以 iOS 為主，並加入跨裝置資料同步**：因為 PoC 第一階段已指出 iOS 最大風險是
**7 天驅逐 + persist() 多半不授予**，所以把本地 storage 降級為「快取」，真相來源放到一個
**Cloudflare Worker + KV** 的極簡後端。同步採 **vanilla union-merge**（不引入函式庫）：記事為
append-only + tombstone，依 `id` 取聯集、`deleted` 勝出 → 天然無衝突。識別方式為使用者自填的
**同步碼**，並在新增/刪除、開啟、回到前景、上線時**自動同步**。

> ⚠️ **誠實聲明**：本專案在一個沒有實體行動裝置與瀏覽器的環境中產出。
> 所有「程式碼層面」的正確性我已做靜態檢查（見最後），但下方驗收表中標記
> **「待裝置實測」** 的項目，我**沒有**在真實 iOS / Android 上跑過。
> 表內「預期」欄是依據各平台已知行為（知識截止 2026-01）所做的推測，
> 你必須在真機上勾選確認，尤其是 **iOS 的 7 天驅逐** 這種需要等時間才能觀察的項目。

---

## 0. 在裝置上驗證（最短路徑）

要在手機驗證需要兩個東西:**前端網址**(離線/安裝/OPFS 等大部分驗收只需要它)與
**同步後端網址**(只有跨裝置同步需要)。

### A. 前端 — 已自動部署(零設定)
本 repo 內含 GitHub Actions(`.github/workflows/deploy-pages.yml`),push 後會自動把網站部署到
**GitHub Pages** 並開啟 Pages,跑完即得一個 HTTPS 網址:

```
https://<你的帳號>.github.io/<repo 名>/
```

> 查網址:GitHub repo → **Actions** 分頁看 "Deploy PWA to GitHub Pages" 跑完,
> 或 **Settings → Pages** 上方顯示的網址。第一次若因權限沒自動開,到
> **Settings → Pages → Source** 選 **GitHub Actions** 再重跑一次工作流程即可。

拿到網址後,**只用前端**就能驗收:安裝/standalone、離線冷啟動、OPFS 持久化、persist()/estimate()。
這些不需要後端。

### B. 同步後端 — 需要你的 Cloudflare 帳號(我無法代為部署)
跨裝置同步那一項才需要。最快方式:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/freejerry/pwa-mvp/tree/main/worker)

或用指令(見 §3.1b)。部署完把得到的 `https://….workers.dev/notes` 填進前端「跨裝置同步」面板即可。

> 為什麼後端不能自動好?Cloudflare Worker 需要你的帳號授權(`wrangler login` / 一鍵按鈕的 OAuth),
> 這是必要的人工步驟,無法在這個環境替你完成。前端則完全自動。

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
├── worker/             # 同步後端（Cloudflare Worker，與前端分開部署）
│   ├── index.js        # GET/POST /notes，伺服器端 union-merge，KV 儲存，CORS
│   └── wrangler.toml   # Worker 設定 + KV namespace 綁定
├── .github/workflows/
│   └── deploy-pages.yml # push 後自動部署前端到 GitHub Pages（取得可在手機開的 HTTPS 網址）
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

### 2.5 跨裝置同步（本階段新增，以 iOS 為主）
**動機**：iOS 上本地 storage 不可靠（7 天驅逐 / persist 多半不授予），所以本地只當快取，
真相來源放 Cloudflare Worker + KV。

- **資料模型**：每筆記事 `{ id, text, ts, updated, deleted }`。append-only；刪除用
  `deleted:true` 的 **tombstone**（這樣刪除也能跨裝置傳遞）。UI 過濾掉 tombstone。
- **同步演算法（vanilla union-merge，無函式庫）**：一次 `POST /notes?code=XXX` 同時做
  push + pull——本機把整份資料送上去，**伺服器端也做 union-merge** 後回傳完整集合，前端再寫回本機。
  合併規則：依 `id` 取聯集、`deleted` 勝出、`updated` 取較新、`text/ts` 不可變取最早出現者。
  → append-only + 聯集 = **天然無衝突**，連 CRDT 都不需要。
- **冪等性**：合併已收斂後再合併不會再變（見「靜態檢查」的 fixpoint 單元測試），
  所以 `syncNow()` 只在內容真的不同時才寫回本機，不會無謂 I/O。
- **識別與觸發**：使用者自填**同步碼**（存在 `localStorage`）；啟用後在
  **新增 / 刪除 / 開機 / `visibilitychange` 回前景 / `pageshow` / `online`** 時自動同步
  （回前景觸發對 iOS standalone 特別重要，因為 app 會被凍結）。連續輸入有 800ms debounce。
- **離線**：離線時 `syncNow()` 直接標記「已排入待同步」，等 `online` 事件再補同步；本地 OPFS/IDB
  照常可讀寫，完全不阻塞。
- **Service Worker**：跨來源（打到 Worker）的請求一律 **網路直通、不進快取**，避免拿到舊資料。
- **安全性（PoC 等級，務必知道）**：同步碼即存取權，**知道碼的人就能讀寫該組資料**，且 KV 內為明文。
  正式環境應換成真正的帳號 / 權杖 + 後端授權。

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

### 3.1b 部署同步後端（Cloudflare Worker + KV，免費、免信用卡即可起步）
前端是靜態檔（GitHub Pages），同步後端是一個獨立的 Cloudflare Worker。步驟：

```bash
# 1. 安裝並登入（會開瀏覽器授權）
npm i -g wrangler
wrangler login

# 2. 建立 KV namespace，記下回傳的 id
cd worker
wrangler kv namespace create NOTES
#   → 把輸出的 id 填進 worker/wrangler.toml 的 [[kv_namespaces]] id

# 3. 部署
wrangler deploy
#   → 會得到網址，例如 https://notes-poc-sync.<你的帳號>.workers.dev
```

部署後，前端「跨裝置同步」面板的 **同步 API 網址** 填：
`https://notes-poc-sync.<你的帳號>.workers.dev/notes`（**記得結尾的 `/notes`**）。

> 本機開發測試後端：`cd worker && wrangler dev`（需在 wrangler.toml 補 `preview_id`）。
> CORS 已設 `*`，所以 GitHub Pages 網域可直接呼叫。

### 3.2 在手機上測試
**Android（Chrome）**
1. 用 Chrome 開上面的 https 網址。
2. 右上選單 →「**安裝應用程式 / 加到主畫面**」（或網址列出現安裝提示）。
3. 從主畫面圖示開啟 → 應為 standalone（無網址列）。
4. 開飛航模式 → 從主畫面重新冷啟動 → app 應可開。
5. 新增幾筆記事 → 從最近 app 列表**完全關閉** → 重開 → 記事應仍在。
6. 狀態面板按「請求持久化」，記錄 `persist()` 結果與 `persisted()`。

**iOS（Safari）— 本階段重點**
1. 用 **Safari**（不是其他瀏覽器）開該 https 網址。
2. 分享鈕 →「**加入主畫面**」→ 確認 icon / 名稱 → 加入。
3. 從主畫面圖示開啟 → 應為 standalone（無網址列）。
4. 飛航模式冷啟動測試、新增→完全關閉→重開測試，同上。
5. **同步測試**（建議第二台裝置或桌機 Chrome 對照）：
   - 在「跨裝置同步」面板填 Worker 網址 + 一組同步碼，按「啟用自動同步」→ 狀態應變「已同步」、顯示 rev。
   - A 裝置新增記事 → B 裝置（填同一同步碼）開啟或切回前景 → 應自動 pull 到那筆。
   - A 刪除某筆（tombstone）→ B 回前景 → 該筆也消失。
   - 離線時新增 → 狀態顯示「已排入待同步」→ 恢復連線後應自動補同步。
6. **驅逐測試（最關鍵）**：記錄今天日期，之後**不要開這個網站**，過 7 天以上再開主畫面 app：
   - 看本地記事是否被清掉（驗證 iOS 7 天驅逐是否真的發生在 standalone app）。
   - 若被清掉但**同步已啟用** → 回前景時應從 Worker 自動 pull 回來，**資料不會真的遺失**
     （這正是本階段加同步要解決的核心問題）。

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
| 啟用同步後，A 新增 → B 自動 pull 到 | [ ] 待測 | [ ] 待測 | 回前景/開機/上線觸發；union-merge 已過 fixpoint 單元測試 |
| A 刪除（tombstone）→ B 也消失 | [ ] 待測 | [ ] 待測 | 刪除以 `deleted:true` 傳遞，`deleted` 在合併時勝出 |
| 離線新增 → 恢復連線後自動補同步 | [ ] 待測 | [ ] 待測 | 離線時排隊，`online` 事件觸發 |
| **iOS 7 天驅逐後，同步能把資料救回** | （N/A） | [ ] **待 7 天實測** | 本階段加同步的主要目的；需等時間驗證 |

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
- 因此結論層面：**不要把 iOS 上的 OPFS/IndexedDB 當成可靠長期保存**——
  這就是本階段加上「Cloudflare Worker + KV 同步」的直接理由：本地當快取，後端當真相來源。

### 5.4 同步在 iOS 上的注意點（待真機覆核）
- iOS standalone app 會被系統凍結；回前景時的 `visibilitychange` / `pageshow` 是最可靠的
  自動 pull 時機，本 PoC 已掛上。需實測 iOS 是否確實在 resume 時觸發這些事件。
- 跨來源 `fetch` 在 iOS standalone 下需 Worker 正確回 CORS（已設 `*`）。若 pull 失敗，
  事件記錄會顯示 `同步失敗`，狀態列轉紅。
- **同步把「資料遺失」降級為「本地快取遺失」**：即使 iOS 7 天驅逐真的清掉本地，
  只要同步碼還在（存在 localStorage；localStorage 也可能被驅逐，故第一次同步後建議記下同步碼），
  回前景即可從 Worker 救回。**localStorage 同樣可能被驅逐，這點要實測**。

---

## 6. 結論（PoC 層級）

**成立（程式碼/架構/邏輯層面已具備，預期可通過，待真機覆核）**
- 純前端靜態 + 一個極簡 Cloudflare Worker 後端，皆免費、免信用卡起步、HTTPS。✅
- OPFS 主路徑 + SyncAccessHandle 全部在 Worker、主執行緒零同步 I/O；不支援即 fallback IndexedDB 並標示。✅
- Service Worker 預快取 + cache-first，離線冷啟動機制完整；跨來源同步請求網路直通不進快取。✅
- 安裝 / standalone 所需 manifest 與 iOS meta 標籤齊備。✅
- **vanilla union-merge 同步**：append-only + tombstone，依 id 聯集、deleted 勝出，
  伺服器端也合併避免互蓋；**fixpoint 單元測試通過**（merge 收斂、不會多餘寫回）。✅
- 同步在新增/刪除/開機/回前景/上線時自動觸發，離線排隊、上線補同步。✅

**有風險（需真機 / 時間驗證）**
- **iOS 7 天驅逐**：仍是最大不確定點。加了同步後「資料」不致真的遺失，但要實測 resume 是否確實觸發 pull、
  以及 **localStorage（存同步碼）是否也被驅逐**——若同步碼掉了又沒記下來，就救不回。
- **iOS `persist()` 很可能不授予**：不能依賴它防驅逐（所以才靠後端）。
- **舊版 Safari 的 SyncAccessHandle 介面差異**：可能觸發 fallback（PoC 已能吸收，但要確認實際走哪條路）。
- **同步碼安全性**：目前知道碼即可讀寫、KV 明文，僅適合 PoC。
- iOS 安裝體驗較差（需手動「加入主畫面」），影響可用性而非技術可行性。

**建議下一步**
1. 真機跑完 §4 表；特別排一個 7 天後的 iOS 回測，重點看「驅逐後同步能否救回」與「同步碼是否還在」。
2. 把同步碼以外的「身份」做穩：第一次啟用時提示使用者抄下同步碼，或改用可記憶的帳號/權杖。
3. 強化後端：授權（每組資料一把 token）、rate limit、KV→D1（需要更強一致性或查詢時）。
4. 體驗：新增「匯出 / 匯入 JSON」當最後保險；同步衝突雖無（append-only），但若未來支援編輯既有記事，
   再考慮 Yjs/Automerge 等 CRDT。

---

## 附：靜態檢查（這些我在本環境實際跑過）
- `node --check` 對 `app.js`、`storage-worker.js`、`sw.js`、`worker/index.js`（ESM 模式）通過。
- `manifest.json` 為合法 JSON。icons 為合法 PNG（192 / 512 / maskable-512）。
- **union-merge 單元測試通過**：聯集、deleted 勝出、text 不可變、updated 取較新、排序、空/null 安全、
  以及 **fixpoint 收斂**（合併後再合併不變動 → 同步不會造成多餘寫回）。
- 仍**未**做真機行為驗證（無實體裝置），原因見頂部誠實聲明；標 `[ ] 待測` 的項目務必在真機覆核。
