/**
 * 材料屋さん入力ページ（material-nonyu.html）の取引先と納入明細の登録
 *
 * 取引先ごとに access_key を発行し、専用 URL（material-nonyu.html?k=KEY）から
 * 送信された明細を material_purchases に「追記」する（全置換はしない）。
 */

import crypto from 'crypto';
import { query } from './db.mjs';
import { insertPurchases } from './purchases-db.mjs';

/* material-pricing.html の MATERIALS と同じ表（key / 表示名 / 比重）。
   ポータルは材質をこのリストから選ばせるので、重量計算はサーバ側で行える */
export const PORTAL_MATERIALS = [
  { key: 'SS400_MIG', label: 'SS400磨', rho: 7.85 },
  { key: 'SS400_KURO', label: 'SS400黒皮', rho: 7.85 },
  { key: 'S25C', label: 'S25C', rho: 7.85 },
  { key: 'SCM435H', label: 'SCM435H', rho: 7.85 },
  { key: 'SNB7', label: 'SNB7', rho: 7.85 },
  { key: 'SNB16', label: 'SNB16', rho: 7.85 },
  { key: 'S45CH', label: 'S45CH', rho: 7.85 },
  { key: 'S45C_MIG', label: 'S45C磨', rho: 7.85 },
  { key: 'S45C_KURO', label: 'S45C黒皮', rho: 7.85 },
  { key: 'SUS304_MIG', label: 'SUS304磨', rho: 7.93 },
  { key: 'SUS304_PL', label: 'SUS304ピーリング', rho: 7.93 },
  { key: 'SUS304_SAN', label: 'SUS304酸', rho: 7.93 },
  { key: 'SUS304_SKINPASS_HEX', label: 'SUS304スキンパス六角', rho: 7.93 },
  { key: 'SUS304_SAN_HEX', label: 'SUS304酸洗六角', rho: 7.93 },
  { key: 'SUS304_MIG_HEX', label: 'SUS304磨き六角', rho: 7.93 },
  { key: 'SUS403', label: 'SUS403', rho: 7.75 },
  { key: 'SUS303_PL', label: 'SUS303ピーリング', rho: 7.93 },
  { key: 'SUS303_MIG', label: 'SUS303磨', rho: 7.93 },
  { key: 'SUS316', label: 'SUS316', rho: 7.98 },
  { key: 'SUS316L', label: 'SUS316L', rho: 7.98 },
  { key: 'SUS321', label: 'SUS321', rho: 7.93 },
  { key: 'SUS304N2', label: 'SUS304N2', rho: 7.93 },
  { key: 'SUS309S', label: 'SUS309S', rho: 7.98 },
  { key: 'SUS310S', label: 'SUS310S', rho: 7.98 },
  { key: 'SUS347', label: 'SUS347', rho: 8.03 },
  { key: 'SUS630', label: 'SUS630（17-4PH）', rho: 7.78 },
  { key: 'XM19', label: 'XM-19（Nitronic50）', rho: 7.88 },
  { key: 'ALLOY718', label: 'Alloy718（Inconel718）', rho: 8.19 },
  { key: 'SUS420J2HT', label: 'SUS420J2HT', rho: 7.75 },
  { key: 'AL5052', label: 'アルミ（参考）', rho: 2.70 },
  { key: 'CU', label: '銅（参考）', rho: 8.96 },
  { key: 'BRASS', label: '黄銅（参考）', rho: 8.50 },
  { key: 'TI', label: 'チタン（参考）', rho: 4.51 },
];

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

export async function listSuppliers() {
  const res = await query(
    `SELECT id, name, access_key, disabled, to_char(created_at, 'YYYY-MM-DD') AS created
     FROM material_suppliers ORDER BY created_at`,
  );
  return res.rows.map((r) => ({
    id: r.id, name: r.name, accessKey: r.access_key, disabled: r.disabled, created: r.created,
  }));
}

export async function createSupplier(name) {
  const n = String(name || '').trim().slice(0, 100);
  if (!n) throw badRequest('取引先名を入力してください');
  const dup = await query('SELECT 1 FROM material_suppliers WHERE name = $1 AND NOT disabled', [n]);
  if (dup.rows.length) throw badRequest('同じ名前の取引先がすでにあります');
  const id = 'ms_' + crypto.randomBytes(6).toString('hex');
  const key = crypto.randomBytes(9).toString('base64url');
  await query(
    'INSERT INTO material_suppliers (id, name, access_key) VALUES ($1, $2, $3)',
    [id, n, key],
  );
  return { id, name: n, accessKey: key, disabled: false };
}

export async function deleteSupplier(id) {
  const res = await query('DELETE FROM material_suppliers WHERE id = $1', [String(id || '')]);
  if (!res.rowCount) throw badRequest('取引先が見つかりません');
  return { ok: true };
}

export async function getSupplierByKey(key) {
  const k = String(key || '').trim();
  if (!k || k.length > 64) return null;
  const res = await query(
    'SELECT id, name FROM material_suppliers WHERE access_key = $1 AND NOT disabled',
    [k],
  );
  return res.rows[0] || null;
}

function kgOneBar(d, l, rho) {
  return (Math.PI * (d / 2) * (d / 2) * l / 1000) * rho / 1000;
}

/**
 * 材料屋さんからの納入明細を蓄積レコード形式に変換して追記する
 * @param {{ id: string, name: string }} supplier
 * @param {string} date YYYY-MM-DD
 * @param {Array<{materialKey: string, d: number, l: number, qty: number, totalYen: number}>} items
 */
export async function insertDeliveries(supplier, date, items) {
  const dateStr = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw badRequest('納入日を選んでください');
  if (!Array.isArray(items) || !items.length) throw badRequest('明細が1行もありません');
  if (items.length > 50) throw badRequest('一度に送れるのは50行までです');

  const nowIso = new Date().toISOString();
  const records = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const mat = PORTAL_MATERIALS.find((m) => m.key === String(it.materialKey || ''));
    const d = Number(it.d);
    const l = Number(it.l);
    const qty = Math.round(Number(it.qty));
    const totalYen = Number(it.totalYen);
    const row = i + 1;
    if (!mat) throw badRequest(row + '行目: 材質を選んでください');
    if (!Number.isFinite(d) || d <= 0 || d > 1000) throw badRequest(row + '行目: 径（mm）を確認してください');
    if (!Number.isFinite(l) || l <= 0 || l > 30000) throw badRequest(row + '行目: 長さ（mm）を確認してください');
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) throw badRequest(row + '行目: 本数を確認してください');
    if (!Number.isFinite(totalYen) || totalYen <= 0 || totalYen > 100000000) throw badRequest(row + '行目: 金額（円）を確認してください');
    const kg = kgOneBar(d, l, mat.rho) * qty;
    if (!(kg > 0)) throw badRequest(row + '行目: 重量を計算できませんでした');
    records.push({
      id: 'sp_' + crypto.randomBytes(8).toString('hex'),
      date: dateStr,
      supplier: supplier.name,
      materialKey: mat.key,
      d, l, qty,
      totalYen: Math.round(totalYen),
      totalKg: kg,
      yenPerKg: Math.round((totalYen / kg) * 100) / 100,
      memo: '材料屋さん入力',
      source: 'nonyu',
      supplierId: supplier.id,
      submittedAt: nowIso,
    });
  }
  const r = await insertPurchases(records);
  return { ok: true, count: records.length, version: r.version, records };
}

/** 取引先本人向け: 自分が送信した直近の明細 */
export async function listRecentBySupplier(supplierId, limit) {
  const res = await query(
    `SELECT extra FROM material_purchases
     WHERE extra->>'supplierId' = $1
     ORDER BY created_at DESC LIMIT $2`,
    [String(supplierId || ''), Math.min(Math.max(Number(limit) || 10, 1), 30)],
  );
  return res.rows.map((r) => r.extra).filter((x) => x && typeof x === 'object');
}
