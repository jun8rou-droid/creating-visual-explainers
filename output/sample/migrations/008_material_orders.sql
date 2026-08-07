-- 材料屋さんへの発注・見積依頼（material-nonyu.html で回答してもらう）
-- 明細は JSONB（[{materialKey,d,l,qty,unitPrice}]）。回答で unitPrice と納入予定日が埋まる

CREATE TABLE IF NOT EXISTS material_orders (
  id            TEXT PRIMARY KEY,
  supplier_id   TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'order',   -- 'order'=発注 / 'quote'=見積依頼
  status        TEXT NOT NULL DEFAULT 'sent',    -- 'sent'=依頼中 / 'answered'=回答あり / 'canceled'
  note          TEXT NOT NULL DEFAULT '',
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  delivery_date DATE,                            -- 納入予定日（発注の回答で入る＝手配中）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_material_orders_supplier
  ON material_orders (supplier_id, created_at DESC);

ALTER TABLE material_suppliers ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';

COMMENT ON TABLE material_orders IS '材料の発注・見積依頼（回答は取引先が専用URLから入力）';
