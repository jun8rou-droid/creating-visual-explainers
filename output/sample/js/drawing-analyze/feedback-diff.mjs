/**
 * AI 提案 vs 確定内容の diff 生成（AI-LEARN）
 */

/**
 * @typedef {Object} QuoteFieldSnapshot
 * @property {string|number} drawing_no
 * @property {string} material
 * @property {string|number} diameter_mm
 * @property {string|number} length_mm
 * @property {string} product
 */

/**
 * @typedef {Object} QuoteStateSnapshot
 * @property {QuoteFieldSnapshot} fields
 * @property {Array<{type: string, data: object}>} processes
 * @property {string|number} [setup_minutes]
 * @property {number} [quantity]
 */

const FIELD_KEYS = ['drawing_no', 'material', 'diameter_mm', 'length_mm', 'product'];

/**
 * @param {unknown} field
 * @returns {string|number}
 */
function fieldValue(field) {
  if (field == null) return '';
  if (typeof field === 'object' && field !== null && 'value' in field) {
    return /** @type {{value: string|number}} */ (field).value;
  }
  return /** @type {string|number} */ (field);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return String(a).trim() === String(b).trim();
}

/**
 * @param {Array<{type: string, data?: object}>} rows
 */
export function normalizeProcessRowsForDiff(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(function (row) {
    return {
      type: row.type,
      data: row.data ? JSON.parse(JSON.stringify(row.data)) : {},
    };
  });
}

/**
 * @param {Array<{type: string, data: object}>} proposed
 * @param {Array<{type: string, data: object}>} final
 * @param {'adopt'|'reject'|'edit'} userAction
 */
export function diffProcessRows(proposed, final, userAction) {
  proposed = normalizeProcessRowsForDiff(proposed);
  final = normalizeProcessRowsForDiff(final);

  if (userAction === 'reject') {
    return {
      user_action: 'reject',
      proposed_count: proposed.length,
      final_count: final.length,
      adopted: false,
      edits: proposed.length
        ? [{ op: 'rejected_proposal', proposed: proposed }]
        : [],
    };
  }

  const edits = [];
  const maxLen = Math.max(proposed.length, final.length);

  for (let i = 0; i < maxLen; i++) {
    const p = proposed[i];
    const f = final[i];
    if (!p && f) {
      edits.push({ op: 'added', index: i, final: f });
    } else if (p && !f) {
      edits.push({ op: 'removed', index: i, proposed: p });
    } else if (p && f) {
      const ps = JSON.stringify(p);
      const fs = JSON.stringify(f);
      if (ps !== fs) {
        edits.push({ op: 'edited', index: i, proposed: p, final: f });
      }
    }
  }

  return {
    proposed_count: proposed.length,
    final_count: final.length,
    adopted: userAction === 'adopt' && proposed.length > 0 && edits.length === 0,
    partially_edited: userAction === 'adopt' && edits.length > 0,
    edits: edits,
  };
}

/**
 * @param {import('./shared.mjs').DrawingAnalyzeResponse|{fields?: object}} proposal
 * @param {QuoteStateSnapshot} finalState
 * @param {{ user_action: 'adopt'|'reject'|'edit', processProposal?: {rows?: unknown[], preset_id?: string}, note?: string, final_revision_id?: string }} options
 */
export function buildFeedbackDiff(proposal, finalState, options) {
  options = options || /** @type {typeof options} */ ({ user_action: 'edit' });
  const proposalFields = proposal.fields || {};
  const finalFields = finalState.fields || {};

  /** @type {Record<string, object>} */
  const fieldsDiff = {};

  FIELD_KEYS.forEach(function (key) {
    const proposed = fieldValue(proposalFields[key]);
    const finalVal = fieldValue(finalFields[key]);
    const conf = proposalFields[key] && typeof proposalFields[key] === 'object'
      ? proposalFields[key].confidence
      : null;

    if (!valuesEqual(proposed, finalVal)) {
      fieldsDiff[key] = {
        proposed: proposed,
        final: finalVal,
        confidence: conf,
        changed: true,
      };
    } else if (conf && conf !== 'high') {
      fieldsDiff[key] = {
        proposed: proposed,
        final: finalVal,
        confidence: conf,
        confirmed_unchanged: true,
      };
    }
  });

  const proposedProcessRows = options.processProposal?.rows
    || (proposal.processes && proposal.processes.rows)
    || [];

  const processesDiff = diffProcessRows(
    proposedProcessRows,
    finalState.processes || [],
    options.user_action,
  );

  if (options.processProposal?.preset_id) {
    processesDiff.preset_id = options.processProposal.preset_id;
  }

  const setupProposed = null;
  const setupFinal = finalState.setup_minutes;
  /** @type {Record<string, unknown>} */
  const setupDiff = {};
  if (setupFinal != null && setupFinal !== '') {
    setupDiff.final = setupFinal;
    if (setupProposed != null) setupDiff.proposed = setupProposed;
  }

  return {
    generated_at: new Date().toISOString(),
    user_action: options.user_action,
    note: options.note || null,
    final_revision_id: options.final_revision_id || null,
    fields: fieldsDiff,
    processes: processesDiff,
    setup_minutes: Object.keys(setupDiff).length ? setupDiff : null,
    quantity: finalState.quantity != null ? { final: finalState.quantity } : null,
    summary: summarizeDiff(fieldsDiff, processesDiff),
  };
}

/**
 * @param {Record<string, object>} fieldsDiff
 * @param {object} processesDiff
 */
function summarizeDiff(fieldsDiff, processesDiff) {
  const fieldChanged = Object.values(fieldsDiff).filter(function (f) {
    return f.changed;
  }).length;
  const fieldConfirmed = Object.values(fieldsDiff).filter(function (f) {
    return f.confirmed_unchanged;
  }).length;
  const procEdits = Array.isArray(processesDiff.edits) ? processesDiff.edits.length : 0;
  return {
    fields_changed: fieldChanged,
    fields_confirmed: fieldConfirmed,
    process_edits: procEdits,
  };
}
