/**
 * AI 提案 · feedback の DB 永続化
 */

import { query } from './db.mjs';

/**
 * @param {object} opts
 * @param {number} opts.quoteId
 * @param {object} opts.response
 * @param {string} [opts.apiModel]
 * @param {string} [opts.drawingFileHash]
 * @param {number|null} [opts.drawingId]
 */
export async function insertAiSuggestion(opts) {
  const response = opts.response;
  const confidence = buildConfidenceJson(response);
  const res = await query(
    `INSERT INTO ai_suggestions (
       quote_id, drawing_id, model_version, api_model,
       suggestion_json, confidence_json, drawing_file_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      opts.quoteId,
      opts.drawingId ?? null,
      response.model || 'api-demo-v1',
      opts.apiModel ?? null,
      JSON.stringify(response),
      confidence ? JSON.stringify(confidence) : null,
      opts.drawingFileHash ?? null,
    ],
  );
  return res.rows[0];
}

/**
 * @param {object} payload
 */
export async function insertAiFeedback(payload) {
  const suggestionId = Number(payload.suggestion_id);
  if (!Number.isFinite(suggestionId)) {
    throw new Error('suggestion_id は DB の数値 ID が必要です');
  }

  const finalRevId = payload.final_revision_id
    ? Number(payload.final_revision_id)
    : null;

  const res = await query(
    `INSERT INTO ai_feedback (
       suggestion_id, user_action, diff_json, final_revision_id, confirmed_at
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [
      suggestionId,
      payload.user_action,
      payload.diff_json ? JSON.stringify(payload.diff_json) : null,
      Number.isFinite(finalRevId) ? finalRevId : null,
      payload.confirmed_at || null,
    ],
  );
  return res.rows[0];
}

/**
 * @param {string} hash
 */
export async function findSuggestionByDrawingHash(hash) {
  if (!hash) return null;
  const res = await query(
    `SELECT id, quote_id, suggestion_json, model_version, created_at
     FROM ai_suggestions
     WHERE drawing_file_hash = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [hash],
  );
  return res.rows[0] || null;
}

/**
 * @param {unknown} response
 */
function buildConfidenceJson(response) {
  if (!response || typeof response !== 'object') return null;
  const fields = /** @type {{fields?: Record<string, {confidence?: string}>}} */ (response).fields;
  if (!fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v && v.confidence) out[k] = v.confidence;
  }
  if (response.processes && response.processes.confidence) {
    out.processes = response.processes.confidence;
  }
  return out;
}
