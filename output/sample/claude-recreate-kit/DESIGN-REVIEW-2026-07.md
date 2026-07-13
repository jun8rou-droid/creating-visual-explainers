# 設計レビュー（2026-07 · v27 時点）

全体設計レビューの結果。3観点（仕様整合 / API・DB / フロント構造・運用）で精査し、重複を統合して優先度順に並べた。**コードは未修正**。着手時はこのファイルの項目番号で指示すればよい。

深刻度: S=公開・複数人運用の前に必須 / A=データ整合の芯 / B=品質・運用 / C=保守性・小物

---

## S: 本番公開の前に必須

### S1. API に認証が一切ない
- 全エンドポイントが無認証 + CORS 全開放（`api-server/app.mjs:64-66`）。Vercel 公開状態だと URL を知る第三者が **案件一覧（顧客名・単価）を全件取得・改ざん・確定** でき、`/api/drawings/analyze` 連打で **Gemini 課金の消尽** も可能。
- 対策: 全 `/api/*` に共有シークレット（ヘッダ）か Basic 認証。Vercel の Deployment Protection でも可。CURRENT-STATE の「アクセス制限 中」は **S に格上げすべき**。

### S2. 確定金額をクライアント値のまま凍結（サーバ再計算なし）
- `confirmQuoteRevision` は受け取った snapshot をほぼそのまま INSERT（`quotes-db.mjs:642-731`, `421-440`）。改ざん・古いマスタのブラウザからの確定で、マスタと整合しない金額が正本化される。
- 対策: サーバ側で工程＋マスタから再計算し、クライアント値と乖離したら 409 で拒否（または警告記録）。

### S3. 案件一覧の XSS（未エスケープ innerHTML）
- `renderQuoteList` が顧客名・図番・品名・材質など **人が自由入力した DB 文字列を生のまま innerHTML 連結**（`machining-quote-4pane-mock.html:5661-5673`）。`escapeHtml` は定義済みなのに一覧では未使用。
- 対策: 一覧レンダリングの全変数を `escapeHtml()` で包む。innerHTML 56箇所 vs escapeHtml 16箇所なので他も棚卸し。

---

## A: データ整合の芯（複数人運用で事故る順）

### A1. マスタが localStorage のみ → PC ごとに見積金額がブレる【✅ v28 で対応済み】
- 材質・品名・顧客・共通マスタは各ブラウザの localStorage にしか無い（`mq-master-v1`）。PC-A と PC-B で Vc や ¥/kg が違えば **同じ案件でも金額が変わり**、下書き段階では警告も出ない。設計メモの「DB が唯一の正本」（design-memo:340）に違反。
- 対策: `GET/PUT /api/masters`（materials / products / customers / settings / templates）を追加して DB を正本化。CURRENT-STATE の「マスタ DB 化 高」そのもの。

### A2. materials 表に n_max_turn / n_max_hole 列がない【✅ v28 で対応済み】
- v22 の回転数上限はフロントだけが持ち、DB スキーマ（`migrations/001_init.sql:8-19`）と `ensureMaterial` のコピー列（`quotes-db.mjs:99-104`）に無い。**DB だけでは確定金額を再現できない**。A1 のマイグレーションに必ず同梱する。

### A3. 下書き保存が後勝ち上書き（楽観ロック無し）
- PUT /draft は updated_at の突合なしで全置換（`quotes-db.mjs:167-286`）。2人が同じ案件を開くと **先に保存した人の編集が黙って消える**。
- 対策: GET が返す `revision_updated_at` を PUT に載せ、不一致なら 409「他の人が更新しています」。

### A4. 正式 ID 採番が当日初回に衝突する
- `SELECT ... FOR UPDATE` は counters 行が **まだ無い日には何もロックしない**（`quotes-db.mjs:399-416`）。その日最初の2件が同時確定すると同じ `Q-YYYYMMDD-001` を生成→片方がエラーでロールバック。
- 対策: `INSERT ... ON CONFLICT DO UPDATE SET value = counters.value + 1 RETURNING value` の1文アトミック採番に変更。`createDraftQuote` も同様。

### A5. 未保存データの喪失リスク（自動保存が sessionStorage のみ）
- 自動バックアップは sessionStorage（タブを閉じると消える）で、DB 保存は手動ボタンだけ。保存失敗もステータスバー1行のみで気付きにくい。
- 対策: バックアップを localStorage に変更＋DB への定期オートセーブ（例: 30秒デバウンス）＋保存失敗時は目立つ表示。

---

## B: 品質・運用

| # | 内容 | 証拠 | 対策 |
|---|------|------|------|
| B1 | エラー応答が `err.message` 素通しで内部情報（PG制約名など）漏れ | app.mjs:133 ほか10箇所 | 500系は汎用文言、詳細はログのみ |
| B2 | Neon 直結でサーバレスの接続枯渇リスク | db.mjs:29-43 | `-pooler` 付き接続文字列に変更 |
| B3 | アップロード上限の不整合（multer 20MB > Vercel 実質4.5MB） | app.mjs:54-57 | 上限をVercel実態に合わせ、フロント文言も統一 |
| B4 | Gemini 逐次4〜5回呼び出しで 60秒超→504 リスク、Abort 無し | gemini-analyze.mjs:192-238 | 呼び出しにタイムアウト、リトライ回数削減 |
| B5 | AIフィードバックが `/tmp` の JSONL 頼み（サーバレスで消える） | app.mjs:47-49, 442-451 | 常に DB（ai_feedback）へ保存 |
| B6 | 工程数・文字列長・レート制限が無い（S1と併せてコストDoS可能） | quotes-db.mjs:110-160 | 上限バリデーション＋簡易レート制限 |
| B7 | バックアップ手順が未文書化（Neon PITR / pg_dump） | DEPLOY-VERCEL.md 全体 | 運用手順を1ページ追記【既知・低→B】 |
| B8 | qty/dia/len の CHECK 制約なし、updated_at に索引なし | 001_init.sql:75-77 | 制約＋索引をマイグレーション追加 |
| B9 | 図面ハッシュのキャッシュが案件をまたいで返る | ai-db.mjs:82-93 | quote_id も突合キーに含める |

---

## C: 保守性・小物

| # | 内容 | 証拠 | 対策 |
|---|------|------|------|
| C1 | v14撤去の図面ピックUIの死コード塊（到達不能な関数群・約300行） | mock HTML 4909-5220 周辺 | 削除（renderDrawingPreviewPanel, wirePickRegions, DEMO_OCR_REGIONS 等） |
| C2 | 設計メモ(SSOT)が v9 時点で陳腐化 — n 上限式・図面UI等が未反映 | design-memo:57,69 | メモを v27 実装に合わせて改訂 |
| C3 | 材料費の±ボタンが実は効かない（次の再描画で自動計算値に戻る） | mock HTML 2890-2905, 5812 | 「自動/手動」を明示切替にするか±ボタン撤去 |
| C4 | Tailwind CDN 依存（オフライン・CDN障害でスタイル全崩壊） | mock HTML:13 | 本番前にセルフホスト or ビルド導入 |
| C5 | 自動テストが無い（CLAUDE.mdの手動チェックのみ） | リポジトリ全体 | まず計算式（calcRow）と API の回帰テストから |
| C6 | 単一HTML 6,900行・グローバル可変状態73個 | mock HTML:1587- | Next.js 移行時に解消（当面はC1削除で軽量化） |
| C7 | quote_drawings 表が孤立（書き込みコード無し） | 001_init.sql:128-137 | 図面NAS保存を実装するか表を削除 |
| C8 | モバイルで図面プレビュー固定300pxが入力欄と競合 | mock HTML:912-914 | @media で高さ縮小 |
| C9 | migrate がファイル単位トランザクション無し | migrate.mjs:40 | BEGIN/COMMIT で包む |
| C10 | DEPLOY文書が接続文字列のシェル直書きを案内（履歴に残る） | DEPLOY-VERCEL.md:41-44 | .env 経由の手順に書き換え |

---

## 推奨ロードマップ

1. **Phase 2（次）= A1+A2 マスタ DB 化**（既定の次タスク。n_max 列・マスタ API・フロント切替を1セットで）
2. **Phase 3 = S1 認証 + S3 XSS**（Vercel 公開を続けるなら実質いま一番危ない）
3. **Phase 4 = A3 楽観ロック + A4 採番 + S2 確定再計算**（複数人運用の解禁条件）
4. **Phase 5 = A5 自動保存 + B群**
5. C群は上記のついで（特に C1 死コード削除は A1 の前にやると diff が読みやすい）

確認済みの健全な部分: 計算式（D・削り回数・行時間・10円切上げ・段取り按分）はメモと完全一致。確定 rev 読取専用・quote_index 複写・AI「提案のみ」原則（sanitizeUiHallucination）も設計どおり。js/drawing-analyze のモジュール分割は良好。
