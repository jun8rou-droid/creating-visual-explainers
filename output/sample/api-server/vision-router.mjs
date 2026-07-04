/**
 * Vision プロバイダの選択（anthropic | google）
 */

import { analyzeDrawingWithGemini } from './gemini-analyze.mjs';
import { analyzeDrawingWithVision } from './vision-analyze.mjs';

const PROVIDERS = new Set(['anthropic', 'google']);

function hasAnthropicKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function hasGoogleKey() {
  return Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
}

/**
 * @returns {'anthropic'|'google'|null}
 */
export function resolveVisionProvider() {
  const explicit = (process.env.VISION_PROVIDER || '').toLowerCase().trim();
  if (explicit) {
    if (!PROVIDERS.has(explicit)) {
      throw new Error('VISION_PROVIDER は anthropic または google を指定してください');
    }
    if (explicit === 'anthropic' && !hasAnthropicKey()) {
      throw new Error('VISION_PROVIDER=anthropic ですが ANTHROPIC_API_KEY が未設定です');
    }
    if (explicit === 'google' && !hasGoogleKey()) {
      throw new Error('VISION_PROVIDER=google ですが GOOGLE_API_KEY が未設定です');
    }
    return /** @type {'anthropic'|'google'} */ (explicit);
  }
  if (hasAnthropicKey()) return 'anthropic';
  if (hasGoogleKey()) return 'google';
  return null;
}

export function isVisionEnabled() {
  return resolveVisionProvider() !== null;
}

/**
 * @param {'anthropic'|'google'} provider
 */
export function getVisionModelId(provider) {
  if (provider === 'google') {
    return process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  }
  return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
}

/**
 * @param {{ originalname: string, mimetype?: string, buffer: Buffer }} file
 */
export async function analyzeDrawing(file) {
  const provider = resolveVisionProvider();
  if (!provider) {
    throw new Error('Vision API キーが未設定です');
  }

  if (provider === 'google') {
    const response = await analyzeDrawingWithGemini(file);
    return { response, provider, source: 'vision-google', model: getVisionModelId(provider) };
  }

  const response = await analyzeDrawingWithVision(file);
  return { response, provider, source: 'vision-anthropic', model: getVisionModelId(provider) };
}

export function getVisionStatus() {
  let provider = null;
  try {
    provider = resolveVisionProvider();
  } catch (err) {
    return { enabled: false, error: err.message };
  }
  if (!provider) {
    return { enabled: false };
  }
  const key = provider === 'google'
    ? (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '')
    : (process.env.ANTHROPIC_API_KEY || '');
  const keyHint = key
    ? (provider === 'google'
      ? (key.startsWith('AIza') ? 'AIza…' : '形式要確認（AIza で始まる AI Studio キー）')
      : 'sk-…')
    : null;
  return {
    enabled: true,
    provider,
    model: getVisionModelId(provider),
    keyHint,
  };
}
