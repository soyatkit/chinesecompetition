# 中文至叻挑戰賽 v4.1 — 專案移交文件

> 課堂中文詩詞分組挑戰系統 · Cloudflare Worker 全棧 SPA · 固定五組、三回合、教師即開即用

---

## 1. 專案概覽

| 項目 | 說明 |
|------|------|
| **用途** | 小學課堂中文詩詞挑戰賽（P4-P6 年級），老師開連結即時開始 |
| **架構** | 單頁前端 (index.html) + Cloudflare Worker 後端 (worker.js) |
| **備用後端** | Node.js 簡易 API (`server.js`)，僅排行榜功能，無 session 機制 |
| **部署** | Cloudflare Workers + KV，前端從 GitHub raw 動態拉取 |
| **認證** | Admin: `lyt / lyt`，Bearer token `lyt:lyt` 硬編碼 |

---

## 2. 檔案清單與職責

| 檔案 | 角色 | 關鍵細節 |
|------|------|----------|
| `index.html` | **全前端 SPA** | HTML + CSS + JS 全部內聯，零依賴。首頁即控制台，固定五組、三回合、倒數計時、離線 fallback、音效 |
| `worker.js` | **Cloudflare Worker 後端** | ~200 行，處理 session 生命週期、回合計時資料、計分、排行榜、管理 API、serve 前端 |
| `server.js` | **Node.js 備用後端** | ~120 行，純排行榜 CRUD + 健康檢查，使用 `leaderboard.json` 本地檔案 |
| `wrangler.toml` | **Cloudflare 部署配置** | 定義 KV namespace binding (`LEADERBOARD`, `SESSIONS`) |
| `package.json` | **Node 端依賴** | 僅定義 `server.js` 的啟動腳本 (`npm start` / `npm run dev`)，零 npm 依賴 |
| `.gitignore` | 忽略 `node_modules/`, `leaderboard.json`, `.env`, `.wrangler/`, `.dev.vars` |

---

## 3. 架構圖

```
┌─────────────────────────────────────────────────┐
│                   Browser (投影幕)                │
│  ┌───────────────────────────────────────────┐  │
│  │           index.html (SPA)                │  │
│  │  Dashboard → Quiz → Result   (3 screens)  │  │
│  │  + Admin Panel (排行榜管理)               │  │
│  └──────────────┬────────────────────────────┘  │
└─────────────────┼────────────────────────────────┘
                  │ HTTPS (fetch)
                  ▼
┌─────────────────────────────────────────────────┐
│         Cloudflare Worker (worker.js)            │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Serve    │  │ Session  │  │ Leaderboard  │  │
│  │ Frontend │  │ API      │  │ API          │  │
│  │ (從GitHub│  │ CRUD     │  │ CRUD         │  │
│  │  raw拉取)│  │          │  │              │  │
│  └──────────┘  └────┬─────┘  └──────┬───────┘  │
│                     │               │           │
│               ┌─────▼─────┐  ┌──────▼───────┐  │
│               │ KV:       │  │ KV:          │  │
│               │ SESSIONS  │  │ LEADERBOARD  │  │
│               │ (TTL 2h)  │  │ (top 50)     │  │
│               └───────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## 4. 前端 (`index.html`) 關鍵實作

### 4.1 三大畫面 (Screen)

| Screen ID | 用途 |
|-----------|------|
| `scrHome` | 規則首頁：先閱讀遊戲規則，再按「進入遊戲」前往控制台 |
| `scrDash` | 主控制台：選擇年級、查看遊戲規則、選回合、選至尊挑戰難度、開始回合 |
| `scrQuiz` | 答題主畫面：題目區 + 固定五組計分卡 + 進度條 + 揭示答案 / 下一題 |
| `scrResult` | 結果頁：冠軍組展示 + 小組排行榜 |
| `scrAdmin` | 管理面板：查看 / 刪除排行榜全部資料 |

### 4.2 全域變數

```js
const A = Worker origin (自動偵測 or fallback 到 workers.dev)
const T = 'lyt:lyt'   // Bearer token
const C = { A:'#FF8C94', B:'#8AB8E8', ... }  // 各組顏色
let GC = 5             // 固定五組
let SES = {...}        // 當前 session 狀態 cache
```

### 4.3 遊戲流程

```
goStart()
  → POST /api/session/create  (建立 session)
  → POST /api/session/:code/start  (開始回合 / 啟動倒數)
  → loadQ()  (載入第一題)
      ↓
  每次答題:
    sc(group, type) → POST /api/session/:code/score  (依回合而定)
      → btnNext enabled
      ↓
  nextQ() → POST /api/session/:code/next  (下一題 / 結束)
      → loadQ() 或 finish()
```

### 4.4 離線 Fallback

當 API 不可用時，前端會：
- 顯示「離線模式」提示
- 計分按鈕仍可用，本地更新 DOM 上的分數 (無持久化)
- 無排行榜紀錄

### 4.5 音效

使用 Web Audio API 即時合成：
- 答對：三角波上升音階 (C5→E5→G5→C6)
- 答錯：鋸齒波下降滑音 (B3→G2)

### 4.6 UI 設計

- 柔和 Apple 式現代美學，偏淺色、層次乾淨
- 內容優先於比例限制，頁面可自然延展並以清楚展示所有內容為主
- CSS 變數系統 (`--bg`, `--accent`, `--success`, `--danger` 等)
- 響應式：桌面重視橫向資訊密度，手機則壓縮間距與字級

---

## 5. 後端 API 全表 (Worker)

> Base URL: `https://chinesepoetry-api.chinesepoetry-api.workers.dev`

### 5.1 前端 Serving
| Method | Path | Auth | 說明 |
|--------|------|------|------|
| GET | `/` 或 `/index.html` | 無 | 從 GitHub raw (`soyatkit/chinesepoetry/main/index.html`) 拉取最新前端，`Cache-Control: no-store` |

### 5.2 健康檢查
| Method | Path | Auth | 說明 |
|--------|------|------|------|
| GET | `/api/health` | 無 | 回傳 `{ status, entries }` |

### 5.3 排行榜 (公開)
| Method | Path | Auth | 說明 |
|--------|------|------|------|
| GET | `/api/leaderboard` | 無 | 取得前 50 筆排行榜 |
| POST | `/api/leaderboard` | 無 | 提交分數 (但 Worker 版實際上由 session 結束時自動寫入) |

### 5.4 管理員
| Method | Path | Auth | Body | 說明 |
|--------|------|------|------|------|
| POST | `/api/admin/login` | 無 | `{ username, password }` | 回傳 token `lyt:lyt` |
| DELETE | `/api/admin/leaderboard` | Bearer | `{ index? }` | 刪除指定 index 或全部 (`{}`) |

### 5.5 Session 生命週期 (核心)

| Method | Path | Auth | Body | 說明 |
|--------|------|------|------|------|
| POST | `/api/session/create` | Bearer | `{ grade, groupCount }` | 建立 6 位數 session code，隨機抽 10 題，TTL 2h；前端固定 `groupCount = 5` |
| GET | `/api/session/:code` | 無 | - | 取得 session 完整狀態 (含當前題目，playing 時才露出答案) |
| POST | `/api/session/:code/start` | Bearer | - | state: `waiting` → `playing` |
| POST | `/api/session/:code/score` | Bearer | `{ group, type, delta, round, difficulty }` | 記入 history，分數由前端依回合帶入 |
| POST | `/api/session/:code/next` | Bearer | - | currentQ++，到最後一題自動 finished |
| POST | `/api/session/:code/end` | Bearer | - | 手動結束，強制 finished |

### 5.6 Session 資料結構

```json
{
  "code": "123456",
  "grade": "P4",
  "groupCount": 5,
  "state": "waiting | playing | finished",
  "currentQ": 0,
  "questions": [ { "poem", "text", "options[]", "answer" }, ... ],
  "groups": { "A": 0, "B": 10, "C": -5, "D": 20, "E": 0 },
  "history": [ { "q", "group", "type", "delta", "round", "difficulty", "time" }, ... ],
  "createdAt": "ISO string"
}
```

---

## 6. 題庫 (Question Bank)

位於 `worker.js` 的 `genQ()` 函數內，**硬編碼在後端**。

| 年級 | 題數 | 涵蓋詩作 |
|------|------|----------|
| **P4** | 10 題 | 靜夜思、春曉、登鸛雀樓、憫農、詠鵝、相思、鹿柴 |
| **P5** | 10 題 | 遊子吟、回鄉偶書、望廬山瀑布、絕句、楓橋夜泊、涼州詞、送孟浩然之廣陵、望天門山、早發白帝城 |
| **P6** | 10 題 | 送元二使安西、九月九日憶山東兄弟、贈汪倫、江雪、江南春、泊秦淮、山行、樂遊原、烏衣巷、望洞庭 |

每題結構：
```js
{ poem: '《詩名》作者', text: '題目文字', options: ['A', 'B', 'C', 'D'], answer: 0-3 }
```

每次遊戲從對應年級題庫隨機洗牌後取前 10 題。

---

## 7. Cloudflare KV 配置

| Binding | Namespace ID | 用途 | 資料 Key |
|---------|-------------|------|----------|
| `LEADERBOARD` | `cedd420f...` | 排行榜存儲 | `top20` → JSON array (保留最多 50 筆) |
| `SESSIONS` | `8a6cba2b...` | 遊戲 session | `{6-digit code}` → JSON, TTL 7200s |

---

## 8. Node.js 備用後端 (`server.js`)

- 端口：`PORT` env 或 default `3000`
- 資料儲存：`leaderboard.json` 本地檔案
- API：`GET/POST /api/leaderboard`, `GET /api/health`
- **沒有 session 機制** — 僅供排行榜 CRUD
- 驗證規則：`grade` ∈ {P4,P5,P6}，`score` ∈ [0,100]

---

## 9. 部署方式

### Cloudflare Worker (主力)
```bash
npx wrangler deploy
```
- Worker name: `chinesepoetry-api`
- 需確保 KV namespace ID 在 `wrangler.toml` 正確
- 前端自動從 `https://raw.githubusercontent.com/soyatkit/chinesepoetry/main/index.html` 拉取

### Node.js (備用)
```bash
npm start    # node server.js
npm run dev  # node --watch server.js
```

---

## 10. 認證體系

- 單一 admin 帳號：**lyt / lyt**
- Bearer token: `lyt:lyt`
- 前端直接 hardcode token 在 JS 變數 `T`
- Session 操作 (create/start/score/next/end) 及管理操作 (delete) 需要 Bearer auth
- 公開端點 (GET session, GET leaderboard, POST leaderboard) 無需認證

---

## 11. 已知限制 & 未來可改進

| 項目 | 說明 |
|------|------|
| **題庫擴充** | 題庫硬編碼在 `worker.js` 的 `genQ()`，新增題目需改後端 |
| **認證強度** | 單一 hardcode 帳密，無 token 過期機制 |
| **Session 隔離** | 所有 client 共用同一個 session code，無需登入即可觀看 |
| **前後端耦合** | 前端部署依賴 GitHub raw URL，非獨立部署 |
| **Node 後端不一致** | `server.js` 與 `worker.js` 功能不對等 (缺 session) |
| **無資料庫** | KV 有 2h TTL，session 過期即消失；排行榜上限 50 筆 |

---

## 12. 快速啟動 Checklist

1. `git clone` → `cd 中文至叻挑戰賽`
2. 確認 `wrangler.toml` 中 KV namespace ID 正確
3. `npx wrangler deploy` 部署 Worker
4. 瀏覽器打開 Worker URL 即可使用
5. 如需本地開發 Node 版：`npm start`

---

> **版本**: v4.1 · 中文至叻挑戰賽  
> **最後更新**: 2025  
> **維護者**: Yatkit → 現移交 Codex
