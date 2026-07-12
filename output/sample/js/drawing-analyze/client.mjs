/**
 * 図面解析 API — ブラウザクライアント
 * 使い方: import { analyzeDrawing, submitFeedback } from './js/drawing-analyze/client.mjs';
 */

import {
  API_PATH_ANALYZE,
  API_PATH_FEEDBACK,
  API_PATH_OCR_CROP,
  buildDemoAnalyzeResponse,
  createSuggestionRecord,
  validateAnalyzeResponse,
} from './shared.mjs';

export { confidenceNeedsReview, mapApiFieldToUiKey, validateAnalyzeResponse } from './shared.mjs';
export { buildFeedbackDiff, diffProcessRows, normalizeProcessRowsForDiff } from './feedback-diff.mjs';

const DEFAULT_REMOTE_BASE = 'http://localhost:3847';

/**
 * @param {{ apiBase?: string }} [options]
 * @returns {string}
 */
export function resolveApiBase(options) {
  options = options || {};
  if (options.apiBase !== undefined && options.apiBase !== null) {
    return String(options.apiBase).replace(/\/$/, '');
  }
  if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="drawing-api-base"]');
    if (meta && meta.content) return meta.content.replace(/\/$/, '');
  }
  if (typeof location !== 'undefined') {
    /* file: 直開きのみ API 無し（null）。'' は同一オリジン相対パスを意味する */
    if (location.protocol === 'file:') return null;
    if (location.port === '3847') return '';
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return DEFAULT_REMOTE_BASE;
    }
    return '';
  }
  return DEFAULT_REMOTE_BASE;
}

/**
 * @param {string} base
 * @param {string} path
 */
function joinUrl(base, path) {
  if (!base) return path;
  return base + path;
}

/**
 * @param {Response} res
 */
async function parseJsonOrThrow(res) {
  const text = await res.text();
  if (res.status === 413) {
    throw new Error(
      'ファイルが大きすぎます（サーバー上限 4.5MB）。図面部分だけ切り出した JPEG/PNG にしてください。',
    );
  }
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_e) {
    const hint = res.status === 502
      ? 'AI 解析がタイムアウトした可能性があります。もう一度試すか、画像を小さくしてください。'
      : '通信エラー (' + res.status + ')';
    throw new Error(hint);
  }
  if (!res.ok) {
    const msg = body && body.error ? body.error : res.statusText || 'API error';
    throw new Error(msg);
  }
  return body;
}

/**
 * @typedef {Object} AnalyzeDrawingOptions
 * @property {string} [apiBase]
 * @property {string} [quoteId]
 * @property {Array<{id: string, rows: unknown[]}>} [presetCatalog]
 * @property {AbortSignal} [signal]
 * @property {boolean} [forceReanalyze] — true なら DB キャッシュを無視して再解析
 * @property {boolean} [forceLocal] — true なら fetch せずローカル demo のみ
 * @property {File|Blob} [titleCrop] — 表題欄切り出し画像（任意）
 */

/**
 * @param {File|Blob|string} fileOrName — File/Blob は multipart、文字列はファイル名のみ（デモ）
 * @param {AnalyzeDrawingOptions} [options]
 * @returns {Promise<{ response: import('./shared.mjs').DrawingAnalyzeResponse, suggestionRecord: object, source: 'api'|'local' }>}
 */
export async function analyzeDrawing(fileOrName, options) {
  options = options || {};
  const apiBase = resolveApiBase(options);

  if (options.forceLocal || apiBase == null) {
    const name = typeof fileOrName === 'string'
      ? fileOrName
      : (fileOrName && fileOrName.name) || 'drawing.pdf';
    const response = buildDemoAnalyzeResponse(name, {
      presetCatalog: options.presetCatalog,
    });
    return {
      response: response,
      suggestionRecord: createSuggestionRecord(response, { quoteId: options.quoteId }),
      source: 'local',
    };
  }

  const form = new FormData();
  if (typeof fileOrName === 'string') {
    form.append('fileName', fileOrName);
  } else if (fileOrName) {
    form.append('drawing', fileOrName, fileOrName.name || 'drawing.pdf');
  }
  if (options.titleCrop) {
    form.append('title_crop', options.titleCrop, options.titleCrop.name || 'title-block.jpg');
  }
  if (options.quoteId) form.append('quote_id', options.quoteId);
  if (options.forceReanalyze) form.append('force', '1');

  const res = await fetch(joinUrl(apiBase, API_PATH_ANALYZE), {
    method: 'POST',
    body: form,
    signal: options.signal,
  });

  const payload = await parseJsonOrThrow(res);
  const response = payload.response || payload;
  if (!validateAnalyzeResponse(response)) {
    throw new Error('API 応答の形式が不正です');
  }

  const suggestionRecord = payload.suggestion || createSuggestionRecord(response, {
    quoteId: options.quoteId,
  });

  return {
    response: response,
    suggestionRecord: suggestionRecord,
    source: 'api',
    analyzeSource: payload.source || 'api',
    demoMode: Boolean(payload.demoMode),
    visionEnabled: payload.visionEnabled,
    visionError: payload.visionError || null,
    cached: Boolean(payload.cached),
    analyzeDebug: payload.analyzeDebug || null,
  };
}

/**
 * 図面上の範囲切り出し画像を OCR（手動ピック用）
 * @param {File|Blob} cropFile
 * @param {{ apiBase?: string, signal?: AbortSignal }} [options]
 */
export async function ocrDrawingCrop(cropFile, options) {
  options = options || {};
  const apiBase = resolveApiBase(options);
  if (apiBase == null) {
    throw new Error('OCR API が利用できません');
  }
  const form = new FormData();
  form.append('crop', cropFile, cropFile.name || 'crop.jpg');
  const res = await fetch(joinUrl(apiBase, API_PATH_OCR_CROP), {
    method: 'POST',
    body: form,
    signal: options.signal,
  });
  return parseJsonOrThrow(res);
}

/**
 * @typedef {Object} FeedbackPayload
 * @property {string} suggestion_id
 * @property {'adopt'|'reject'|'edit'} user_action
 * @property {object} [diff_json]
 * @property {string} [quote_id]
 */

/**
 * @param {FeedbackPayload} payload
 * @param {{ apiBase?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<object>}
 */
export async function submitFeedback(payload, options) {
  options = options || {};
  const apiBase = resolveApiBase(options);
  if (apiBase == null) {
    return { ok: true, local: true, payload: payload };
  }

  const res = await fetch(joinUrl(apiBase, API_PATH_FEEDBACK), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  return parseJsonOrThrow(res);
}
