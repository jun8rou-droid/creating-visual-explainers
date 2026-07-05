/**
 * 類似案件差分要約 — Gemini テキストのみ
 */

import { GoogleGenAI } from '@google/genai';
import {
  buildRuleBasedDiffLines,
  buildSimilarDiffPrompt,
  parseSummaryLines,
} from '../js/similar-diff/shared.mjs';

const SYSTEM_PROMPT = `あなたは旋盤加工の見積現場向けアシスタントです。
ユーザーが渡す JSON の数値だけを使い、現在案件と類似案件の差分を日本語で最大3行要約します。
数値を推測で足さない。工程の自動コピーを勧めない。材料込みと材料支給が違う場合は比較注意を1行に含めてよい。`;

/**
 * @param {object} current
 * @param {object} similar
 * @param {{ apiKey?: string, model?: string }} [options]
 */
export async function summarizeSimilarDiffWithGemini(current, similar, options) {
  options = options || {};
  const apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY が未設定です');
  }

  const ruleLines = buildRuleBasedDiffLines(current, similar);
  const modelId = options.model || process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const ai = new GoogleGenAI({ apiKey });

  const result = await ai.models.generateContent({
    model: modelId,
    contents: [{ role: 'user', parts: [{ text: buildSimilarDiffPrompt(current, similar, ruleLines) }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.2,
      maxOutputTokens: 512,
    },
  });

  const text = result.text;
  if (!text || !text.trim()) {
    throw new Error('要約テキストが空です');
  }

  let lines = parseSummaryLines(text);
  if (lines.length < 2 || (lines[0] && lines[0].length < 12)) {
    lines = ruleLines;
  }

  return {
    summary: lines.join('\n'),
    lines: lines,
    model: 'gemini:' + modelId,
    ruleLines: ruleLines,
  };
}

/**
 * @param {object} current
 * @param {object} similar
 */
export function summarizeSimilarDiffRuleOnly(current, similar) {
  const lines = buildRuleBasedDiffLines(current, similar);
  return {
    summary: lines.join('\n'),
    lines: lines,
    model: 'rule-v1',
    ruleLines: lines,
  };
}

export function isSimilarDiffAiEnabled() {
  return Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
}
