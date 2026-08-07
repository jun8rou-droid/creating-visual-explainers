-- 材料屋さん（取引先）の入力ページ用アカウント
-- access_key を知っている取引先だけが material-nonyu.html から明細を送信できる

CREATE TABLE IF NOT EXISTS material_suppliers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  access_key  TEXT NOT NULL UNIQUE,
  disabled    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE material_suppliers IS '材料屋さん入力ページの取引先（専用URLキー）';
