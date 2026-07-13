/**
 * マスタ DB アクセス（材質・品名・顧客・共通設定・回答テンプレ）
 *
 * フロントの masterBundle（machining-quote-4pane-mock.html の
 * buildMasterStoragePayload と同じ形）で入出力する。
 * 削除は active=false のソフトデリート（過去の確定 rev が FK 参照するため）。
 */
import { getPool, query } from './db.mjs';

const MASTERS_VERSION_KEY = 'masters_version';

/** @returns {Promise<object>} フロント masterBundle 形式 */
export async function getMasterBundle() {
  const [mats, prods, custs, settings, templates, version] = await Promise.all([
    query('SELECT * FROM materials WHERE active ORDER BY id'),
    query('SELECT * FROM products WHERE active ORDER BY sort_order, id'),
    query('SELECT * FROM customers WHERE active ORDER BY sort_order, id'),
    query('SELECT * FROM settings WHERE id = 1'),
    query('SELECT kind, body FROM response_templates'),
    query('SELECT value FROM counters WHERE key = $1', [MASTERS_VERSION_KEY]),
  ]);

  const materialMaster = {};
  for (const m of mats.rows) {
    materialMaster[m.id] = {
      vc: Number(m.vc), f: Number(m.f), ap: Number(m.ap),
      vcHole: Number(m.vc_hole), fHole: Number(m.f_hole),
      nMaxTurn: m.n_max_turn == null ? 0 : Number(m.n_max_turn),
      nMaxHole: m.n_max_hole == null ? 0 : Number(m.n_max_hole),
      density: Number(m.density), priceKg: Number(m.price_kg),
    };
  }

  const productMaster = {};
  for (const p of prods.rows) {
    productMaster[p.id] = {
      name: p.name,
      sort: Number(p.sort_order),
      processRows: Array.isArray(p.process_rows) ? p.process_rows : [],
    };
  }

  const customerMaster = {};
  for (const c of custs.rows) {
    customerMaster[c.id] = { name: c.name, sort: Number(c.sort_order) };
  }

  const s = settings.rows[0] || {};
  const shopMaster = {
    hourlyRate: Number(s.hourly_rate) || 4200,
    companyName: s.company_name || '',
    companyTel: s.company_tel || '',
    companyFax: s.company_fax || '',
    quoteValidityDays: Number(s.quote_validity_days) || 14,
  };

  const responseTemplates = {};
  for (const t of templates.rows) responseTemplates[t.kind] = t.body;

  return {
    version: version.rows[0] ? Number(version.rows[0].value) : 0,
    shopMaster,
    materialMaster,
    productMaster,
    customerMaster,
    responseTemplates,
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanId(id) {
  return String(id || '').trim().slice(0, 80);
}

function cleanText(v, max) {
  return String(v == null ? '' : v).slice(0, max || 200);
}

/**
 * マスタ束を全体上書き保存（当社専用 · last-write-wins）。
 * 束に無くなった行は active=false（材質は確定 rev から参照されるため物理削除しない）。
 * @param {object} bundle フロント masterBundle 形式
 * @returns {Promise<object>} 保存後の bundle
 */
export async function saveMasterBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('マスタ束が不正です');
  const mats = bundle.materialMaster;
  if (!mats || typeof mats !== 'object' || !Object.keys(mats).length) {
    throw new Error('materialMaster が空です');
  }
  const matIds = Object.keys(mats).map(cleanId).filter(Boolean);
  if (matIds.length > 500) throw new Error('材質マスタが多すぎます');

  const prods = bundle.productMaster || {};
  const custs = bundle.customerMaster || {};
  const shop = bundle.shopMaster || {};
  const templates = bundle.responseTemplates || {};

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    for (const rawId of Object.keys(mats)) {
      const id = cleanId(rawId);
      if (!id) continue;
      const m = mats[rawId] || {};
      const nMaxTurn = num(m.nMaxTurn, 0);
      const nMaxHole = num(m.nMaxHole, 0);
      await client.query(
        `INSERT INTO materials (id, vc, f, ap, vc_hole, f_hole, density, price_kg, n_max_turn, n_max_hole, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
         ON CONFLICT (id) DO UPDATE SET
           vc=$2, f=$3, ap=$4, vc_hole=$5, f_hole=$6, density=$7, price_kg=$8,
           n_max_turn=$9, n_max_hole=$10, active=true, updated_at=now()`,
        [id, num(m.vc, 100), num(m.f, 0.12), num(m.ap, 1),
          num(m.vcHole, 70), num(m.fHole, 0.07),
          num(m.density, 7.85), num(m.priceKg, 200),
          nMaxTurn > 0 ? Math.round(nMaxTurn) : null,
          nMaxHole > 0 ? Math.round(nMaxHole) : null],
      );
    }
    await client.query(
      'UPDATE materials SET active=false, updated_at=now() WHERE active AND NOT (id = ANY($1))',
      [matIds],
    );

    const prodIds = [];
    for (const rawId of Object.keys(prods)) {
      const id = cleanId(rawId);
      if (!id) continue;
      prodIds.push(id);
      const p = prods[rawId] || {};
      const rows = Array.isArray(p.processRows) ? p.processRows.slice(0, 50) : [];
      await client.query(
        `INSERT INTO products (id, name, sort_order, process_rows, active)
         VALUES ($1,$2,$3,$4::jsonb,true)
         ON CONFLICT (id) DO UPDATE SET
           name=$2, sort_order=$3, process_rows=$4::jsonb, active=true, updated_at=now()`,
        [id, cleanText(p.name || id, 100), Math.round(num(p.sort, 0)), JSON.stringify(rows)],
      );
    }
    await client.query(
      'UPDATE products SET active=false, updated_at=now() WHERE active AND NOT (id = ANY($1))',
      [prodIds],
    );

    const custIds = [];
    for (const rawId of Object.keys(custs)) {
      const id = cleanId(rawId);
      if (!id) continue;
      custIds.push(id);
      const c = custs[rawId] || {};
      await client.query(
        `INSERT INTO customers (id, name, sort_order, active)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (id) DO UPDATE SET
           name=$2, sort_order=$3, active=true, updated_at=now()`,
        [id, cleanText(c.name || id, 100), Math.round(num(c.sort, 0))],
      );
    }
    await client.query(
      'UPDATE customers SET active=false, updated_at=now() WHERE active AND NOT (id = ANY($1))',
      [custIds],
    );

    await client.query(
      `INSERT INTO settings (id, hourly_rate, company_name, company_tel, company_fax, quote_validity_days)
       VALUES (1,$1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         hourly_rate=$1, company_name=$2, company_tel=$3, company_fax=$4,
         quote_validity_days=$5, updated_at=now()`,
      [Math.round(num(shop.hourlyRate, 4200)), cleanText(shop.companyName, 100),
        cleanText(shop.companyTel, 40), cleanText(shop.companyFax, 40),
        Math.round(num(shop.quoteValidityDays, 14))],
    );

    for (const kind of ['included', 'supplied']) {
      if (typeof templates[kind] !== 'string' || !templates[kind]) continue;
      await client.query(
        `INSERT INTO response_templates (kind, body) VALUES ($1,$2)
         ON CONFLICT (kind) DO UPDATE SET body=$2, updated_at=now()`,
        [kind, cleanText(templates[kind], 4000)],
      );
    }

    await client.query(
      `INSERT INTO counters (key, value) VALUES ($1, 1)
       ON CONFLICT (key) DO UPDATE SET value = counters.value + 1`,
      [MASTERS_VERSION_KEY],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getMasterBundle();
}
