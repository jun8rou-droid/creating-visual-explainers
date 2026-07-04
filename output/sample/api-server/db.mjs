/**
 * PostgreSQL 接続（DATABASE_URL 未設定時は無効 · JSONL フォールバック用）
 */

import pg from 'pg';

const { Pool } = pg;

/** @type {import('pg').Pool | null} */
let pool = null;

/** Neon 連携は POSTGRES_URL のみ設定されることがある */
export function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

export function isDbEnabled() {
  return Boolean(getDatabaseUrl());
}

function poolSslOption(connectionString) {
  if (!connectionString) return undefined;
  if (/sslmode=require|neon\.tech|supabase\.co/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

export function getPool() {
  if (!isDbEnabled()) return null;
  if (!pool) {
    const connectionString = getDatabaseUrl();
    pool = new Pool({
      connectionString,
      ssl: poolSslOption(connectionString),
      max: process.env.VERCEL ? 3 : 10,
    });
    pool.on('error', (err) => {
      console.error('[db] pool error', err);
    });
  }
  return pool;
}

/**
 * @param {string} text
 * @param {unknown[]} [params]
 */
export async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL が未設定です');
  return p.query(text, params);
}

export async function pingDb() {
  if (!isDbEnabled()) return { ok: false, reason: 'DATABASE_URL 未設定' };
  try {
    const res = await query('SELECT 1 AS ok');
    return { ok: res.rows[0]?.ok === 1 };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
