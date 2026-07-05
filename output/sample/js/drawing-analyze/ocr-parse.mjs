/**
 * OCR プレーンテキストから図面フィールドをルール抽出
 */

import { FIELD_KEYS } from './shared.mjs';

export const KNOWN_MATERIALS = [
  'S45C', 'S50C', 'S55C', 'SS400', 'SCM435', 'SCM440', 'SUS303', 'SUS304', 'SUS316',
  'A5052', 'A6061', 'C3604', 'SUM24L', '12L14', 'FC250', 'FCD450', 'SKD11', 'SKH51',
];

const CONF_RANK = { high: 3, medium: 2, low: 1 };

/**
 * @param {string} ocrText
 * @returns {Partial<Record<string, { value: string|number, confidence: 'high'|'medium'|'low' }>>}
 */
export function parseFieldsFromOcrText(ocrText) {
  const text = String(ocrText || '');
  if (!text.trim()) return {};

  /** @type {Partial<Record<string, { value: string|number, confidence: 'high'|'medium'|'low' }>>} */
  const fields = {};

  const drawingPatterns = [
    /(?:図番|図面(?:No\.?|番号)?|Drawing\s*No\.?|Part\s*No\.?|品番|DWG)[\s:：]*([^\n\r\t,、；;]{2,48})/i,
    /\b([A-Z]{1,5}[-_][A-Z0-9][A-Z0-9._/-]{2,})\b/,
    /\b(DWG[-_][A-Z0-9._/-]+)\b/i,
  ];
  for (const re of drawingPatterns) {
    const m = text.match(re);
    if (m && m[1] && !/^(S45C|SUS304|SS400)$/i.test(m[1].trim())) {
      fields.drawing_no = { value: m[1].trim().replace(/\s+/g, ''), confidence: 'medium' };
      break;
    }
  }

  for (const mat of KNOWN_MATERIALS) {
    const re = new RegExp('\\b' + mat.replace(/\+/g, '\\+') + '\\b', 'i');
    if (re.test(text)) {
      fields.material = { value: mat, confidence: 'medium' };
      break;
    }
  }

  const dias = [];
  for (const m of text.matchAll(/(?:φ|Φ|ø|直径|DIA\.?)\s*(\d+(?:\.\d+)?)/gi)) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 2000) dias.push(n);
  }
  if (dias.length) {
    fields.diameter_mm = { value: Math.max(...dias), confidence: 'low' };
  }

  const lenPatterns = [
    /(?:全長|Overall\s*Length|O\.?L\.?)[\s:：]*(\d+(?:\.\d+)?)/i,
    /\bL\s*[=:：]\s*(\d+(?:\.\d+)?)/i,
    /\bL(\d{2,4})\b/,
  ];
  for (const re of lenPatterns) {
    const m = text.match(re);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 10000) {
        fields.length_mm = { value: n, confidence: 'low' };
        break;
      }
    }
  }

  if (/(?:シャフト|shaft)/i.test(text)) {
    fields.product = { value: 'shaft', confidence: 'low' };
  } else if (/(?:スペーサ|spacer)/i.test(text)) {
    fields.product = { value: 'spacer', confidence: 'low' };
  } else if (/(?:カラー|collar)/i.test(text)) {
    fields.product = { value: 'collar', confidence: 'low' };
  }

  return fields;
}

/**
 * @param {Record<string, { value?: unknown, confidence?: string }>|undefined} a
 * @param {Record<string, { value?: unknown, confidence?: string }>|undefined} b
 */
function pickBetterField(a, b) {
  const av = a?.value;
  const bv = b?.value;
  const aEmpty = av === null || av === undefined || av === '';
  const bEmpty = bv === null || bv === undefined || bv === '';
  if (aEmpty && bEmpty) return { value: '', confidence: 'low' };
  if (aEmpty) return { value: bv, confidence: b.confidence || 'low' };
  if (bEmpty) return { value: av, confidence: a.confidence || 'low' };
  const ar = CONF_RANK[/** @type {keyof CONF_RANK} */ (a.confidence)] || 1;
  const br = CONF_RANK[/** @type {keyof CONF_RANK} */ (b.confidence)] || 1;
  if (br > ar) return { value: bv, confidence: b.confidence || 'low' };
  return { value: av, confidence: a.confidence || 'low' };
}

/**
 * 複数ソースの fields をマージ（confidence 優先）
 * @param {Array<Record<string, { value?: unknown, confidence?: string }>|undefined>} maps
 */
export function mergeAnalyzeFieldMaps(...maps) {
  /** @type {Record<string, { value: unknown, confidence: string }>} */
  const out = {};
  FIELD_KEYS.forEach(function (key) {
    let best = { value: '', confidence: 'low' };
    maps.forEach(function (map) {
      if (!map || !map[key]) return;
      best = pickBetterField(best, map[key]);
    });
    out[key] = best;
  });
  return out;
}

/**
 * @param {import('./shared.mjs').DrawingAnalyzeResponse} base
 * @param {...import('./shared.mjs').DrawingAnalyzeResponse} others
 */
export function mergeVisionResponses(base, ...others) {
  const merged = JSON.parse(JSON.stringify(base));
  const fieldMaps = [base.fields, ...others.map(function (o) { return o.fields; })];
  merged.fields = mergeAnalyzeFieldMaps(...fieldMaps);

  let bestProcesses = base.processes;
  others.forEach(function (o) {
    if (!o.processes?.rows?.length) return;
    const curRank = CONF_RANK[/** @type {keyof CONF_RANK} */ (bestProcesses?.confidence)] || 0;
    const newRank = CONF_RANK[/** @type {keyof CONF_RANK} */ (o.processes.confidence)] || 0;
    if (!bestProcesses?.rows?.length || newRank > curRank) {
      bestProcesses = o.processes;
    }
  });
  merged.processes = bestProcesses || merged.processes;

  const noteSet = new Set(merged.notes || []);
  others.forEach(function (o) {
    (o.notes || []).forEach(function (n) { noteSet.add(n); });
  });
  merged.notes = [...noteSet];

  return merged;
}

/**
 * OCR テキストで空欄だけ補完
 * @param {import('./shared.mjs').DrawingAnalyzeResponse} response
 * @param {string} ocrText
 */
export function enrichResponseFromOcrText(response, ocrText) {
  const parsed = parseFieldsFromOcrText(ocrText);
  if (!Object.keys(parsed).length) return response;

  const out = JSON.parse(JSON.stringify(response));
  FIELD_KEYS.forEach(function (key) {
    const cur = out.fields[key];
    const rule = parsed[key];
    if (!rule) return;
    const empty = !cur || cur.value === '' || cur.value == null;
    if (empty) {
      out.fields[key] = { value: rule.value, confidence: rule.confidence };
    }
  });
  if (!out.notes) out.notes = [];
  const tag = 'OCRルール補完';
  if (out.notes.indexOf(tag) < 0) out.notes.push(tag);
  return out;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {string} ocrText
 */
export function ocrTextSupportsField(key, value, ocrText) {
  if (!ocrText || value === '' || value == null) return false;
  const text = String(ocrText);
  const v = String(value);
  if (key === 'material') {
    return new RegExp('\\b' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text);
  }
  if (key === 'drawing_no') {
    const core = v.replace(/\s+/g, '');
    return text.replace(/\s+/g, '').indexOf(core) >= 0;
  }
  if (key === 'diameter_mm' || key === 'length_mm') {
    return text.indexOf(String(value)) >= 0
      || new RegExp('(?:φ|L\\s*[=:]?)\\s*' + String(value).replace('.', '\\.')).test(text);
  }
  return text.indexOf(v) >= 0;
}
