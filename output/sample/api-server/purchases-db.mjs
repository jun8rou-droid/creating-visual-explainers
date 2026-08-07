/**
 * 材料仕入れ記録の DB アクセス（material-pricing.html の保存先）
 *
 * 画面側は記録を配列で丸ごと持つ設計（数百件規模）なので、
 * GET は全件、PUT は全置換とする。extra 列に画面レコードの原本を保持。
 */
import { getPool, query } from './db.mjs';

/** マスタ同様のバージョン番号。0 = 一度も保存されていない（＝端末からの初回移行を許可） */
const PURCHASES_VERSION_KEY = 'purchases_version';

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** @returns {Promise<{records: object[], version: number}>} 画面レコード形式（新しい日付順） */
export async function listPurchases() {
  const [res, ver] = await Promise.all([
    query('SELECT extra FROM material_purchases ORDER BY purchase_date DESC, created_at DESC'),
    query('SELECT value FROM counters WHERE key = $1', [PURCHASES_VERSION_KEY]),
  ]);
  return {
    records: res.rows.map((r) => r.extra).filter((x) => x && typeof x === 'object'),
    version: ver.rows[0] ? Number(ver.rows[0].value) : 0,
  };
}

function normalizeRecords(records) {
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
  return rows;
}

async function insertRow(client, r) {
  const ins = await client.query(
    `INSERT INTO material_purchases
       (id, purchase_date, supplier, material_key, dia, len, qty, total_yen, yen_kg, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [r.id, r.date, r.supplier, r.matKey, r.d, r.l, r.qty, r.totalYen, r.yenKg,
      JSON.stringify(r.extra)],
  );
  return ins.rowCount || 0;
}

/** counters 行をロックして現在版を返す（行が無ければ 0 を作る） */
async function lockVersion(client) {
  const cur = await client.query(
    'SELECT value FROM counters WHERE key = $1 FOR UPDATE',
    [PURCHASES_VERSION_KEY],
  );
  if (cur.rows.length) return Number(cur.rows[0].value);
  await client.query(
    'INSERT INTO counters (key, value) VALUES ($1, 0) ON CONFLICT (key) DO NOTHING',
    [PURCHASES_VERSION_KEY],
  );
  return 0;
}

/**
 * 全置換保存（管理画面用）
 * @param {object[]} records 画面レコード [{id, date, supplier, matKey, d, l, qty, totalYen, yenKg, ...}]
 * @param {number|null} expectedVersion 画面が最後に読んだ版。DB の版と食い違う場合は
 *   err.status=409 で拒否する（材料屋さん入力ページの追記を全置換で消さないため）。
 *   null は旧クライアント互換で照合なし。
 */
export async function replacePurchases(records, expectedVersion) {
  const rows = normalizeRecords(records);
  const client = await getPool().connect();
  let inserted = 0;
  let newVersion = 0;
  try {
    await client.query('BEGIN');
    const current = await lockVersion(client);
    if (expectedVersion != null && Number(expectedVersion) !== current) {
      const err = new Error('他の場所からの保存とぶつかりました。最新の記録を取り込み直します');
      err.status = 409;
      err.currentVersion = current;
      throw err;
    }
    await client.query('DELETE FROM material_purchases');
    for (const r of rows) inserted += await insertRow(client, r);
    const upd = await client.query(
      'UPDATE counters SET value = value + 1 WHERE key = $1 RETURNING value',
      [PURCHASES_VERSION_KEY],
    );
    newVersion = Number(upd.rows[0].value);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, count: inserted, version: newVersion };
}

/**
 * 追記保存（材料屋さん入力ページ用）。既存の記録は消さない
 */
export async function insertPurchases(records) {
  const rows = normalizeRecords(records);
  if (!rows.length) throw new Error('登録できる明細がありません');
  const client = await getPool().connect();
  let inserted = 0;
  let newVersion = 0;
  try {
    await client.query('BEGIN');
    await lockVersion(client);
    for (const r of rows) inserted += await insertRow(client, r);
    const upd = await client.query(
      'UPDATE counters SET value = value + 1 WHERE key = $1 RETURNING value',
      [PURCHASES_VERSION_KEY],
    );
    newVersion = Number(upd.rows[0].value);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, count: inserted, version: newVersion };
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
  /* 見積は丸棒前提なので六角材（*_HEX）は実勢サマリから除外する */
  const res = await query(
    `SELECT to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, supplier, material_key, dia, yen_kg
     FROM material_purchases
     WHERE (split_part(material_key, '_', 1) = $1 OR material_key = $1)
       AND material_key NOT LIKE '%HEX%'
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
