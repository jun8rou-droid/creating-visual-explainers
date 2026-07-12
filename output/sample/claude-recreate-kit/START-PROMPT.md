# 初回プロンプト集（コピペ用）

Claude Projects の **最初のメッセージ** または **新スレッド** で使う。

---

## A. ゼロから再現（フルスタック）

```
加工費見積ツールを、添付の設計メモとモック HTML に沿って実装してください。

【ゴール】
- 4ペイン UI（入力·工程 / 加工条件 / 内訳 / サマリ）
- 外径・穴はマスタから自動計算、溝·端面·その他は秒入力
- PostgreSQL に下書き保存・版確定・案件一覧
- Express API + 単一 HTML クライアント（まずモック同等でよい）

【前提】
- 当社専用。マルチテナント不要
- 見積データは DB に残す
- AI は類似案件差分要約のみ（金額はマスタ計算）

【手順】
1. machining-quote-design-memo.md と SCOPE-LOCKED.md を読み、要件を箇条書きで要約してから着手
2. migrations/001_init.sql 相当のスキーマ
3. quotes API（一覧・下書き GET/PUT・confirm）
4. フロント（計算式は設計メモの式をそのまま）
5. ローカル起動手順を README に書く

不明点は実装前に質問してください。
```

---

## B. 既存モックの改善（このリポジトリ継続）

```
creating-visual-explainers/output/sample の加工費見積モックを継続開発します。

【読むファイル】
- claude-recreate-kit/CURRENT-STATE-v25.md
- machining-quote-4pane-mock.html
- machining-quote-design-memo.md

【今回のタスク】
Phase 1: 起動時に D-0042 固定をやめ、新規 draft を自動作成する。
- POST /api/quotes で新規案件
- currentDraftRef を更新
- 複数人が同じ下書きを上書きしないようにする

既存の計算・UI スタイルを壊さず、最小 diff で実装してください。
完了後に変更ファイルと動作確認手順を日本語で報告してください。
```

---

## C. UI のみ（静的モック）

```
machining-quote-4pane-mock.html をベースに、UI だけ改善してください。

【制約】
- 4ペイン構成は維持
- ベージュ UI（CSS 変数 --app-bg 等）
- スマホは下部タブ、タブレットは縦スクロール（v25 参照）
- API 接続はモックのままでよい

【タスク】
（ここに具体的な UI 要望を書く）
```

---

## D. DB・API のみ

```
見積ツールのバックエンドだけ実装・修正してください。

【正本】
- migrations/*.sql
- api-server/quotes-db.mjs
- api-server/app.mjs

【タスク】
材質・品名・顧客マスタを DB から読み書きする API を追加し、
HTML の localStorage マスタ（v24）を置き換える設計にしてください。
当社専用のため tenant_id は不要です。

エンドポイント案・マイグレーション SQL・既存 draft API との整合を先に提示してから実装してください。
```

---

## E. 設計レビューのみ

```
添付の machining-quote-design-memo.md と CURRENT-STATE-v25.md を読み、
当社専用・見積 DB 保存前提で、実装の抜け・矛盾・リスクをレビューしてください。
コードは書かず、優先度付きの改善リストだけ出してください。
```

---

## F. 発表・ドキュメント用

```
machining-quote-session-script.md と設計メモを元に、
社内向け 2 分デモの台本（日本語）を更新してください。
v25 のモバイル対応・マスタ localStorage・n 上限クリップを 1 文ずつ触れてください。
```
