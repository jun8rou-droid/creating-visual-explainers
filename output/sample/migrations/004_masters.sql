-- マスタ DB 化（v28 · 設計レビュー A1+A2）
-- materials: n 上限列を追加 / products: 標準工程テンプレ列を追加 / customers: 新設

ALTER TABLE materials ADD COLUMN IF NOT EXISTS n_max_turn INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS n_max_hole INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- 既存シードへ v22 のフロント既定値を反映（未設定のときだけ）
UPDATE materials SET n_max_turn = 3000, n_max_hole = 4000
  WHERE id = 'S45C' AND n_max_turn IS NULL;
UPDATE materials SET n_max_turn = 2000, n_max_hole = 3000
  WHERE id = 'SUS304' AND n_max_turn IS NULL;

ALTER TABLE products ADD COLUMN IF NOT EXISTS process_rows JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 標準工程テンプレ（モック v19 と整合 · 空のときだけ）
UPDATE products SET process_rows = '[
  {"type":"od","data":{"startDia":"","finishDia":"40","cutLen":"30"}},
  {"type":"face","data":{"seconds":"60"}}
]'::jsonb WHERE id = 'spacer' AND process_rows = '[]'::jsonb;

UPDATE products SET process_rows = '[
  {"type":"od","data":{"startDia":"","finishDia":"40","cutLen":"40"}},
  {"type":"od","data":{"startDia":"50","finishDia":"40","cutLen":"80"}},
  {"type":"hole","data":{"holeDia":"10","depth":"25"}},
  {"type":"face","data":{"seconds":"90"}},
  {"type":"other","data":{"name":"面取り","seconds":"120"}}
]'::jsonb WHERE id = 'shaft' AND process_rows = '[]'::jsonb;

UPDATE products SET process_rows = '[
  {"type":"od","data":{"startDia":"","finishDia":"35","cutLen":"20"}},
  {"type":"face","data":{"seconds":"45"}}
]'::jsonb WHERE id = 'collar' AND process_rows = '[]'::jsonb;

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO customers (id, name, sort_order)
VALUES
  ('sample', '株式会社サンプル', 10),
  ('tanaka', '田中精機',        20),
  ('maru',   '〇〇工業',        30),
  ('yamada', '山田製作所',      40),
  ('sato',   '佐藤金属',        50)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE customers IS '顧客マスタ（見積の顧客名プルダウン）';
COMMENT ON COLUMN materials.n_max_turn IS '旋削の回転数上限 rpm（NULL = 上限なし）';
COMMENT ON COLUMN materials.n_max_hole IS '穴あけの回転数上限 rpm（NULL = 上限なし）';
COMMENT ON COLUMN products.process_rows IS '標準工程テンプレ [{type,data}]（品名選択時に提案）';
