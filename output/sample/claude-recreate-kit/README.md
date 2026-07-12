# 加工費見積ツール — Claude 再現キット

Claude（**Projects** / **Claude Code** / **Cowork**）で同じ自動見積ツールを作り直す・継続開発するためのプロンプトと参照ファイル一覧です。

## リポジトリ上の本体

| 項目 | パス |
|------|------|
| リポジトリ | `creating-visual-explainers` |
| ルート | `output/sample/` |
| 画面モック（正本） | `machining-quote-4pane-mock.html`（約 6800 行 · v25） |
| 設計メモ（SSOT） | `machining-quote-design-memo.md` |
| API | `api-server/app.mjs` + `quotes-db.mjs` |
| DB スキーマ | `migrations/001_init.sql` 〜 `003_seed.sql` |
| 本番例 | Vercel + Neon（`DEPLOY-VERCEL.md`） |

## Claude Projects の使い方（推奨）

### 1. プロジェクトを作る

名前例: `加工費見積ツール`

### 2. Custom Instructions に貼る

`CLAUDE-PROJECT-INSTRUCTIONS.md` の全文を **Project instructions** にコピー。

### 3. ナレッジに添付するファイル（優先順）

`FILE-MANIFEST.md` の **必須** から順にアップロード。  
`machining-quote-4pane-mock.html` は大きいので、Projects の容量制限に応じて:

- **A:** 全文アップロード（いちばん確実）
- **B:** `FILE-MANIFEST.md` の「分割アップロード案」どおりに章ごとに抜粋
- **C:** Claude Code でリポジトリを直接開く（添付不要）

### 4. 最初の会話

`START-PROMPT.md` から目的に合ったブロックをコピーして送る。

### 5. 継続開発

`CONTINUE-PROMPT.md` のテンプレを使う。

## Claude Code で使う場合

```bash
cd /path/to/creating-visual-explainers/output/sample
# Custom Instructions 相当を CLAUDE.md に置く場合:
cp claude-recreate-kit/CLAUDE-PROJECT-INSTRUCTIONS.md ./CLAUDE.md
```

起動後:

```
@machining-quote-design-memo.md と @machining-quote-4pane-mock.html を読み、
CURRENT-STATE-v25.md の未着手を Phase 1 から実装して。
```

## このキットのファイル一覧

| ファイル | 用途 |
|----------|------|
| `README.md` | この説明 |
| `CLAUDE-PROJECT-INSTRUCTIONS.md` | プロジェクト常設指示（システムプロンプト相当） |
| `START-PROMPT.md` | 初回・再現用ユーザープロンプト集 |
| `CONTINUE-PROMPT.md` | 機能追加・修正用プロンプト集 |
| `FILE-MANIFEST.md` | 添付すべきソース一覧 |
| `CURRENT-STATE-v25.md` | 2026-07 時点の実装済み / 未着手 |
| `SCOPE-LOCKED.md` | グリルで確定した仕様（変更禁止リスト） |
| `ARCHITECTURE-ONE-PAGE.md` | 1枚アーキテクチャ |

## 運用前提（2026-07 合意）

- **当社のみ**で利用（マルチテナント不要）
- **見積データは DB に保存**（下書き・確定・案件一覧）
- マスタは DB 化を推奨（現モックは localStorage 暫定 v24）
