-- 材料単価の仕入れ記録（v29 · material-pricing.html の保存先）
-- extra には画面側レコードの原本 JSON を保持し、往復で欠損しないようにする

CREATE TABLE IF NOT EXISTS material_purchases (
  id             TEXT PRIMARY KEY,
  purchase_date  DATE NOT NULL,
  supplier       TEXT NOT NULL DEFAULT '',
  material_key   TEXT NOT NULL,
  dia            DOUBLE PRECISION NOT NULL,
  len            DOUBLE PRECISION NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1,
  total_yen      DOUBLE PRECISION NOT NULL,
  yen_kg         DOUBLE PRECISION NOT NULL,
  extra          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_material_purchases_key_date
  ON material_purchases (material_key, purchase_date DESC);

COMMENT ON TABLE material_purchases IS '材料の仕入れ実績（日付·仕入先·材質·φ·L·本数·金額·円/kg）';
