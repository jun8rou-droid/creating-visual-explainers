# Vercel + Neon 公開手順（ADS 課題 ⑤）

加工費見積ツールを **Vercel**（Web/API）+ **Neon**（PostgreSQL）で公開する手順です。

## 前提

- GitHub に `creating-visual-explainers` リポジトリがあること
- [Vercel](https://vercel.com) アカウント（GitHub 連携）
- ローカルで `npm` が使えること

---

## 1. Vercel にプロジェクトを作る

1. [Vercel ダッシュボード](https://vercel.com/dashboard) → **Add New… → Project**
2. GitHub リポジトリ `creating-visual-explainers` を選択
3. **Root Directory** を `output/sample` に設定（重要）
4. Framework Preset: **Other**
5. この時点ではまだ Deploy せず、次の Neon 設定へ

---

## 2. Neon（PostgreSQL）を接続

1. Vercel プロジェクト → **Storage** タブ
2. **Marketplace** から **Neon** を選び **Create**
3. 作成後、**DATABASE_URL**（または `POSTGRES_URL`）が **Environment Variables** に自動追加される
4. Production / Preview / Development すべてにチェックが入っていることを確認

Neon の接続文字列には通常 `?sslmode=require` が付いています。そのままで OK です。

---

## 3. マイグレーション（表の作成）

Neon は空の DB なので、**一度だけ** SQL を流します。

Vercel ダッシュボード → **Settings → Environment Variables** から `DATABASE_URL` をコピーし、ローカルで:

```bash
cd output/sample
npm install
DATABASE_URL="postgresql://..." npm run migrate
```

`完了: 3 件を適用しました` または `すべて適用済みです` と出れば OK です。

---

## 4. デプロイ

1. Vercel ダッシュボードで **Deploy**（または GitHub に push して自動デプロイ）
2. 完了後 URL が発行されます（例: `https://machining-quote-xxx.vercel.app`）

### 動作確認

| 確認 | URL |
|------|-----|
| 画面 | `https://あなたのURL/machining-quote-4pane-mock.html` |
| ヘルス | `https://あなたのURL/api/health` |

`/api/health` の JSON で `"db": { "enabled": true, "connected": true }` になっていれば Neon 接続成功です。

### 課題チェックリスト

1. 顧客名などを変更 → **下書き保存**
2. **F5 リロード** → 内容が戻る
3. **新版として確定** → rev が増える
4. **案件一覧** → DB の案件が表示される

---

## 5. （任意）図面 AI 解析

Vision を使う場合のみ、Vercel の Environment Variables に追加:

| 変数 | 内容 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude 用 |
| または `GOOGLE_API_KEY` | Gemini 用（`VISION_PROVIDER=google`） |

未設定でも **デモ応答** で動きます。

---

## ローカル開発（従来どおり）

```bash
cd output/sample
docker compose up -d
cp .env.example api-server/.env   # DATABASE_URL を編集
npm install
npm run migrate
npm start
# → http://localhost:3847/machining-quote-4pane-mock.html
```

---

## トラブルシュート

| 症状 | 対処 |
|------|------|
| `DATABASE_URL が未設定` | Vercel の Environment Variables を確認 → 再デプロイ |
| `db.connected: false` | Neon の DB が起動しているか · 接続文字列を再コピー |
| 404 on `/api/...` | Root Directory が `output/sample` か確認 |
| マイグレーション失敗 | `DATABASE_URL` を Neon 用（sslmode=require 付き）に |

---

## ファイル構成（デプロイ関連）

```
output/sample/
├── vercel.json          … Vercel 設定
├── package.json         … 依存関係（Vercel が npm install）
├── api/index.mjs        … Serverless API 入口
├── api-server/app.mjs   … Express 本体
├── migrations/*.sql     … DB スキーマ
└── machining-quote-4pane-mock.html
```
