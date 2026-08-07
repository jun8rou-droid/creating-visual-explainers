-- material-pricing.html の共有設定（基準キロ単価の手動上書きなど）
-- 全端末で同じ設定を見るため DB に保存する（counters は BIGINT のため別表）

CREATE TABLE IF NOT EXISTS material_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE material_settings IS '材料単価ツールの共有設定（JSON）';
