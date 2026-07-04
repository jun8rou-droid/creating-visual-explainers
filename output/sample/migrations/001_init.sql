-- 加工費見積ツール — コアスキーマ（設計メモ Storage2 · 2026-06）
-- 実行順: 001 → 002_ai_api.sql → 003_seed.sql

-- ---------------------------------------------------------------------------
-- マスタ
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS materials (
  id          TEXT PRIMARY KEY,
  vc          DOUBLE PRECISION NOT NULL,
  f           DOUBLE PRECISION NOT NULL,
  ap          DOUBLE PRECISION NOT NULL,
  vc_hole     DOUBLE PRECISION NOT NULL,
  f_hole      DOUBLE PRECISION NOT NULL,
  density     DOUBLE PRECISION NOT NULL,
  price_kg    DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  hourly_rate         INTEGER NOT NULL,
  company_name        TEXT NOT NULL DEFAULT '',
  company_tel         TEXT NOT NULL DEFAULT '',
  company_fax         TEXT NOT NULL DEFAULT '',
  quote_validity_days INTEGER NOT NULL DEFAULT 14,
  model_version       TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS response_templates (
  kind        TEXT PRIMARY KEY CHECK (kind IN ('included', 'supplied')),
  body        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS counters (
  key         TEXT PRIMARY KEY,
  value       BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 案件 · 版 · 工程
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quotes (
  id              BIGSERIAL PRIMARY KEY,
  draft_no        TEXT NOT NULL UNIQUE,
  formal_id       TEXT UNIQUE,
  customer_name   TEXT NOT NULL DEFAULT '',
  drawing_no      TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotes_formal_id ON quotes (formal_id);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes (customer_name);
CREATE INDEX IF NOT EXISTS idx_quotes_drawing ON quotes (drawing_no);

CREATE TABLE IF NOT EXISTS quote_revisions (
  id                      BIGSERIAL PRIMARY KEY,
  quote_id                BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  rev                     INTEGER,
  material_id             TEXT NOT NULL REFERENCES materials(id),
  dia                     DOUBLE PRECISION NOT NULL,
  len                     DOUBLE PRECISION NOT NULL,
  qty                     INTEGER NOT NULL DEFAULT 1,
  material_mode           TEXT NOT NULL DEFAULT 'included'
                            CHECK (material_mode IN ('included', 'supplied')),
  setup_minutes           DOUBLE PRECISION NOT NULL DEFAULT 0,
  product_mode            TEXT NOT NULL DEFAULT 'catalog'
                            CHECK (product_mode IN ('catalog', 'special', 'other')),
  product_id              TEXT REFERENCES products(id),
  product_label           TEXT NOT NULL DEFAULT '',
  case_overrides          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 確定 rev のみ（下書きは NULL）
  unit_machining_before   INTEGER,
  unit_machining_after    INTEGER,
  setup_share_per_unit    INTEGER,
  unit_material           INTEGER,
  unit_total              INTEGER,
  lot_machining           INTEGER,
  lot_material            INTEGER,
  lot_total               INTEGER,
  hourly_rate_at_confirm  INTEGER,
  memo_material           TEXT,
  memo_time               TEXT,
  memo_amount             TEXT,
  confirmed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quote_revisions_rev_positive CHECK (rev IS NULL OR rev > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_revisions_one_draft
  ON quote_revisions (quote_id)
  WHERE rev IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_revisions_quote_rev
  ON quote_revisions (quote_id, rev)
  WHERE rev IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quote_revisions_quote_id ON quote_revisions (quote_id);

CREATE TABLE IF NOT EXISTS quote_operations (
  id            BIGSERIAL PRIMARY KEY,
  revision_id   BIGINT NOT NULL REFERENCES quote_revisions(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  type          TEXT NOT NULL CHECK (type IN ('od', 'hole', 'groove', 'face', 'other')),
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  minutes       DOUBLE PRECISION,
  amount_yen    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_operations_revision ON quote_operations (revision_id);

CREATE TABLE IF NOT EXISTS quote_drawings (
  id            BIGSERIAL PRIMARY KEY,
  quote_id      BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  nas_path      TEXT,
  file_hash     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_drawings_quote ON quote_drawings (quote_id);

-- ---------------------------------------------------------------------------
-- 類似案件インデックス（確定 rev のみ）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quote_index (
  revision_id     BIGINT PRIMARY KEY REFERENCES quote_revisions(id) ON DELETE CASCADE,
  quote_id        BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  formal_id       TEXT NOT NULL,
  rev             INTEGER NOT NULL,
  qty             INTEGER NOT NULL,
  process_count   INTEGER NOT NULL DEFAULT 0,
  material_mode   TEXT NOT NULL,
  product_mode    TEXT NOT NULL,
  product_id      TEXT,
  product_label   TEXT NOT NULL DEFAULT '',
  material_id     TEXT NOT NULL,
  dia             DOUBLE PRECISION NOT NULL,
  len             DOUBLE PRECISION NOT NULL,
  customer_name   TEXT NOT NULL DEFAULT '',
  drawing_no      TEXT NOT NULL DEFAULT '',
  unit_machining  INTEGER NOT NULL,
  unit_total      INTEGER NOT NULL,
  confirmed_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quote_index_material_dia_len
  ON quote_index (material_id, dia, len);
CREATE INDEX IF NOT EXISTS idx_quote_index_product
  ON quote_index (product_id, product_label);

COMMENT ON TABLE quotes IS '案件（draft_no / formal_id）';
COMMENT ON TABLE quote_revisions IS '版。rev IS NULL = 下書き。確定時は金額スナップショットを凍結';
COMMENT ON TABLE quote_operations IS '工程行。確定 rev のみ minutes/amount_yen を保存';
COMMENT ON TABLE quote_index IS '類似案件検索用（確定 rev のみ）';
