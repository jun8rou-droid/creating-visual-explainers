/**
 * 類似案件 vs 現在案件 — 差分要約（層B · AI v1）
 * 数値は呼び出し元が渡した JSON のみ使用。金額の再計算はしない。
 */

export const API_PATH_SIMILAR_DIFF = '/api/ai/similar-diff-summary';

const PROCESS_LABELS = {
  od: '外径',
  hole: '穴',
  face: '端面',
  groove: '溝',
  other: 'その他',
};

/**
 * @param {Array<{type: string}>} processes
 * @returns {string}
 */
export function summarizeProcessList(processes) {
  if (!processes || !processes.length) return '（工程なし）';
  /** @type {Record<string, number>} */
  const counts = {};
  processes.forEach(function (p) {
    if (!p || !p.type) return;
    counts[p.type] = (counts[p.type] || 0) + 1;
  });
  return Object.keys(counts).map(function (t) {
    return (PROCESS_LABELS[t] || t) + counts[t];
  }).join(' · ');
}

/**
 * @param {object} snap
 * @returns {number}
 */
export function unitTotalForCompare(snap) {
  if (!snap) return 0;
  if (snap.material_mode === 'supplied') return Number(snap.unit_machining) || 0;
  return (Number(snap.unit_machining) || 0) + (Number(snap.unit_material) || 0);
}

/**
 * @param {object} current
 * @param {object} similar
 * @returns {string[]}
 */
export function buildRuleBasedDiffLines(current, similar) {
  /** @type {string[]} */
  const lines = [];

  if (current.process_count !== similar.process_count) {
    lines.push(
      '工程数: 今 ' + current.process_count + ' / 類似 '
      + similar.quote_id + ' は ' + similar.process_count,
    );
  }

  if (current.process_summary !== similar.process_summary) {
    lines.push(
      '工程構成: 今「' + current.process_summary + '」→ 類似「' + similar.process_summary + '」',
    );
  } else if (lines.length === 0) {
    lines.push('工程構成は同型（' + current.process_summary + '）');
  }

  if (Number(current.setup_minutes) !== Number(similar.setup_minutes)) {
    var d = Number(similar.setup_minutes) - Number(current.setup_minutes);
    lines.push(
      '段取り: 今 ' + current.setup_minutes + '分 / 類似 '
      + similar.setup_minutes + '分（差 ' + (d > 0 ? '+' : '') + d + '分）',
    );
  }

  var curPrice = unitTotalForCompare(current);
  var simPrice = unitTotalForCompare(similar);
  var priceDelta = simPrice - curPrice;
  if (priceDelta !== 0 && curPrice > 0) {
    lines.push(
      '単価参考: 類似 ' + similar.quote_id + ' は今より '
      + (priceDelta > 0 ? '+' : '') + '¥' + Math.abs(priceDelta) + '/個',
    );
  }

  if (current.material_mode !== similar.material_mode) {
    lines.push('⚠ 材料込み/支給が異なるため、単価比較は参考程度にしてください');
  }

  if (current.qty !== similar.qty) {
    lines.push('本数: 今 ' + current.qty + ' / 類似 ' + similar.qty + '（段取り按分が変わります）');
  }

  return lines.slice(0, 3);
}

/**
 * @param {object} current
 * @param {object} similar
 * @param {string[]} ruleLines
 */
export function buildSimilarDiffPrompt(current, similar, ruleLines) {
  return [
    '現在の見積（下書き）と、類似の確定案件を比較し、現場が値付け確認しやすいよう3行以内で要約してください。',
    '渡された数値以外は書かない。金額を再計算しない。箇条書き3行以内、説教調禁止。',
    '',
    '【現在案件】',
    JSON.stringify(current, null, 2),
    '',
    '【類似案件】',
    JSON.stringify(similar, null, 2),
    '',
    '【機械的な差分メモ（参考）】',
    ruleLines.join('\n'),
  ].join('\n');
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function parseSummaryLines(text) {
  return String(text || '')
    .split(/\n/)
    .map(function (s) { return s.replace(/^[-・*]\s*/, '').trim(); })
    .filter(Boolean)
    .slice(0, 3);
}
