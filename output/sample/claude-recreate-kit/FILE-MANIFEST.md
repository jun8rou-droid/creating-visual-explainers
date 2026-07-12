# 添付ファイルマニフェスト（Claude Projects / ナレッジ）

Claude に渡すソースの優先順位です。パスは `creating-visual-explainers/output/sample/` 基準。

## 必須（仕様理解）

| 優先 | ファイル | 理由 |
|------|----------|------|
| ★★★ | `claude-recreate-kit/SCOPE-LOCKED.md` | 確定仕様の要約 |
| ★★★ | `claude-recreate-kit/CURRENT-STATE-v25.md` | 何ができているか |
| ★★★ | `claude-recreate-kit/ARCHITECTURE-ONE-PAGE.md` | 全体像 |
| ★★★ | `machining-quote-design-memo.md` | 設計 SSOT（786 行） |
| ★★☆ | `machining-quote-session-script.md` | デモ説明・用語 |

## 必須（実装の正）

| 優先 | ファイル | 理由 |
|------|----------|------|
| ★★★ | `machining-quote-4pane-mock.html` | UI + 計算 + クライアント全体 |
| ★★★ | `api-server/quotes-db.mjs` | 見積 CRUD・確定 |
| ★★★ | `api-server/app.mjs` | REST エンドポイント |
| ★★★ | `migrations/001_init.sql` | コア表 |
| ★★☆ | `migrations/002_ai_api.sql` | AI 表 |
| ★★☆ | `migrations/003_seed.sql` | 初期データ |
| ★★☆ | `api-server/db.mjs` | DB 接続 |
| ★★☆ | `package.json` | スクリプト・依存 |

## あるとよい（機能別）

| ファイル | 機能 |
|----------|------|
| `js/similar-diff/shared.mjs` + `client.mjs` | 類似案件 AI 差分 |
| `api-server/similar-diff.mjs` | 差分 API |
| `js/drawing-analyze/shared.mjs` + `client.mjs` | 図面解析クライアント |
| `js/drawing-analyze/vision-prompt.mjs` | Vision プロンプト |
| `api-server/vision-router.mjs` | 図面 API ルーティング |
| `api-server/gemini-analyze.mjs` | Gemini OCR |
| `api-server/ai-db.mjs` | 提案・フィードバック DB |
| `js/drawing-analyze/feedback-diff.mjs` | AI 学習 diff |
| `js/drawing-analyze/session-learn.mjs` | セッション学習デモ |
| `DEPLOY-VERCEL.md` | 本番デプロイ |
| `api/index.mjs` | Vercel エントリ |
| `vercel.json` | Vercel 設定 |

## キット内（このフォルダ）

すべて `claude-recreate-kit/` に同梱。Projects には **このフォルダごと** アップロード可。

## HTML が大きすぎる場合の分割案

`machining-quote-4pane-mock.html` を手動で次に分けて添付してもよい:

1. **行 1–740** — `<style>` + レイアウト HTML 骨格
2. **行 741–1350** — ペイン HTML + マスタ画面 HTML
3. **行 1351–2800** — データ構造・マスタ・計算 `calcRow` 周辺
4. **行 2800–4200** — 対話 UI・API 下書き・確定
5. **行 4200–6806** — 類似案件・図面 AI・マスタ画面 JS・起動

※ 行番号は v25 時点。更新後は `wc -l` で再確認。

## API エンドポイント一覧（添付不要・参照用）

```
GET  /api/health
GET  /api/quotes
POST /api/quotes
GET  /api/quotes/:ref/draft
PUT  /api/quotes/:ref/draft
GET  /api/quotes/:ref/meta
GET  /api/quotes/:ref/revisions/:rev
POST /api/quotes/:ref/confirm
POST /api/drawings/analyze
POST /api/drawings/ocr-crop
POST /api/drawings/feedback
POST /api/similar-diff
```

## ローカル起動

```bash
cd output/sample
npm install
cp .env.example api-server/.env   # DATABASE_URL を設定
npm run migrate
npm start
# → http://localhost:3847/machining-quote-4pane-mock.html
```
