# 継続開発プロンプト集

---

## 汎用テンプレ

```
【コンテキスト】
加工費見積ツール（output/sample/machining-quote-4pane-mock.html）
設計: machining-quote-design-memo.md
当社専用・見積は DB 保存

【前回まで】
（ここに前のスレッドの要約を貼る）

【今回やること】
（具体的な 1 タスク）

【制約】
- 最小 diff
- 計算式・確定 rev 凍結ルールは変更しない
- 日本語 UI
- 完了後: 変更ファイル・確認手順・未 push ならその旨
```

---

## Phase 1 — 新規 draft 自動作成

```
起動時の currentDraftRef='D-0042' 固定を廃止してください。
- DB 有効時: 最後に開いた draft を localStorage で記憶、なければ POST /api/quotes
- 404 時は ensure=1 または新規作成
- ステータスバーに draft_no を表示
```

---

## Phase 2 — マスタ DB 化

```
localStorage マスタ（v24）を PostgreSQL に移行してください。
- materials に n_max_turn, n_max_hole 列追加（または JSON）
- products 標準工程（process_rows JSON）
- customers テーブル新設 or settings 拡張
- GET/PUT /api/masters/* 
- HTML の saveMastersToLocalStorage を API 保存に差し替え
```

---

## モバイル調整

```
v25 モバイルタブ UI の（具体的な不具合・要望）を修正してください。
768px 未満: 下部タブ 1・2・3・4
768–1279px: 縦スクロール積み上げ
1280px+: 既存 4 ペイン + リサイズ
```

---

## 類似案件 AI

```
類似案件の AI 差分要約（similar-diff）が動かない原因を調査し修正してください。
js/similar-diff/client.mjs と api-server/similar-diff.mjs を参照。
GOOGLE_API_KEY 未設定時はルールベースのみでよい。
```

---

## デプロイ

```
DEPLOY-VERCEL.md に沿い、github main への push 前チェックリストを実行してください。
/api/health の db.connected、下書き保存→リロード、確定 rev を確認。
```

---

## バグ報告テンプレ

```
【現象】
【再現手順】
【期待】
【環境】ローカル / Vercel、ブラウザ、DB 有無
【関連ファイル】（わかれば）

添付モックを読み、原因と最小修正を提案→実装してください。
```
