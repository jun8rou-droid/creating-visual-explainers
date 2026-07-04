-- デモ用シード（モック machining-quote-4pane-mock.html と整合）

INSERT INTO materials (id, vc, f, ap, vc_hole, f_hole, density, price_kg)
VALUES
  ('S45C',   120, 0.15, 1.0, 80, 0.08, 7.85, 180),
  ('SUS304',  90, 0.12, 0.8, 60, 0.06, 7.93, 450)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, name, sort_order, active)
VALUES
  ('spacer',  'スペーサー',     10, true),
  ('shaft',   'シャフト',       20, true),
  ('collar',  'カラー',         30, true),
  ('bush',    'ブッシュ',       40, true),
  ('pin',     'ピン',           50, true),
  ('nozzle',  'ノズル',         60, true),
  ('fitting', '継手（配管用）', 70, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO settings (id, hourly_rate, company_name, company_tel, company_fax, quote_validity_days)
VALUES (
  1,
  4200,
  '株式会社サンプル精機',
  '03-1234-5678',
  '03-1234-5679',
  14
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO response_templates (kind, body)
VALUES
  (
    'included',
    E'お見積りの件、下記のとおりご連絡いたします。\n\n{customer_line}{drawing_line}品名：{product}\n材質：{material}  φ{dia}  L{length}\n数量：{qty}本\n\n単価：¥{unit_total}/個（加工 ¥{unit_machining} + 材料 ¥{unit_material}）\nロット合計：¥{lot_total}\n{material_note}\n\n案件番号：{formal_id}\n\n以上、ご検討のほどよろしくお願いいたします。'
  ),
  (
    'supplied',
    E'お見積りの件、下記のとおりご連絡いたします。\n\n{customer_line}{drawing_line}品名：{product}\n材質：{material}  φ{dia}  L{length}\n数量：{qty}本\n\n加工単価：¥{unit_machining}/個\n{qty}本 加工合計 ¥{lot_total}\n{material_note}\n\n案件番号：{formal_id}\n\n以上、ご検討のほどよろしくお願いいたします。'
  )
ON CONFLICT (kind) DO NOTHING;

INSERT INTO counters (key, value)
VALUES
  ('draft_next', 44),
  ('quote:20260607', 1)
ON CONFLICT (key) DO NOTHING;

-- デモ案件（モックの D-0042 / Q-20260607-001）
INSERT INTO quotes (draft_no, formal_id, customer_name, drawing_no)
VALUES ('D-0042', 'Q-20260607-001', '株式会社サンプル', 'DWG-S45C-001')
ON CONFLICT (draft_no) DO NOTHING;

-- 下書き rev（編集中）
INSERT INTO quote_revisions (
  quote_id, rev, material_id, dia, len, qty, material_mode, setup_minutes,
  product_mode, product_id, product_label
)
SELECT
  q.id, NULL, 'S45C', 50, 120, 10, 'included', 30,
  'catalog', 'shaft', 'シャフト'
FROM quotes q
WHERE q.draft_no = 'D-0042'
  AND NOT EXISTS (
    SELECT 1 FROM quote_revisions r WHERE r.quote_id = q.id AND r.rev IS NULL
  );

-- 確定 rev1（スナップショット）
INSERT INTO quote_revisions (
  quote_id, rev, material_id, dia, len, qty, material_mode, setup_minutes,
  product_mode, product_id, product_label,
  unit_machining_before, unit_machining_after, setup_share_per_unit,
  unit_material, unit_total, lot_machining, lot_material, lot_total,
  hourly_rate_at_confirm,
  memo_material, memo_time, memo_amount,
  confirmed_at
)
SELECT
  q.id, 1, 'S45C', 50, 120, 10, 'included', 30,
  'catalog', 'shaft', 'シャフト',
  1420, 1440, 40, 160, 1580, 14400, 1600, 16000, 4200,
  'シャフト · S45C · 丸棒 φ50 · L120 · 材料込み',
  '段取り30分 · 加工計120分',
  '¥1,580/個（ロット ¥15,800）',
  '2026-06-07'::timestamptz
FROM quotes q
WHERE q.draft_no = 'D-0042'
  AND NOT EXISTS (
    SELECT 1 FROM quote_revisions r WHERE r.quote_id = q.id AND r.rev = 1
  );

-- 確定 rev2
INSERT INTO quote_revisions (
  quote_id, rev, material_id, dia, len, qty, material_mode, setup_minutes,
  product_mode, product_id, product_label,
  unit_machining_before, unit_machining_after, setup_share_per_unit,
  unit_material, unit_total, lot_machining, lot_material, lot_total,
  hourly_rate_at_confirm,
  memo_material, memo_time, memo_amount,
  confirmed_at
)
SELECT
  q.id, 2, 'S45C', 50, 120, 10, 'included', 30,
  'catalog', 'shaft', 'シャフト',
  1360, 1380, 40, 160, 1520, 13800, 1600, 15400, 4200,
  'シャフト · S45C · 丸棒 φ50 · L120 · 材料込み',
  '段取り30分 · 加工計115分',
  '¥1,520/個（ロット ¥15,200）',
  '2026-06-14'::timestamptz
FROM quotes q
WHERE q.draft_no = 'D-0042'
  AND NOT EXISTS (
    SELECT 1 FROM quote_revisions r WHERE r.quote_id = q.id AND r.rev = 2
  );

-- 工程（rev2 確定分のデモ）
INSERT INTO quote_operations (revision_id, sort_order, type, params, minutes, amount_yen)
SELECT r.id, ops.sort_order, ops.type, ops.params::jsonb, ops.minutes, ops.amount_yen
FROM quote_revisions r
JOIN quotes q ON q.id = r.quote_id
CROSS JOIN (
  VALUES
    (0, 'od',    '{"startDia":"","finishDia":"40","cutLen":"40"}', 18.0, 1260),
    (1, 'od',    '{"startDia":"50","finishDia":"40","cutLen":"80"}', 42.0, 2940),
    (2, 'hole',  '{"holeDia":"10","depth":"25"}', 12.0, 840),
    (3, 'face',  '{"seconds":"90"}', 1.5, 105),
    (4, 'other', '{"name":"面取り","seconds":"120"}', 2.0, 140)
) AS ops(sort_order, type, params, minutes, amount_yen)
WHERE q.draft_no = 'D-0042' AND r.rev = 2
  AND NOT EXISTS (
    SELECT 1 FROM quote_operations o WHERE o.revision_id = r.id
  );

-- 類似案件インデックス（rev2）
INSERT INTO quote_index (
  revision_id, quote_id, formal_id, rev, qty, process_count, material_mode,
  product_mode, product_id, product_label, material_id, dia, len,
  customer_name, drawing_no, unit_machining, unit_total, confirmed_at
)
SELECT
  r.id, q.id, q.formal_id, r.rev, r.qty, 5, r.material_mode,
  r.product_mode, r.product_id, r.product_label, r.material_id, r.dia, r.len,
  q.customer_name, q.drawing_no, r.unit_machining_after, r.unit_total, r.confirmed_at
FROM quote_revisions r
JOIN quotes q ON q.id = r.quote_id
WHERE q.draft_no = 'D-0042' AND r.rev = 2
ON CONFLICT (revision_id) DO NOTHING;
