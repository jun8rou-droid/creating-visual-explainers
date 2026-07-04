/**
 * 案件参照 · 採番（AI 連携の quote_id 解決用）
 */

import { getPool, query } from './db.mjs';

/**
 * @param {string|number|null|undefined} ref draft_no / formal_id / 数値 id
 */
export async function resolveQuoteId(ref) {
  if (ref === null || ref === undefined || ref === '') return null;

  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const byId = await query('SELECT id FROM quotes WHERE id = $1', [Number(s)]);
    if (byId.rows[0]) return byId.rows[0].id;
  }

  const byDraft = await query('SELECT id FROM quotes WHERE draft_no = $1', [s]);
  if (byDraft.rows[0]) return byDraft.rows[0].id;

  const byFormal = await query('SELECT id FROM quotes WHERE formal_id = $1', [s]);
  if (byFormal.rows[0]) return byFormal.rows[0].id;

  return null;
}

/**
 * 参照が無い・不明なときは新規下書き案件を採番して返す
 * @param {string|number|null|undefined} ref
 */
export async function resolveOrCreateQuoteId(ref) {
  const existing = await resolveQuoteId(ref);
  if (existing) return existing;
  return createDraftQuote();
}

export async function createDraftQuote() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const counter = await client.query(
      'SELECT value FROM counters WHERE key = $1 FOR UPDATE',
      ['draft_next'],
    );
    let next = counter.rows[0] ? Number(counter.rows[0].value) : 1;
    const draftNo = 'D-' + String(next).padStart(4, '0');

    await client.query(
      `INSERT INTO counters (key, value) VALUES ('draft_next', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [next + 1],
    );

    const ins = await client.query(
      `INSERT INTO quotes (draft_no) VALUES ($1) RETURNING id`,
      [draftNo],
    );

    await client.query(
      `INSERT INTO quote_revisions (
         quote_id, rev, material_id, dia, len, qty, product_mode, product_id, product_label
       ) VALUES ($1, NULL, 'S45C', 50, 120, 1, 'catalog', 'shaft', 'シャフト')`,
      [ins.rows[0].id],
    );

    await client.query('COMMIT');
    return ins.rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * @param {number} [limit]
 */
const MATERIAL_MODES = new Set(['included', 'supplied']);
const PRODUCT_MODES = new Set(['catalog', 'special', 'other']);
const OP_TYPES = new Set(['od', 'hole', 'groove', 'face', 'other']);

/**
 * マスタに無い材質は S45C をコピーして登録（AI 読み取り用の仮材質対応）
 * @param {import('pg').PoolClient} client
 * @param {string} materialId
 */
async function ensureMaterial(client, materialId) {
  const id = String(materialId || 'S45C').trim().toUpperCase();
  const exists = await client.query('SELECT 1 FROM materials WHERE id = $1', [id]);
  if (exists.rows[0]) return id;

  const base = await client.query('SELECT 1 FROM materials WHERE id = $1', ['S45C']);
  if (!base.rows[0]) {
    throw new Error('材質マスタ S45C がありません。npm run migrate を実行してください');
  }

  await client.query(
    `INSERT INTO materials (id, vc, f, ap, vc_hole, f_hole, density, price_kg)
     SELECT $1, vc, f, ap, vc_hole, f_hole, density, price_kg FROM materials WHERE id = 'S45C'`,
    [id],
  );
  return id;
}

/**
 * @param {unknown} body
 */
function normalizeDraftPayload(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('リクエスト body が不正です');
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  const materialMode = String(b.material_mode || 'included');
  const productMode = String(b.product_mode || 'catalog');
  if (!MATERIAL_MODES.has(materialMode)) {
    throw new Error('material_mode は included または supplied です');
  }
  if (!PRODUCT_MODES.has(productMode)) {
    throw new Error('product_mode は catalog / special / other です');
  }

  const operations = Array.isArray(b.operations) ? b.operations : [];
  const normalizedOps = operations.map(function (op, i) {
    if (!op || typeof op !== 'object') throw new Error('operations[' + i + '] が不正です');
    const o = /** @type {Record<string, unknown>} */ (op);
    const type = String(o.type || '');
    if (!OP_TYPES.has(type)) throw new Error('未対応の工程 type: ' + type);
    const params = o.params ?? o.data ?? {};
    if (params === null || typeof params !== 'object') {
      throw new Error('operations[' + i + '].params が不正です');
    }
    return {
      type,
      sort_order: Number.isFinite(Number(o.sort_order)) ? Number(o.sort_order) : i,
      params,
      minutes: o.minutes == null ? null : Number(o.minutes),
      amount_yen: o.amount_yen == null ? null : Number(o.amount_yen),
    };
  });

  return {
    customer_name: String(b.customer_name || '').trim(),
    drawing_no: String(b.drawing_no || '').trim(),
    material_id: String(b.material_id || 'S45C').trim().toUpperCase(),
    dia: Number(b.dia) || 50,
    len: Number(b.len) || 120,
    qty: Math.max(1, Math.floor(Number(b.qty) || 1)),
    material_mode: materialMode,
    setup_minutes: Math.max(0, Number(b.setup_minutes) || 0),
    product_mode: productMode,
    product_id: productMode === 'catalog' && b.product_id ? String(b.product_id) : null,
    product_label: String(b.product_label || '').trim(),
    case_overrides: b.case_overrides && typeof b.case_overrides === 'object'
      ? b.case_overrides
      : {},
    operations: normalizedOps,
  };
}

/**
 * 下書き保存（rev IS NULL の quote_revisions を UPSERT + 工程を差し替え）
 * @param {string|number} ref draft_no / formal_id / 数値 id
 * @param {unknown} body
 */
export async function saveDraftQuote(ref, body) {
  const quoteId = await resolveQuoteId(ref);
  if (!quoteId) {
    throw new Error('案件が見つかりません: ' + ref);
  }

  const draft = normalizeDraftPayload(body);
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE quotes
       SET customer_name = $1, drawing_no = $2, updated_at = now()
       WHERE id = $3`,
      [draft.customer_name, draft.drawing_no, quoteId],
    );

    const materialId = await ensureMaterial(client, draft.material_id);

    if (draft.product_id) {
      const prod = await client.query('SELECT 1 FROM products WHERE id = $1', [draft.product_id]);
      if (!prod.rows[0]) {
        throw new Error('品名マスタに存在しません: ' + draft.product_id);
      }
    }

    const revRes = await client.query(
      `SELECT id FROM quote_revisions WHERE quote_id = $1 AND rev IS NULL`,
      [quoteId],
    );

    let revisionId;
    if (revRes.rows[0]) {
      revisionId = revRes.rows[0].id;
      await client.query(
        `UPDATE quote_revisions SET
           material_id = $1, dia = $2, len = $3, qty = $4, material_mode = $5,
           setup_minutes = $6, product_mode = $7, product_id = $8, product_label = $9,
           case_overrides = $10, updated_at = now()
         WHERE id = $11`,
        [
          materialId,
          draft.dia,
          draft.len,
          draft.qty,
          draft.material_mode,
          draft.setup_minutes,
          draft.product_mode,
          draft.product_id,
          draft.product_label,
          JSON.stringify(draft.case_overrides),
          revisionId,
        ],
      );
    } else {
      const ins = await client.query(
        `INSERT INTO quote_revisions (
           quote_id, rev, material_id, dia, len, qty, material_mode, setup_minutes,
           product_mode, product_id, product_label, case_overrides
         ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          quoteId,
          materialId,
          draft.dia,
          draft.len,
          draft.qty,
          draft.material_mode,
          draft.setup_minutes,
          draft.product_mode,
          draft.product_id,
          draft.product_label,
          JSON.stringify(draft.case_overrides),
        ],
      );
      revisionId = ins.rows[0].id;
    }

    await client.query('DELETE FROM quote_operations WHERE revision_id = $1', [revisionId]);

    for (const op of draft.operations) {
      await client.query(
        `INSERT INTO quote_operations (revision_id, sort_order, type, params, minutes, amount_yen)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          revisionId,
          op.sort_order,
          op.type,
          JSON.stringify(op.params),
          op.minutes,
          op.amount_yen,
        ],
      );
    }

    await client.query('COMMIT');

    const meta = await query(
      'SELECT draft_no, formal_id FROM quotes WHERE id = $1',
      [quoteId],
    );

    return {
      ok: true,
      quote_id: quoteId,
      draft_no: meta.rows[0].draft_no,
      formal_id: meta.rows[0].formal_id,
      revision_id: revisionId,
      operation_count: draft.operations.length,
      saved_at: new Date().toISOString(),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listQuotes(limit = 50) {
  const res = await query(
    `SELECT
       q.id,
       q.draft_no,
       q.formal_id,
       q.customer_name,
       q.drawing_no,
       q.updated_at,
       (
         SELECT MAX(r.rev) FROM quote_revisions r
         WHERE r.quote_id = q.id AND r.rev IS NOT NULL
       ) AS latest_rev,
       (
         SELECT r.unit_total FROM quote_revisions r
         WHERE r.quote_id = q.id AND r.rev IS NOT NULL
         ORDER BY r.rev DESC LIMIT 1
       ) AS latest_unit_total,
       EXISTS (
         SELECT 1 FROM quote_revisions r WHERE r.quote_id = q.id AND r.rev IS NULL
       ) AS has_draft,
       dr.material_id AS draft_material_id,
       dr.dia AS draft_dia,
       dr.len AS draft_len,
       dr.product_label AS draft_product_label,
       dr.product_id AS draft_product_id
     FROM quotes q
     LEFT JOIN quote_revisions dr ON dr.quote_id = q.id AND dr.rev IS NULL
     ORDER BY q.updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}

/**
 * 下書き（rev IS NULL）を取得
 * @param {string|number} ref draft_no / formal_id / 数値 id
 */
export async function getDraftQuote(ref) {
  const quoteId = await resolveQuoteId(ref);
  if (!quoteId) return null;

  const qRes = await query(
    `SELECT id, draft_no, formal_id, customer_name, drawing_no, updated_at
     FROM quotes WHERE id = $1`,
    [quoteId],
  );
  if (!qRes.rows[0]) return null;

  const rRes = await query(
    `SELECT id, material_id, dia, len, qty, material_mode, setup_minutes,
            product_mode, product_id, product_label, case_overrides, updated_at
     FROM quote_revisions
     WHERE quote_id = $1 AND rev IS NULL`,
    [quoteId],
  );
  if (!rRes.rows[0]) return null;

  const rev = rRes.rows[0];
  const oRes = await query(
    `SELECT type, sort_order, params, minutes, amount_yen
     FROM quote_operations
     WHERE revision_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [rev.id],
  );

  return {
    quote_id: qRes.rows[0].id,
    draft_no: qRes.rows[0].draft_no,
    formal_id: qRes.rows[0].formal_id,
    customer_name: qRes.rows[0].customer_name || '',
    drawing_no: qRes.rows[0].drawing_no || '',
    quote_updated_at: qRes.rows[0].updated_at,
    revision_updated_at: rev.updated_at,
    revision: {
      id: rev.id,
      material_id: rev.material_id,
      dia: rev.dia,
      len: rev.len,
      qty: rev.qty,
      material_mode: rev.material_mode,
      setup_minutes: rev.setup_minutes,
      product_mode: rev.product_mode,
      product_id: rev.product_id,
      product_label: rev.product_label || '',
      case_overrides: rev.case_overrides || {},
    },
    operations: oRes.rows.map(function (o) {
      return {
        type: o.type,
        sort_order: o.sort_order,
        params: o.params || {},
        minutes: o.minutes,
        amount_yen: o.amount_yen,
      };
    }),
  };
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return '' + y + m + d;
}

/**
 * @param {import('pg').PoolClient} client
 */
async function allocateFormalId(client) {
  const ymd = formatYmd(new Date());
  const key = 'quote:' + ymd;
  const counter = await client.query(
    'SELECT value FROM counters WHERE key = $1 FOR UPDATE',
    [key],
  );
  let next = counter.rows[0] ? Number(counter.rows[0].value) : 1;
  if (next > 999) {
    throw new Error('当日の正式ID採番上限（999）に達しました');
  }
  await client.query(
    `INSERT INTO counters (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, next + 1],
  );
  return 'Q-' + ymd + '-' + String(next).padStart(3, '0');
}

/**
 * @param {unknown} snap
 */
function normalizeSnapshot(snap) {
  if (!snap || typeof snap !== 'object') {
    throw new Error('snapshot が不正です');
  }
  const s = /** @type {Record<string, unknown>} */ (snap);
  return {
    unit_machining_before: Math.round(Number(s.unit_machining_before) || 0),
    unit_machining_after: Math.round(Number(s.unit_machining_after) || 0),
    setup_share_per_unit: Math.round(Number(s.setup_share_per_unit) || 0),
    unit_material: Math.round(Number(s.unit_material) || 0),
    unit_total: Math.round(Number(s.unit_total) || 0),
    lot_machining: Math.round(Number(s.lot_machining) || 0),
    lot_material: Math.round(Number(s.lot_material) || 0),
    lot_total: Math.round(Number(s.lot_total) || 0),
    hourly_rate_at_confirm: Math.round(Number(s.hourly_rate_at_confirm) || 4200),
    memo_material: String(s.memo_material || ''),
    memo_time: String(s.memo_time || ''),
    memo_amount: String(s.memo_amount || ''),
  };
}

/**
 * @param {number} quoteId
 * @param {number|null} rev null = 下書き
 */
async function fetchRevisionBundle(quoteId, rev) {
  const qRes = await query(
    `SELECT id, draft_no, formal_id, customer_name, drawing_no, updated_at
     FROM quotes WHERE id = $1`,
    [quoteId],
  );
  if (!qRes.rows[0]) return null;

  const revSql = rev == null
    ? 'SELECT * FROM quote_revisions WHERE quote_id = $1 AND rev IS NULL'
    : 'SELECT * FROM quote_revisions WHERE quote_id = $1 AND rev = $2';
  const revArgs = rev == null ? [quoteId] : [quoteId, rev];
  const rRes = await query(revSql, revArgs);
  if (!rRes.rows[0]) return null;

  const row = rRes.rows[0];
  const oRes = await query(
    `SELECT type, sort_order, params, minutes, amount_yen
     FROM quote_operations
     WHERE revision_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [row.id],
  );

  return {
    quote_id: qRes.rows[0].id,
    draft_no: qRes.rows[0].draft_no,
    formal_id: qRes.rows[0].formal_id,
    customer_name: qRes.rows[0].customer_name || '',
    drawing_no: qRes.rows[0].drawing_no || '',
    quote_updated_at: qRes.rows[0].updated_at,
    revision_updated_at: row.updated_at,
    revision: {
      id: row.id,
      rev: row.rev,
      material_id: row.material_id,
      dia: row.dia,
      len: row.len,
      qty: row.qty,
      material_mode: row.material_mode,
      setup_minutes: row.setup_minutes,
      product_mode: row.product_mode,
      product_id: row.product_id,
      product_label: row.product_label || '',
      case_overrides: row.case_overrides || {},
      unit_machining_before: row.unit_machining_before,
      unit_machining_after: row.unit_machining_after,
      setup_share_per_unit: row.setup_share_per_unit,
      unit_material: row.unit_material,
      unit_total: row.unit_total,
      lot_machining: row.lot_machining,
      lot_material: row.lot_material,
      lot_total: row.lot_total,
      hourly_rate_at_confirm: row.hourly_rate_at_confirm,
      memo_material: row.memo_material,
      memo_time: row.memo_time,
      memo_amount: row.memo_amount,
      confirmed_at: row.confirmed_at,
    },
    operations: oRes.rows.map(function (o) {
      return {
        type: o.type,
        sort_order: o.sort_order,
        params: o.params || {},
        minutes: o.minutes,
        amount_yen: o.amount_yen,
      };
    }),
  };
}

/**
 * @param {string|number} ref
 */
export async function getQuoteRevisionMeta(ref) {
  const quoteId = await resolveQuoteId(ref);
  if (!quoteId) return null;

  const qRes = await query(
    'SELECT id, draft_no, formal_id FROM quotes WHERE id = $1',
    [quoteId],
  );
  if (!qRes.rows[0]) return null;

  const revRes = await query(
    `SELECT rev, unit_total, confirmed_at, id AS revision_id
     FROM quote_revisions
     WHERE quote_id = $1 AND rev IS NOT NULL
     ORDER BY rev ASC`,
    [quoteId],
  );

  const draftRes = await query(
    'SELECT 1 FROM quote_revisions WHERE quote_id = $1 AND rev IS NULL',
    [quoteId],
  );

  return {
    quote_id: qRes.rows[0].id,
    draft_no: qRes.rows[0].draft_no,
    formal_id: qRes.rows[0].formal_id,
    has_draft: !!draftRes.rows[0],
    revisions: revRes.rows.map(function (r) {
      return {
        rev: r.rev,
        unit_total: r.unit_total,
        confirmed_at: r.confirmed_at,
        revision_id: r.revision_id,
      };
    }),
  };
}

/**
 * @param {string|number} ref
 * @param {number} rev
 */
export async function getConfirmedRevision(ref, rev) {
  const quoteId = await resolveQuoteId(ref);
  if (!quoteId) return null;
  const revNum = Number(rev);
  if (!Number.isFinite(revNum) || revNum < 1) return null;
  return fetchRevisionBundle(quoteId, revNum);
}

/**
 * @param {string|number} ref
 */
export async function ensureDraftFromLatestRev(ref) {
  const existing = await getDraftQuote(ref);
  if (existing) return existing;

  const quoteId = await resolveQuoteId(ref);
  if (!quoteId) return null;

  const latest = await query(
    `SELECT * FROM quote_revisions
     WHERE quote_id = $1 AND rev IS NOT NULL
     ORDER BY rev DESC LIMIT 1`,
    [quoteId],
  );
  if (!latest.rows[0]) return null;

  const src = latest.rows[0];
  const ops = await query(
    `SELECT type, sort_order, params FROM quote_operations
     WHERE revision_id = $1 ORDER BY sort_order ASC, id ASC`,
    [src.id],
  );

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO quote_revisions (
         quote_id, rev, material_id, dia, len, qty, material_mode, setup_minutes,
         product_mode, product_id, product_label, case_overrides
       ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        quoteId,
        src.material_id,
        src.dia,
        src.len,
        src.qty,
        src.material_mode,
        src.setup_minutes,
        src.product_mode,
        src.product_id,
        src.product_label,
        JSON.stringify(src.case_overrides || {}),
      ],
    );
    const revisionId = ins.rows[0].id;
    for (const op of ops.rows) {
      await client.query(
        `INSERT INTO quote_operations (revision_id, sort_order, type, params)
         VALUES ($1, $2, $3, $4)`,
        [revisionId, op.sort_order, op.type, JSON.stringify(op.params || {})],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getDraftQuote(ref);
}

/**
 * @param {string|number} ref
 * @param {unknown} body
 */
export async function confirmQuoteRevision(ref, body) {
  const quoteId = await resolveQuoteId(ref);
  if (!quoteId) {
    throw new Error('案件が見つかりません: ' + ref);
  }

  const draft = normalizeDraftPayload(body);
  const snapshot = normalizeSnapshot(body && typeof body === 'object' ? body.snapshot : null);
  if (!draft.operations.length) {
    throw new Error('工程が未入力のため確定できません');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE quotes SET customer_name = $1, drawing_no = $2, updated_at = now()
       WHERE id = $3`,
      [draft.customer_name, draft.drawing_no, quoteId],
    );

    const qMeta = await client.query(
      'SELECT draft_no, formal_id FROM quotes WHERE id = $1 FOR UPDATE',
      [quoteId],
    );
    let formalId = qMeta.rows[0].formal_id;
    if (!formalId) {
      formalId = await allocateFormalId(client);
      await client.query(
        'UPDATE quotes SET formal_id = $1, updated_at = now() WHERE id = $2',
        [formalId, quoteId],
      );
    }

    const maxRev = await client.query(
      `SELECT COALESCE(MAX(rev), 0) AS max_rev FROM quote_revisions
       WHERE quote_id = $1 AND rev IS NOT NULL`,
      [quoteId],
    );
    const nextRev = Number(maxRev.rows[0].max_rev) + 1;

    const materialId = await ensureMaterial(client, draft.material_id);
    if (draft.product_id) {
      const prod = await client.query('SELECT 1 FROM products WHERE id = $1', [draft.product_id]);
      if (!prod.rows[0]) {
        throw new Error('品名マスタに存在しません: ' + draft.product_id);
      }
    }

    const confirmedAt = new Date();
    const ins = await client.query(
      `INSERT INTO quote_revisions (
         quote_id, rev, material_id, dia, len, qty, material_mode, setup_minutes,
         product_mode, product_id, product_label, case_overrides,
         unit_machining_before, unit_machining_after, setup_share_per_unit,
         unit_material, unit_total, lot_machining, lot_material, lot_total,
         hourly_rate_at_confirm, memo_material, memo_time, memo_amount, confirmed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
       ) RETURNING id`,
      [
        quoteId,
        nextRev,
        materialId,
        draft.dia,
        draft.len,
        draft.qty,
        draft.material_mode,
        draft.setup_minutes,
        draft.product_mode,
        draft.product_id,
        draft.product_label,
        JSON.stringify(draft.case_overrides),
        snapshot.unit_machining_before,
        snapshot.unit_machining_after,
        snapshot.setup_share_per_unit,
        snapshot.unit_material,
        snapshot.unit_total,
        snapshot.lot_machining,
        snapshot.lot_material,
        snapshot.lot_total,
        snapshot.hourly_rate_at_confirm,
        snapshot.memo_material,
        snapshot.memo_time,
        snapshot.memo_amount,
        confirmedAt,
      ],
    );
    const revisionId = ins.rows[0].id;

    for (const op of draft.operations) {
      await client.query(
        `INSERT INTO quote_operations (revision_id, sort_order, type, params, minutes, amount_yen)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          revisionId,
          op.sort_order,
          op.type,
          JSON.stringify(op.params),
          op.minutes,
          op.amount_yen,
        ],
      );
    }

    await client.query(
      `DELETE FROM quote_operations
       WHERE revision_id IN (
         SELECT id FROM quote_revisions WHERE quote_id = $1 AND rev IS NULL
       )`,
      [quoteId],
    );
    await client.query(
      'DELETE FROM quote_revisions WHERE quote_id = $1 AND rev IS NULL',
      [quoteId],
    );

    await client.query(
      `INSERT INTO quote_index (
         revision_id, quote_id, formal_id, rev, qty, process_count, material_mode,
         product_mode, product_id, product_label, material_id, dia, len,
         customer_name, drawing_no, unit_machining, unit_total, confirmed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (revision_id) DO UPDATE SET
         unit_machining = EXCLUDED.unit_machining,
         unit_total = EXCLUDED.unit_total,
         confirmed_at = EXCLUDED.confirmed_at`,
      [
        revisionId,
        quoteId,
        formalId,
        nextRev,
        draft.qty,
        draft.operations.length,
        draft.material_mode,
        draft.product_mode,
        draft.product_id,
        draft.product_label,
        materialId,
        draft.dia,
        draft.len,
        draft.customer_name,
        draft.drawing_no,
        snapshot.unit_machining_after,
        snapshot.unit_total,
        confirmedAt,
      ],
    );

    await client.query('COMMIT');

    return {
      ok: true,
      quote_id: quoteId,
      draft_no: qMeta.rows[0].draft_no,
      formal_id: formalId,
      rev: nextRev,
      revision_id: revisionId,
      unit_total: snapshot.unit_total,
      confirmed_at: confirmedAt.toISOString(),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
