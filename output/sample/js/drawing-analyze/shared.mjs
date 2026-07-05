/**
 * 図面解析 API — 共有ロジック（ブラウザ client.mjs / Node server.mjs）
 * 設計: machining-quote-design-memo.md · AI-API
 */

export const API_PATH_ANALYZE = '/api/drawings/analyze';
export const API_PATH_FEEDBACK = '/api/ai/feedback';

export const FIELD_KEYS = [
  'drawing_no',
  'material',
  'diameter_mm',
  'length_mm',
  'product',
];

/** @typedef {'high'|'medium'|'low'} Confidence */

/**
 * @typedef {Object} FieldValue
 * @property {string|number} value
 * @property {Confidence} confidence
 */

/**
 * @typedef {Object} DrawingAnalyzeResponse
 * @property {string} model
 * @property {Record<string, FieldValue>} fields
 * @property {{ confidence: Confidence, preset_id?: string, rationale?: string, rows: Array<{type: string, data: object}> }} [processes]
 * @property {string[]} [notes]
 */

export const SHAFT_BASIC_ROWS = [
  { type: 'od', data: { startDia: '', finishDia: '40', cutLen: '40' } },
  { type: 'od', data: { startDia: '50', finishDia: '40', cutLen: '80' } },
  { type: 'hole', data: { holeDia: '10', depth: '25' } },
  { type: 'face', data: { seconds: '90' } },
  { type: 'other', data: { name: '面取り', seconds: '120' } },
];

/**
 * @param {Confidence|string} confidence
 * @returns {boolean}
 */
export function confidenceNeedsReview(confidence) {
  return confidence !== 'high';
}

/**
 * @param {unknown} obj
 * @returns {obj is DrawingAnalyzeResponse}
 */
export function validateAnalyzeResponse(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const o = /** @type {DrawingAnalyzeResponse} */ (obj);
  if (typeof o.model !== 'string' || !o.fields || typeof o.fields !== 'object') return false;
  for (const key of Object.keys(o.fields)) {
    const f = o.fields[key];
    if (!f || f.value === undefined || !f.confidence) return false;
    if (!['high', 'medium', 'low'].includes(f.confidence)) return false;
  }
  if (o.processes) {
    if (!Array.isArray(o.processes.rows)) return false;
  }
  return true;
}

/**
 * @param {string} fileName
 * @param {{ presetCatalog?: Array<{id: string, rows: unknown[]}> }} [options]
 * @returns {DrawingAnalyzeResponse}
 */
export function buildDemoAnalyzeResponse(fileName, options) {
  options = options || {};
  const name = fileName || 'drawing.pdf';
  const base = name.replace(/\.[^.]+$/, '').toUpperCase();
  const isSus = base.indexOf('SUS') >= 0;
  const catalog = options.presetCatalog || [];
  const preset = catalog.find(function (p) { return p.id === 'shaft-basic'; });
  const rows = preset && preset.rows
    ? JSON.parse(JSON.stringify(preset.rows))
    : JSON.parse(JSON.stringify(SHAFT_BASIC_ROWS));

  return {
    model: 'api-demo-v1',
    fields: {
      drawing_no: {
        value: base.indexOf('DWG') >= 0 ? base : 'DWG-S45C-001',
        confidence: 'high',
      },
      material: {
        value: isSus ? 'SUS304' : 'S45C',
        confidence: 'high',
      },
      diameter_mm: { value: 50, confidence: 'medium' },
      length_mm: { value: 120, confidence: 'medium' },
      product: { value: 'shaft', confidence: 'low' },
    },
    processes: {
      confidence: 'medium',
      preset_id: 'shaft-basic',
      rationale: '段付き外径と中心穴。類似案件 Q-2025-118 を参考に提案。',
      rows: rows,
    },
    notes: ['表面 Ra1.6'],
  };
}

/**
 * @param {DrawingAnalyzeResponse} response
 * @param {{ quoteId?: string }} [meta]
 */
export function createSuggestionRecord(response, meta) {
  meta = meta || {};
  return {
    id: 'sugg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    quote_id: meta.quoteId || null,
    model_version: response.model,
    response: response,
    feedback: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * API フィールドキー → 画面の OCR フィールドキー
 * @param {string} apiKey
 * @returns {string}
 */
export function mapApiFieldToUiKey(apiKey) {
  const map = {
    drawing_no: 'drawing',
    diameter_mm: 'dia',
    length_mm: 'length',
  };
  return map[apiKey] || apiKey;
}

const CONFIDENCE_SET = new Set(['high', 'medium', 'low']);
const PRODUCT_VALUES = new Set(['shaft', 'spacer', 'collar', 'other']);

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonFromModelText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('モデル応答が空です');
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('JSON オブジェクトが見つかりません');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * @param {Confidence|string} c
 * @returns {Confidence}
 */
function normConfidence(c) {
  return CONFIDENCE_SET.has(c) ? /** @type {Confidence} */ (c) : 'low';
}

/**
 * @param {unknown} fieldOrValue
 * @returns {{ value: unknown, confidence: Confidence|string|undefined }}
 */
function unwrapFieldInput(fieldOrValue) {
  let v = fieldOrValue;
  let confidence;
  if (v && typeof v === 'object' && v !== null && 'value' in /** @type {object} */ (v)) {
    const box = /** @type {{ value?: unknown, confidence?: Confidence|string }} */ (v);
    confidence = box.confidence;
    v = box.value;
    if (v && typeof v === 'object' && v !== null && 'value' in /** @type {object} */ (v)) {
      const inner = /** @type {{ value?: unknown, confidence?: Confidence|string }} */ (v);
      confidence = inner.confidence || confidence;
      v = inner.value;
    }
  }
  return { value: v, confidence: confidence };
}

/**
 * @param {unknown} value
 * @param {Confidence|string} [confidence]
 * @returns {FieldValue}
 */
function normField(value, confidence) {
  const unwrapped = unwrapFieldInput(value);
  const v = unwrapped.value;
  return {
    value: v === null || v === undefined || v === '' ? '' : v,
    confidence: normConfidence(confidence || unwrapped.confidence || 'low'),
  };
}

/**
 * Vision / Claude の生出力を DrawingAnalyzeResponse に正規化
 * @param {unknown} raw
 * @param {{ modelId?: string, fileName?: string, allowDemoProcessFallback?: boolean }} [options]
 * @returns {DrawingAnalyzeResponse}
 */
export function normalizeVisionResponse(raw, options) {
  options = options || {};
  if (!raw || typeof raw !== 'object') {
    throw new Error('Vision 応答がオブジェクトではありません');
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  const fieldsIn = o.fields && typeof o.fields === 'object'
    ? /** @type {Record<string, FieldValue>} */ (o.fields)
    : {};

  const fields = {
    drawing_no: normField(fieldsIn.drawing_no, fieldsIn.drawing_no?.confidence),
    material: normField(fieldsIn.material, fieldsIn.material?.confidence),
    diameter_mm: normField(fieldsIn.diameter_mm, fieldsIn.diameter_mm?.confidence),
    length_mm: normField(fieldsIn.length_mm, fieldsIn.length_mm?.confidence),
    product: normField(fieldsIn.product, fieldsIn.product?.confidence),
  };
  fields.diameter_mm.value = numOrEmpty(fields.diameter_mm.value);
  fields.length_mm.value = numOrEmpty(fields.length_mm.value);

  let processes = null;
  if (o.processes && typeof o.processes === 'object') {
    const p = /** @type {Record<string, unknown>} */ (o.processes);
    const rows = Array.isArray(p.rows) ? normalizeProcessRows(p.rows) : [];
    processes = {
      confidence: normConfidence(/** @type {string} */ (p.confidence) || 'low'),
      preset_id: typeof p.preset_id === 'string' ? p.preset_id : null,
      rationale: typeof p.rationale === 'string' ? p.rationale : '',
      rows: rows,
    };
    if (!rows.length) {
      processes.preset_id = null;
    }
  }

  if ((!processes || !processes.rows.length) && options.allowDemoProcessFallback !== false) {
    const demo = buildDemoAnalyzeResponse(options.fileName || 'drawing.pdf');
    processes = {
      confidence: 'low',
      preset_id: 'shaft-basic',
      rationale: '図面から工程を確定できなかったため、類似シャフトのたたき台を提示',
      rows: demo.processes.rows,
    };
  } else if (!processes || !processes.rows.length) {
    processes = {
      confidence: 'low',
      preset_id: null,
      rationale: '図面から工程を読み取れませんでした。手入力してください。',
      rows: [],
    };
  }

  const notes = Array.isArray(o.notes)
    ? o.notes.map(String).filter(Boolean)
    : [];

  const response = {
    model: options.modelId || (typeof o.model === 'string' ? o.model : 'claude-vision'),
    fields: fields,
    processes: processes,
    notes: notes,
  };

  if (!validateAnalyzeResponse(response)) {
    throw new Error('正規化後の応答がスキーマに合いません');
  }
  return response;
}

/**
 * @param {unknown} v
 */
function numOrEmpty(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

/**
 * @param {unknown} v
 */
function normProduct(v) {
  const s = String(v || '').toLowerCase().trim();
  if (PRODUCT_VALUES.has(s)) return s;
  if (/シャフト|shaft/i.test(String(v))) return 'shaft';
  if (/スペーサ|spacer/i.test(String(v))) return 'spacer';
  if (/カラー|collar/i.test(String(v))) return 'collar';
  return 'shaft';
}

/**
 * @param {unknown[]} rows
 */
function normalizeProcessRows(rows) {
  const allowed = new Set(['od', 'hole', 'face', 'groove', 'other']);
  return rows
    .filter(function (row) {
      return row && typeof row === 'object' && allowed.has(/** @type {{type:string}} */ (row).type);
    })
    .map(function (row) {
      const r = /** @type {{type: string, data?: object}} */ (row);
      return {
        type: r.type,
        data: r.data && typeof r.data === 'object'
          ? Object.fromEntries(
            Object.entries(r.data).map(function ([k, v]) { return [k, v == null ? '' : String(v)]; }),
          )
          : {},
      };
    });
}
