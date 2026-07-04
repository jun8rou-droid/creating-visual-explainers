/**
 * 図面解析 API — ブラウザクライアント
 * 使い方: import { analyzeDrawing, submitFeedback } from './js/drawing-analyze/client.mjs';
 */

import {
  API_PATH_ANALYZE,
  API_PATH_FEEDBACK,
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
    if (location.protocol === 'file:') return '';
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
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_e) {
    throw new Error('API 応答が JSON ではありません (' + res.status + ')');
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
 * @property {boolean} [forceLocal] — true なら fetch せずローカル demo のみ
 */

/**
 * @param {File|Blob|string} fileOrName — File/Blob は multipart、文字列はファイル名のみ（デモ）
 * @param {AnalyzeDrawingOptions} [options]
 * @returns {Promise<{ response: import('./shared.mjs').DrawingAnalyzeResponse, suggestionRecord: object, source: 'api'|'local' }>}
 */
export async function analyzeDrawing(fileOrName, options) {
  options = options || {};
  const apiBase = resolveApiBase(options);

  if (options.forceLocal || !apiBase) {
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
  if (options.quoteId) form.append('quote_id', options.quoteId);

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
  };
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
  if (!apiBase) {
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
