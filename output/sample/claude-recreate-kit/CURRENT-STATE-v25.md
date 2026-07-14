# 実装状態スナップショット（v29 · 2026-07）

`machining-quote-4pane-mock.html` と `api-server/` の現状。Claude が「どこまでできているか」を把握する用。

## 画面・UX（実装済み）

| 機能 | 状態 | メモ |
|------|------|------|
| 4ペイン レイアウト | ✅ | 1280px+ で左右分割・ドラッグリサイズ |
| ペイン1 縦フォーム | ✅ | 顧客·図番·品名·材質·φ·L·本数·段取り·材料費 |
| 工程リスト | ✅ | ドラッグ並替・複製・削除 |
| 工程入力 | ✅ | 全項目一画面 + 固定「確定」バー（v22） |
| 加工条件ペイン2 | ✅ | Vc/f/ap・穴、案件上書き（黄色） |
| 材質 n 上限 | ✅ | nMaxTurn/nMaxHole でクリップ（v22） |
| ペイン1 ±ボタン | ✅ | 径·L·本数·段取り·材料費（v23） |
| マスタ管理 UI | ✅ | 材質·品名(標準工程)·顧客·共通·テンプレ |
| 案件一覧 | ✅ | API + 検索 UI |
| rev セレクタ | ✅ | 下書き / rev1 / rev2、確定は読取専用 |
| サマリ3行メモ | ✅ | 自動生成 |
| 類似案件 | ✅ | 折りたたみ + AI 差分（API あれば） |
| FAX PDF モーダル | ✅ | 確定版のみ |
| 顧客回答コピー | ✅ | テンプレ置換 |
| モバイル | ✅ | <768 下部タブ、768–1279 縦積み（v25） |
| ベージュ UI | ✅ | v21 CSS 変数 |
| 起動時案件の自動決定 | ✅ | v26: 前回案件を localStorage で再開、なければ POST /api/quotes で新規。API 不通時のみ D-0042 退避 |

## データ・API（実装済み）

| 機能 | 状態 | メモ |
|------|------|------|
| PostgreSQL スキーマ | ✅ | migrations 001–003 |
| 下書き GET/PUT | ✅ | quotes-db.mjs |
| 新規案件 POST | ✅ | |
| 版確定 POST | ✅ | 金額スナップショット |
| 案件一覧 GET | ✅ | |
| sessionStorage 下書き退避 | ✅ | DB 不通時フォールバック |
| マスタ DB 共有 | ✅ | v28: GET/PUT /api/masters（材質·品名·顧客·共通·テンプレ）。DB が正本、localStorage はオフライン用キャッシュ。初回起動時に端末保存分を自動移行 |
| 仕入れ実勢単価 | ✅ | v29: material-pricing.html（旧デスクトップ material-estimator を DB 化移植・蓄積 UI そのまま）+ 材料費欄に実勢バッジ（±10%で警告）+ ワンクリックでマスタ反映 |
| 図面 AI analyze | ✅ | v27: ペイン1に添付 UI 復活（写真/PDF → Gemini 読み取り → 欄・工程提案）。図面はメモリのみ、DB 保存なし |
| AI feedback / learn | ✅ | デモ |

## 未着手・要改善（当社専用前提）

| 項目 | 優先 | 内容 |
|------|------|------|
| アクセス制限 | **高** | Vercel パスワード / VPN（DESIGN-REVIEW S1） |
| バックアップ手順 | 低 | pg_dump 運用文書化 |
| Next.js 移行 | 低 | 設計メモの将来像 |

## 意図的に v1 外

- 図面のみで見積完成（人の確認必須）
- マルチテナント・ログイン
- 至急フラグ・開始位置 mm
- オフライン編集
- PDF の DB 保存

## 版履歴（モック HTML）

| 版 | 内容 |
|----|------|
| v21 | ベージュ UI |
| v22 | n 上限 + 工程入力一画面化 |
| v23 | ペイン1 ±ボタン |
| v24 | マスタ localStorage 永続化 |
| v25 | スマホ·タブレット対応 |
| v26 | 起動時 D-0042 固定を廃止（前回案件の再開 / 新規 draft 自動作成） |
| v27 | 図面添付 UI 復活 + 同一オリジン API 判定バグ修正（デモ落ち解消）+ Gemini モデルを 2.5-flash に更新 |
| v28 | マスタ DB 化（migrations/004 · customers 新設 · materials n_max 列 · products 標準工程列 · GET/PUT /api/masters） |
| v29 | 材料仕入れ記録ツールを統合（migrations/005 · /api/material-purchases · 実勢単価バッジ · マスタ反映ボタン） |
| v29fix | バグレビュー13件修正: 仕入れ記録の削除復活（version管理）・死んだ案件refの自己回復・案件切替時の図面破棄・確定rev閲覧中のAI適用防止・AI取込の多重送信/HEIC対応・実勢バッジのタブ復帰更新・APIエラーのJSON化・Gemini抽出の専用system指示・六角材のサマリ除外ほか |

## Git リモート

- `github` → `jun8rou-droid/creating-visual-explainers` main
- 本番: Vercel（Root: `output/sample`）
