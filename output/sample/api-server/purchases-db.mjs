/**
 * 材料仕入れ記録の DB アクセス（material-pricing.html の保存先）
 *
 * 画面側は記録を配列で丸ごと持つ設計（数百件規模）なので、
 * GET は全件、PUT は全置換とする。extra 列に画面レコードの原本を保持。
 */
import { getPool, query } from './db.mjs';

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** @returns {Promise<object[]>} 画面レコード形式の配列（新しい日付順） */
export async function listPurchases() {
  const res = await query(
    'SELECT extra FROM material_purchases ORDER BY purchase_date DESC, created_at DESC',
  );
  return res.rows.map((r) => r.extra).filter((x) => x && typeof x === 'object');
}

/**
 * 全置換保存
 * @param {object[]} records 画面レコード [{id, date, supplier, matKey, d, l, qty, totalYen, yenKg, ...}]
 */
export async function replacePurchases(records) {
  if (!Array.isArray(records)) throw new Error('records は配列で送ってください');
  if (records.length > 20000) throw new Error('記録が多すぎます');

  const rows = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const d = num(r.d, 0);
    const l = num(r.l, 0);
    const totalYen = num(r.totalYen, NaN);
    const yenKg = num(r.yenPerKg != null ? r.yenPerKg : r.yenKg, NaN);
    if (d <= 0 || l <= 0 || !Number.isFinite(totalYen) || !Number.isFinite(yenKg)) continue;
    const dateStr = String(r.date || '').slice(0, 10);
    rows.push({
      id: String(r.id || (Math.random().toString(36).slice(2) + d + l)).slice(0, 64),
      date: /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : '1970-01-01',
      supplier: String(r.supplier || '').slice(0, 100),
      matKey: String(r.materialKey || r.matKey || 'OTHER').slice(0, 60),
      d, l,
      qty: Math.max(1, Math.round(num(r.qty, 1))),
      totalYen, yenKg,
      extra: r,
    });
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM material_purchases');
    for (const r of rows) {
      await client.query(
        `INSERT INTO material_purchases
           (id, purchase_date, supplier, material_key, dia, len, qty, total_yen, yen_kg, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, r.date, r.supplier, r.matKey, r.d, r.l, r.qty, r.totalYen, r.yenKg,
          JSON.stringify(r.extra)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, count: rows.length };
}

/**
 * 見積ツール用: 材質 ID（S45C, SUS304 等）の実勢単価サマリ。
 * material_key の先頭部（アンダースコア前）が材質 ID に一致する記録を対象にする。
 * @param {string} materialId
 * @returns {Promise<null | { latest: object, avgYenKg: number, count: number }>}
 */
export async function purchaseSummaryFor(materialId) {
  const id = String(materialId || '').trim().toUpperCase();
  if (!id) return null;
  const res = await query(
    `SELECT to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, supplier, material_key, dia, yen_kg
     FROM material_purchases
     WHERE split_part(material_key, '_', 1) = $1 OR material_key = $1
     ORDER BY purchase_date DESC, created_at DESC
     LIMIT 10`,
    [id],
  );
  if (!res.rows.length) return null;
  const latest = res.rows[0];
  const avg = res.rows.reduce((s, r) => s + Number(r.yen_kg), 0) / res.rows.length;
  return {
    latest: {
      date: String(latest.purchase_date).slice(0, 10),
      supplier: latest.supplier,
      materialKey: latest.material_key,
      dia: Number(latest.dia),
      yenKg: Math.round(Number(latest.yen_kg)),
    },
    avgYenKg: Math.round(avg),
    count: res.rows.length,
  };
}
