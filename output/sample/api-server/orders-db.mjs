/**
 * 材料の発注・見積依頼（material_orders）
 *
 * 流れ: 管理画面から作成 → 取引先へメール（専用URL） → material-nonyu.html で
 * 単価（と発注なら納入予定日）を回答 → 回答単価は蓄積（material_purchases）へ自動追記
 */

import crypto from 'crypto';
import { query } from './db.mjs';
import { PORTAL_MATERIALS, kgOneBar } from './material-suppliers-db.mjs';
import { insertPurchases } from './purchases-db.mjs';

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const KIND_LABEL = { order: '発注', quote: '見積依頼' };

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) throw badRequest('明細が1行もありません');
  if (items.length > 50) throw badRequest('明細は50行までです');
  return items.map((it, i) => {
    const row = i + 1;
    const mat = PORTAL_MATERIALS.find((m) => m.key === String(it && it.materialKey || ''));
    const d = Number(it && it.d);
    const l = Number(it && it.l);
    const qty = Math.round(Number(it && it.qty));
    if (!mat) throw badRequest(row + '行目: 材質を選んでください');
    if (!Number.isFinite(d) || d <= 0 || d > 1000) throw badRequest(row + '行目: 径（mm）を確認してください');
    if (!Number.isFinite(l) || l <= 0 || l > 30000) throw badRequest(row + '行目: 長さ（mm）を確認してください');
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) throw badRequest(row + '行目: 本数を確認してください');
    return { materialKey: mat.key, label: mat.label, d, l, qty, unitPrice: null };
  });
}

function rowToOrder(r, supplierName) {
  return {
    id: r.id,
    supplierId: r.supplier_id,
    supplierName: supplierName != null ? supplierName : r.supplier_name,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind] || r.kind,
    status: r.status,
    note: r.note,
    items: Array.isArray(r.items) ? r.items : [],
    deliveryDate: r.delivery_date ? String(r.delivery_date_str || r.delivery_date).slice(0, 10) : null,
    created: r.created_str || '',
    answered: r.answered_str || '',
  };
}

const ORDER_COLS = `id, supplier_id, kind, status, note, items, delivery_date,
  to_char(delivery_date, 'YYYY-MM-DD') AS delivery_date_str,
  to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS created_str,
  to_char(answered_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS answered_str`;

export async function createOrder(supplierId, kind, items, note) {
  if (kind !== 'order' && kind !== 'quote') throw badRequest('種別が不正です');
  const sup = await query('SELECT id, name, email, access_key FROM material_suppliers WHERE id = $1 AND NOT disabled', [String(supplierId || '')]);
  if (!sup.rows.length) throw badRequest('取引先が見つかりません');
  const normalized = normalizeItems(items);
  const id = 'mo_' + crypto.randomBytes(6).toString('hex');
  await query(
    `INSERT INTO material_orders (id, supplier_id, kind, note, items)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, supplierId, kind, String(note || '').slice(0, 500), JSON.stringify(normalized)],
  );
  const res = await query(`SELECT ${ORDER_COLS} FROM material_orders WHERE id = $1`, [id]);
  return { order: rowToOrder(res.rows[0], sup.rows[0].name), supplier: sup.rows[0] };
}

export async function listOrders() {
  const res = await query(
    `SELECT o.*, s.name AS supplier_name,
       to_char(o.delivery_date, 'YYYY-MM-DD') AS delivery_date_str,
       to_char(o.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS created_str,
       to_char(o.answered_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS answered_str
     FROM material_orders o
     LEFT JOIN material_suppliers s ON s.id = o.supplier_id
     ORDER BY o.created_at DESC LIMIT 100`,
  );
  return res.rows.map((r) => rowToOrder(r));
}

export async function deleteOrder(id) {
  const res = await query('DELETE FROM material_orders WHERE id = $1', [String(id || '')]);
  if (!res.rowCount) throw badRequest('依頼が見つかりません');
  return { ok: true };
}

/** 取引先向け: 回答待ち＋最近回答した分 */
export async function listOrdersForSupplier(supplierId) {
  const res = await query(
    `SELECT ${ORDER_COLS} FROM material_orders
     WHERE supplier_id = $1 AND status <> 'canceled'
       AND (status = 'sent' OR created_at > now() - interval '60 days')
     ORDER BY (status = 'sent') DESC, created_at DESC LIMIT 20`,
    [String(supplierId || '')],
  );
  return res.rows.map((r) => rowToOrder(r));
}

/**
 * 取引先の回答（単価＋発注なら納入予定日）を保存し、蓄積へ自動追記する
 * @param {{id: string, name: string}} supplier
 * @param {string} orderId
 * @param {{unitPrices: Array<number|null>, deliveryDate?: string}} answer
 */
export async function answerOrder(supplier, orderId, answer) {
  const res = await query(
    `SELECT ${ORDER_COLS} FROM material_orders WHERE id = $1 AND supplier_id = $2`,
    [String(orderId || ''), supplier.id],
  );
  if (!res.rows.length) throw badRequest('依頼が見つかりません');
  const order = rowToOrder(res.rows[0], supplier.name);
  if (order.status !== 'sent') throw badRequest('この依頼はすでに回答済みです');

  const prices = Array.isArray(answer && answer.unitPrices) ? answer.unitPrices : [];
  const items = order.items.map((it, i) => {
    const p = Number(prices[i]);
    return { ...it, unitPrice: Number.isFinite(p) && p > 0 && p <= 100000000 ? Math.round(p) : null };
  });
  if (!items.some((it) => it.unitPrice != null)) throw badRequest('単価を1行以上入力してください');

  let deliveryDate = null;
  if (order.kind === 'order') {
    const dstr = String(answer && answer.deliveryDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dstr)) throw badRequest('納入予定日を選んでください');
    deliveryDate = dstr;
  }

  await query(
    `UPDATE material_orders
     SET items = $2::jsonb, status = 'answered', delivery_date = $3, answered_at = now()
     WHERE id = $1`,
    [order.id, JSON.stringify(items), deliveryDate],
  );

  /* 回答単価を蓄積へ追記（単価が入った行のみ） */
  const memo = order.kind === 'order' ? '発注回答' : '見積回答';
  const nowIso = new Date().toISOString();
  const records = [];
  for (const it of items) {
    if (it.unitPrice == null) continue;
    const mat = PORTAL_MATERIALS.find((m) => m.key === it.materialKey);
    if (!mat) continue;
    const kg = kgOneBar(it.d, it.l, mat.rho, mat.key) * it.qty;
    if (!(kg > 0)) continue;
    const totalYen = it.unitPrice * it.qty;
    records.push({
      id: 'oa_' + crypto.randomBytes(8).toString('hex'),
      date: jstToday(),
      supplier: supplier.name,
      materialKey: mat.key,
      d: it.d,
      l: it.l,
      qty: it.qty,
      totalYen,
      totalKg: kg,
      yenPerKg: Math.round((totalYen / kg) * 100) / 100,
      memo,
      source: 'nonyu',
      supplierId: supplier.id,
      orderId: order.id,
      submittedAt: nowIso,
    });
  }
  let registered = 0;
  if (records.length) {
    const r = await insertPurchases(records);
    registered = r.count;
  }

  const after = await query(`SELECT ${ORDER_COLS} FROM material_orders WHERE id = $1`, [order.id]);
  return { ok: true, order: rowToOrder(after.rows[0], supplier.name), registered };
}
