/**
 * Google Gemini — 図面解析（api-server 専用）
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  normalizeVisionResponse,
  parseJsonFromModelText,
} from '../js/drawing-analyze/shared.mjs';
import { VISION_SYSTEM_PROMPT, VISION_USER_PROMPT } from '../js/drawing-analyze/vision-prompt.mjs';
import { bufferToBase64, detectDrawingMediaType } from './vision-media.mjs';

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

  const modelId = options.model || process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: modelId,
    systemInstruction: VISION_SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  });

  const result = await model.generateContent([
    { inlineData: { mimeType: mediaType, data: data } },
    { text: VISION_USER_PROMPT },
  ]);

  const text = result.response.text();
  if (!text || !text.trim()) {
    throw new Error('モデルからテキスト応答がありません');
  }

  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    parsed = parseJsonFromModelText(text);
  }

  return normalizeVisionResponse(parsed, {
    modelId: 'gemini:' + modelId,
    fileName: file.originalname,
  });
}
