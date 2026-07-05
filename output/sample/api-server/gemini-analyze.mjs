/**
 * Google Gemini — 図面解析（@google/genai · AQ./AIza 両対応）
 */

import {
  GoogleGenAI,
  PartMediaResolutionLevel,
  createPartFromBase64,
} from '@google/genai';
import {
  countReadableFields,
  normalizeVisionResponse,
  parseJsonFromModelText,
  sanitizeUiHallucination,
  sanitizeSeedHallucination,
} from '../js/drawing-analyze/shared.mjs';
import {
  VISION_SYSTEM_PROMPT,
  VISION_USER_PROMPT,
  VISION_OCR_EXTRACT_PROMPT,
  VISION_OCR_MERGE_PROMPT,
} from '../js/drawing-analyze/vision-prompt.mjs';
import { bufferToBase64, detectDrawingMediaType } from './vision-media.mjs';

const MIN_READABLE_FIELDS = 2;

/**
 * @param {import('@google/genai').GoogleGenAI} ai
 * @param {string} modelId
 * @param {import('@google/genai').Part[]} parts
 * @param {{ json?: boolean, maxTokens?: number }} [opts]
 */
async function generate(ai, modelId, parts, opts) {
  opts = opts || {};
  const result = await ai.models.generateContent({
    model: modelId,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: VISION_SYSTEM_PROMPT,
      responseMimeType: opts.json === false ? undefined : 'application/json',
      temperature: opts.json === false ? 0 : 0.15,
      maxOutputTokens: opts.maxTokens || 8192,
    },
  });
  const text = result.text;
  if (!text || !text.trim()) {
    throw new Error('モデルからテキスト応答がありません');
  }
  return text.trim();
}

/**
 * @param {string} text
 */
function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return parseJsonFromModelText(text);
  }
}

/**
 * @param {import('@google/genai').GoogleGenAI} ai
 * @param {string} modelId
 * @param {import('@google/genai').Part} imagePart
 * @param {string} fileName
 */
async function analyzeWithOcrRetry(ai, modelId, imagePart, fileName) {
  const ocrText = await generate(ai, modelId, [
    imagePart,
    { text: VISION_OCR_EXTRACT_PROMPT },
  ], { json: false, maxTokens: 8192 });

  const mergePrompt = VISION_OCR_MERGE_PROMPT.replace('{{OCR_TEXT}}', ocrText.slice(0, 12000));
  const mergeText = await generate(ai, modelId, [
    imagePart,
    { text: mergePrompt },
  ], { json: true });

  return normalizeVisionResponse(parseModelJson(mergeText), {
    modelId: 'gemini:' + modelId + '+ocr',
    fileName,
    allowDemoProcessFallback: false,
  });
}

/**
 * @param {{ originalname: string, mimetype?: string, buffer: Buffer }} file
 * @param {{ apiKey?: string, model?: string }} [options]
 */
export async function analyzeDrawingWithGemini(file, options) {
  options = options || {};
  const apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY が未設定です');
  }

  const mediaType = detectDrawingMediaType(file);
  if (!mediaType) {
    throw new Error('Vision 未対応のファイル形式、または空ファイルです');
  }
  const data = bufferToBase64(mediaType, file.buffer);

  const modelId = options.model || process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-pro';
  const ai = new GoogleGenAI({ apiKey });

  const resolution = mediaType === 'application/pdf'
    ? PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM
    : PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;

  const imagePart = createPartFromBase64(data, mediaType, resolution);

  const mainText = await generate(ai, modelId, [
    imagePart,
    { text: VISION_USER_PROMPT },
  ], { json: true });

  let response = normalizeVisionResponse(parseModelJson(mainText), {
    modelId: 'gemini:' + modelId,
    fileName: file.originalname,
    allowDemoProcessFallback: false,
  });
  response = sanitizeUiHallucination(response);
  response = sanitizeSeedHallucination(response);

  const readable = countReadableFields(response);
  if (readable < MIN_READABLE_FIELDS && mediaType.startsWith('image/')) {
    console.log('[gemini] sparse read (' + readable + ' fields), OCR retry:', file.originalname);
    try {
      response = await analyzeWithOcrRetry(ai, modelId, imagePart, file.originalname);
      response = sanitizeUiHallucination(response);
      response = sanitizeSeedHallucination(response);
    } catch (ocrErr) {
      console.warn('[gemini] OCR retry failed:', ocrErr.message || ocrErr);
    }
  }

  return response;
}
