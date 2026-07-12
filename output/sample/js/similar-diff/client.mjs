/**
 * 類似案件差分要約 — ブラウザクライアント
 */

import { API_PATH_SIMILAR_DIFF } from './shared.mjs';

const DEFAULT_REMOTE_BASE = 'http://localhost:3847';

/**
 * @param {{ apiBase?: string }} [options]
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
 * @param {object} payload
 * @param {{ apiBase?: string, signal?: AbortSignal }} [options]
 */
export async function fetchSimilarDiffSummary(payload, options) {
  options = options || {};
  const apiBase = resolveApiBase(options);
  if (apiBase == null) {
    throw new Error('API が利用できません');
  }

  const res = await fetch(apiBase + API_PATH_SIMILAR_DIFF, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_e) {
    throw new Error('通信エラー (' + res.status + ')');
  }
  if (!res.ok) {
    throw new Error((body && body.error) || res.statusText || 'API error');
  }
  return body;
}
