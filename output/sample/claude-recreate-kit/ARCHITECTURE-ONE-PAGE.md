# アーキテクチャ 1 枚

## 利用者・前提（2026-07）

```
当社のみ · Win PC / iPad · ブラウザ
見積データ → PostgreSQL に保存
マルチテナント不要
```

## 構成図

```
┌─────────────────────────────────────────────────────────┐
│  machining-quote-4pane-mock.html                        │
│  · 4ペイン UI · calcRow · マスタ(暫定localStorage)       │
│  · sessionStorage 下書き退避                             │
└───────────────────────────┬─────────────────────────────┘
                            │ fetch /api/*
┌───────────────────────────▼─────────────────────────────┐
│  api-server/app.mjs  (Express / Vercel serverless)        │
│  · quotes CRUD · confirm · health                         │
│  · drawings/analyze · similar-diff · feedback             │
└───────────────────────────┬─────────────────────────────┘
                            │ pg
┌───────────────────────────▼─────────────────────────────┐
│  PostgreSQL (Neon or 社内)                              │
│  quotes · quote_revisions · quote_operations            │
│  materials · products · settings · quote_index          │
│  ai_suggestions · ai_feedback · counters                │
└─────────────────────────────────────────────────────────┘
```

## ペインデータフロー

```
① 案件入力 + 工程 params
        ↓
② 材質マスタ → Vc,f,ap,n上限 + 案件上書き(caseOverrides)
        ↓
    calcRow() → 各行 分・円
        ↓
③ 内訳表示 + 段取り按分
        ↓
④ サマリ・メモ・類似案件・PDF/コピー
        ↓
   PUT /draft  →  DB (rev NULL)
   POST /confirm → DB (rev 1,2,… 凍結)
```

## 主要 JS データ（HTML 内）

```javascript
materialMaster   // { S45C: { vc, f, ap, vcHole, fHole, nMaxTurn, nMaxHole, density, priceKg } }
productMaster    // { shaft: { name, sort, processRows[] } }
customerMaster   // { id: { name, sort } }
shopMaster       // { hourlyRate, companyName, tel, fax, quoteValidityDays }
processes[]      // { id, type, data, aiSuggested? }
caseOverrides    // 案件ごと材質別ペイン2上書き
currentDraftRef  // 'D-0042' 等
quoteViewMode    // 'draft' | 'rev1' | ...
```

## DB 主要表（概要）

| 表 | 役割 |
|----|------|
| `quotes` | draft_no, formal_id, customer_name, drawing_no |
| `quote_revisions` | rev(NULL=下書き), 寸法·qty·product·スナップショット列 |
| `quote_operations` | type, sort_order, params JSON, minutes, amount_yen |
| `materials` | 材質マスタ |
| `products` | 品名マスタ |
| `settings` | 時間単価・社名等 1行 |
| `quote_index` | 類似検索用（確定 rev のみ） |

## デプロイ

| 環境 | 内容 |
|------|------|
| ローカル | `npm start` → :3847 |
| 本番 | Vercel + `DATABASE_URL` (Neon) |
| 静的 | HTML/JS は CDN、/api/* は serverless |

## 次の実装優先（当社専用）

1. 起動時 **新規 draft**（D-0042 廃止）
2. **マスタ API + DB**（localStorage 廃止）
3. 軽量 **アクセス制限**
