-- AI-API / AI-LEARN（設計メモ 2026-05-25）
-- 依存: 001_init.sql（quotes, quote_revisions 想定）

-- API 提案スナップショット（図面解析・工程提案）
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id                BIGSERIAL PRIMARY KEY,
  quote_id          BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  drawing_id        BIGINT,                    -- quote_drawings.id（将来）
  model_version     TEXT NOT NULL DEFAULT 'api-demo-v1',
  api_model         TEXT,                      -- 例: claude-sonnet-...
  suggestion_json   JSONB NOT NULL,
  confidence_json   JSONB,
  drawing_file_hash TEXT,                      -- 同一ファイル再解析防止
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_quote_id ON ai_suggestions (quote_id);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_hash ON ai_suggestions (drawing_file_hash);

-- 人の操作（採用 / 却下 / 修正）— 版確定後に final_revision_id を埋める
CREATE TABLE IF NOT EXISTS ai_feedback (
  id                  BIGSERIAL PRIMARY KEY,
  suggestion_id       BIGINT NOT NULL REFERENCES ai_suggestions(id) ON DELETE CASCADE,
  user_action         TEXT NOT NULL CHECK (user_action IN ('adopt', 'reject', 'edit')),
  diff_json           JSONB,
  final_revision_id   BIGINT REFERENCES quote_revisions(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_suggestion ON ai_feedback (suggestion_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_revision ON ai_feedback (final_revision_id);

-- 学習モデル版（夜間バッチが合格時のみ更新）
-- settings 表に model_version 列を足すか、別テーブルでも可
CREATE TABLE IF NOT EXISTS ai_model_registry (
  version           TEXT PRIMARY KEY,
  trained_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics_json      JSONB NOT NULL,              -- hold-out MAE 等
  is_active         BOOLEAN NOT NULL DEFAULT false
);

COMMENT ON TABLE ai_suggestions IS 'Vision API 等の提案 JSON（AI-API）';
COMMENT ON TABLE ai_feedback IS '採用/却下/修正 diff — 学習の教師信号（AI-LEARN）';
