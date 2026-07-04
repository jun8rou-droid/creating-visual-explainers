/**
 * Anthropic Vision API — 図面解析（api-server 専用 · SDK はここで解決）
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  normalizeVisionResponse,
  parseJsonFromModelText,
} from '../js/drawing-analyze/shared.mjs';
import { VISION_SYSTEM_PROMPT, VISION_USER_PROMPT } from '../js/drawing-analyze/vision-prompt.mjs';
import { bufferToBase64, detectDrawingMediaType, SUPPORTED_DOC } from './vision-media.mjs';

export { detectDrawingMediaType } from './vision-media.mjs';

/**
 * @param {string} mediaType
 * @param {Buffer} buffer
 */
function buildVisionContentBlock(mediaType, buffer) {
  const data = bufferToBase64(mediaType, buffer);
  if (SUPPORTED_DOC.has(mediaType)) {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: data,
      },
    };
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: data,
    },
  };
}

/**
 * @param {{ originalname: string, mimetype?: string, buffer: Buffer }} file
 * @param {{ apiKey?: string, model?: string }} [options]
 */
export async function analyzeDrawingWithVision(file, options) {
  options = options || {};
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY が未設定です');
  }

  const mediaType = detectDrawingMediaType(file);
  if (!mediaType) {
    throw new Error('Vision 未対応のファイル形式、または空ファイルです');
  }

  const model = options.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey: apiKey });

  const message = await client.messages.create({
    model: model,
    max_tokens: 4096,
    system: VISION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          buildVisionContentBlock(mediaType, file.buffer),
          { type: 'text', text: VISION_USER_PROMPT },
        ],
      },
    ],
  });

  const textBlock = message.content.find(function (b) { return b.type === 'text'; });
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('モデルからテキスト応答がありません');
  }

  const parsed = parseJsonFromModelText(textBlock.text);
  return normalizeVisionResponse(parsed, {
    modelId: 'claude:' + model,
    fileName: file.originalname,
  });
}
