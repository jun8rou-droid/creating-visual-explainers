/**
 * 対話しながらの継続学習（セッション · ローカル蓄積）
 * - 毎回の feedback diff から補正傾向を記録
 * - 次回の提案に反映（デモ · 本番は夜間バッチ + モデル）
 * - 対話メッセージ履歴
 */

const STORAGE_KEY = 'mq_ai_learn_v1';
const MAX_EVENTS = 200;
const MAX_CHAT = 50;

/**
 * @typedef {Object} LearnEvent
 * @property {string} at
 * @property {'feedback'|'chat'} kind
 * @property {string} [action]
 * @property {Record<string, {from: *, to: *}>} [field_corrections]
 * @property {string} [user_message]
 * @property {string} [assistant_message]
 */

function loadRaw() {
  if (typeof localStorage === 'undefined') {
    return { events: [], chat: [], biases: {} };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { events: [], chat: [], biases: {} };
    return JSON.parse(raw);
  } catch (_e) {
    return { events: [], chat: [], biases: {} };
  }
}

function saveRaw(data) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (_e) {
    /* quota */
  }
}

/**
 * @returns {{ events: LearnEvent[], chat: Array<{role: string, text: string, at: string}>, biases: Record<string, *> }}
 */
export function loadLearningSession() {
  const data = loadRaw();
  data.events = data.events || [];
  data.chat = data.chat || [];
  data.biases = data.biases || {};
  return data;
}

/**
 * @param {object} diff
 * @param {string} action
 */
export function recordFeedbackLearning(diff, action) {
  if (!diff) return;
  const data = loadRaw();
  /** @type {Record<string, {from: *, to: *}>} */
  const corrections = {};

  if (diff.fields) {
    Object.keys(diff.fields).forEach(function (key) {
      const f = diff.fields[key];
      if (f && f.changed && f.final !== undefined) {
        corrections[key] = { from: f.proposed, to: f.final };
        data.biases[key] = f.final;
      }
    });
  }

  data.events.push({
    at: new Date().toISOString(),
    kind: 'feedback',
    action: action,
    field_corrections: corrections,
  });
  if (data.events.length > MAX_EVENTS) {
    data.events = data.events.slice(-MAX_EVENTS);
  }
  saveRaw(data);
}

/**
 * @param {string} userMessage
 * @param {string} assistantMessage
 * @param {Record<string, *>} [applied]
 */
export function recordChatTurn(userMessage, assistantMessage, applied) {
  const data = loadRaw();
  data.chat.push(
    { role: 'user', text: userMessage, at: new Date().toISOString() },
    { role: 'assistant', text: assistantMessage, at: new Date().toISOString() },
  );
  if (data.chat.length > MAX_CHAT) {
    data.chat = data.chat.slice(-MAX_CHAT);
  }
  if (applied) {
    Object.keys(applied).forEach(function (key) {
      data.biases[key] = applied[key];
    });
    data.events.push({
      at: new Date().toISOString(),
      kind: 'chat',
      field_corrections: Object.fromEntries(
        Object.entries(applied).map(function ([k, v]) { return [k, { from: null, to: v }]; }),
      ),
      user_message: userMessage,
      assistant_message: assistantMessage,
    });
  }
  saveRaw(data);
}

/**
 * @returns {Record<string, *>}
 */
export function getLearnedBiases() {
  return loadLearningSession().biases;
}

/**
 * 過去の補正を次の API 応答に反映
 * @param {import('./shared.mjs').DrawingAnalyzeResponse} response
 * @param {Record<string, *>} [biases]
 */
export function applyLearnedBiases(response, biases) {
  biases = biases || getLearnedBiases();
  if (!response || !response.fields || !Object.keys(biases).length) return response;

  const out = JSON.parse(JSON.stringify(response));
  Object.keys(biases).forEach(function (key) {
    if (!out.fields[key]) {
      out.fields[key] = { value: biases[key], confidence: 'medium' };
    } else {
      out.fields[key].value = biases[key];
      out.fields[key].confidence = 'medium';
    }
  });
  if (!out.notes) out.notes = [];
  const hint = '過去の修正傾向を反映しました';
  if (out.notes.indexOf(hint) < 0) out.notes.unshift(hint);
  return out;
}

/**
 * 簡易ルールで対話指示をパース（本番は LLM ツール呼び出しへ）
 * @param {string} text
 * @returns {Array<{field: string, value: string|number, label: string}>}
 */
export function parseChatCorrections(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  /** @type {Array<{field: string, value: string|number, label: string}>} */
  const out = [];

  const dia = t.match(/(?:φ|直径|外径)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
  if (dia) out.push({ field: 'diameter_mm', value: parseFloat(dia[1]), label: 'φ' + dia[1] });

  const len = t.match(/(?:L|長さ|全長)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
  if (len) out.push({ field: 'length_mm', value: parseFloat(len[1]), label: 'L' + len[1] });

  const mat = t.match(/(?:材質|材料)\s*[:：]?\s*([A-Za-z0-9]+)/i)
    || t.match(/\b(S45C|SUS304|SS400|A5052|C3604)\b/i);
  if (mat) out.push({ field: 'material', value: mat[1].toUpperCase(), label: mat[1].toUpperCase() });

  const dwg = t.match(/(?:図番|図面番号)\s*[:：]?\s*([A-Za-z0-9\-_]+)/i);
  if (dwg) out.push({ field: 'drawing_no', value: dwg[1], label: dwg[1] });

  const setup = t.match(/段取り\s*[:：]?\s*(\d+)/);
  if (setup) out.push({ field: 'setup_minutes', value: parseInt(setup[1], 10), label: '段取り' + setup[1] + '分' });

  if (/シャフト/i.test(t)) out.push({ field: 'product', value: 'shaft', label: 'シャフト' });
  if (/スペーサ/i.test(t)) out.push({ field: 'product', value: 'spacer', label: 'スペーサー' });

  return out;
}

/**
 * @param {Record<string, *>} biases
 */
export function formatLearnedSummary(biases) {
  biases = biases || getLearnedBiases();
  const keys = Object.keys(biases);
  if (!keys.length) return 'まだ学習データがありません。修正や対話で蓄積されます。';
  return '学習済みの傾向: ' + keys.map(function (k) {
    return k + '=' + biases[k];
  }).join(' · ');
}

export function clearLearningSession() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
}
