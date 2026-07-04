/**
 * migrations/*.sql をファイル名順に実行
 * 使い方: cd api-server && npm run migrate
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { closeDb, isDbEnabled, query } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  dotenv.config({ path: path.join(__dirname, '.env') });
  dotenv.config({ path: path.join(__dirname, '../.env') });
  dotenv.config({ path: path.join(__dirname, '../.env.neon.local') });
}
if (!process.env.DATABASE_URL && process.env.POSTGRES_URL) {
  process.env.DATABASE_URL = process.env.POSTGRES_URL;
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedFiles() {
  const res = await query('SELECT filename FROM schema_migrations ORDER BY filename');
  return new Set(res.rows.map((r) => r.filename));
}

async function runFile(filename, sql) {
  console.log('  apply', filename);
  await query(sql);
  await query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
}

async function main() {
  if (!isDbEnabled()) {
    console.error('DATABASE_URL を .env に設定してください');
    process.exit(1);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('マイグレーションファイルがありません');
    process.exit(0);
  }

  await ensureMigrationsTable();
  const done = await appliedFiles();

  let count = 0;
  for (const file of files) {
    if (done.has(file)) {
      console.log('  skip', file);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await runFile(file, sql);
    count += 1;
  }

  console.log('');
  console.log(count ? `完了: ${count} 件を適用しました` : 'すべて適用済みです');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
