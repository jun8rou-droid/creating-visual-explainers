/**
 * 図面読み取りベンチマーク
 *
 * 使い方:
 *   1. benchmark/drawings/ に図面ファイル（png/jpg/pdf）を置く
 *   2. benchmark/expected.json に正解を書く（ファイル名 → 期待値）
 *   3. APIサーバー起動中に: node benchmark/run-benchmark.mjs
 *
 * expected.json の形式:
 *   { "図面1.png": { "drawing_no": "K-1023", "material": "S45C",
 *                    "diameter_mm": 45, "length_mm": 150, "product": "シャフト" } }
 *   読めなくて当然の項目は null にすると採点対象外になる。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAWINGS_DIR = path.join(HERE, 'drawings');
const EXPECTED_PATH = path.join(HERE, 'expected.json');
const API = process.env.QUOTE_API || 'http://localhost:3847';
const FIELD_KEYS = ['drawing_no', 'material', 'diameter_mm', 'length_mm', 'product'];

function normText(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase().replace(/[\s　・･]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** API は品名を品名マスタの ID で返す（machining-quote-4pane-mock.html の productMaster と一致させる） */
const PRODUCT_LABELS = {
  spacer: 'スペーサー', shaft: 'シャフト', collar: 'カラー', bush: 'ブッシュ',
  pin: 'ピン', nozzle: 'ノズル', fitting: '継手',
};

function fieldMatch(key, expected, actual) {
  if (key === 'diameter_mm' || key === 'length_mm') {
    const e = Number(expected);
    const a = Number(actual);
    if (!isFinite(e) || !isFinite(a)) return false;
    return Math.abs(e - a) < 0.01;
  }
  if (key === 'product') {
    // 品名はマスタ ID ↔ 日本語名の両表記を許容
    const e = normText(PRODUCT_LABELS[normText(expected)] || expected);
    const a = normText(PRODUCT_LABELS[normText(actual)] || actual);
    return !!e && !!a && (e.includes(a) || a.includes(e));
  }
  return normText(expected) === normText(actual);
}

async function analyzeOne(filePath) {
  const buf = await readFile(filePath);
  const name = path.basename(filePath);
  const mime = /\.pdf$/i.test(name) ? 'application/pdf'
    : /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
  const form = new FormData();
  form.append('drawing', new Blob([buf], { type: mime }), name);
  form.append('force', '1');
  const t0 = Date.now();
  const res = await fetch(API + '/api/drawings/analyze', { method: 'POST', body: form });
  const ms = Date.now() - t0;
  const body = await res.json();
  if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
  return { response: body.response || body, source: body.source, ms };
}

const expected = JSON.parse(await readFile(EXPECTED_PATH, 'utf8'));
/* 実物図面の正解は expected.local.json（git 管理外）に置ける。同名キーはこちらが勝つ */
try {
  Object.assign(expected, JSON.parse(await readFile(path.join(HERE, 'expected.local.json'), 'utf8')));
} catch { /* 無ければスキップ */ }
/* 引数でファイル名の部分一致フィルタ: node run-benchmark.mjs real */
const filter = process.argv[2] || '';
const files = (await readdir(DRAWINGS_DIR))
  .filter((f) => /\.(png|jpe?g|pdf)$/i.test(f))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.log('benchmark/drawings/ に図面ファイルがありません');
  process.exit(1);
}

const perField = {};
for (const k of FIELD_KEYS) perField[k] = { hit: 0, total: 0 };
let readableTotal = 0;
let readableHit = 0;

console.log('図面読み取りベンチマーク — ' + files.length + ' 枚\n');

for (const file of files) {
  const exp = expected[file];
  let result;
  try {
    result = await analyzeOne(path.join(DRAWINGS_DIR, file));
  } catch (err) {
    console.log('✗ ' + file + ' — 解析エラー: ' + err.message + '\n');
    continue;
  }
  const fields = (result.response && result.response.fields) || {};
  const lines = [];
  let fileHit = 0;
  let fileTotal = 0;
  for (const key of FIELD_KEYS) {
    const e = exp ? exp[key] : undefined;
    const f = fields[key] || {};
    const got = f.value;
    const conf = f.confidence || '-';
    if (e === null || e === undefined) {
      lines.push('    - ' + key.padEnd(12) + ' 読取: ' + JSON.stringify(got) + ' (' + conf + ') — 採点対象外');
      continue;
    }
    fileTotal += 1;
    perField[key].total += 1;
    const ok = fieldMatch(key, e, got);
    if (ok) { fileHit += 1; perField[key].hit += 1; }
    lines.push('    ' + (ok ? '○' : '✗') + ' ' + key.padEnd(12) +
      ' 期待: ' + JSON.stringify(e) + '  読取: ' + JSON.stringify(got ?? null) + ' (' + conf + ')');
  }
  readableTotal += fileTotal;
  readableHit += fileHit;
  console.log((fileHit === fileTotal ? '◎' : fileHit >= fileTotal - 1 ? '○' : '△') + ' ' + file +
    ' — ' + fileHit + '/' + fileTotal + ' 項目一致 · ' + (result.ms / 1000).toFixed(1) + '秒 · source=' + (result.source || '?'));
  for (const l of lines) console.log(l);
  console.log('');
}

console.log('―'.repeat(30));
console.log('項目別の読み取り率:');
for (const key of FIELD_KEYS) {
  const s = perField[key];
  if (!s.total) continue;
  console.log('  ' + key.padEnd(12) + ' ' + s.hit + '/' + s.total +
    '  (' + Math.round((100 * s.hit) / s.total) + '%)');
}
console.log('全体: ' + readableHit + '/' + readableTotal +
  ' (' + (readableTotal ? Math.round((100 * readableHit) / readableTotal) : 0) + '%)');
