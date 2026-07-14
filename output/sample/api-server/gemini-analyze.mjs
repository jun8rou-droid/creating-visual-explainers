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
  enrichResponseFromOcrText,
  mergeVisionResponses,
} from '../js/drawing-analyze/ocr-parse.mjs';
import {
  VISION_SYSTEM_PROMPT,
  VISION_USER_PROMPT,
  VISION_OCR_EXTRACT_PROMPT,
  VISION_OCR_MERGE_PROMPT,
  VISION_TITLE_BLOCK_PROMPT,
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
      systemInstruction: opts.system || VISION_SYSTEM_PROMPT,
      responseMimeType: opts.json === false ? undefined : 'application/json',
      temperature: 0,
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
 */
async function extractOcrPlainText(ai, modelId, imagePart) {
  return generate(ai, modelId, [
    imagePart,
    { text: VISION_OCR_EXTRACT_PROMPT },
  ], { json: false, maxTokens: 8192 });
}

/**
 * @param {import('@google/genai').GoogleGenAI} ai
 * @param {string} modelId
 * @param {import('@google/genai').Part} imagePart
 * @param {string} fileName
 * @param {string} ocrText
 * @param {string} [modelTag]
 */
async function mergeOcrToJson(ai, modelId, imagePart, fileName, ocrText, modelTag) {
  const mergePrompt = VISION_OCR_MERGE_PROMPT.replace('{{OCR_TEXT}}', ocrText.slice(0, 12000));
  const mergeText = await generate(ai, modelId, [
    imagePart,
    { text: mergePrompt },
  ], { json: true });

  return normalizeVisionResponse(parseModelJson(mergeText), {
    modelId: modelTag || ('gemini:' + modelId + '+ocr'),
    fileName,
    allowDemoProcessFallback: false,
  });
}

/**
 * @param {import('@google/genai').GoogleGenAI} ai
 * @param {string} modelId
 * @param {import('@google/genai').Part} imagePart
 * @param {string} fileName
 */
async function analyzeWithOcrRetry(ai, modelId, imagePart, fileName) {
  const ocrText = await extractOcrPlainText(ai, modelId, imagePart);
  return {
    ocrText,
    response: await mergeOcrToJson(ai, modelId, imagePart, fileName, ocrText, 'gemini:' + modelId + '+ocr'),
  };
}

/**
 * @param {{ originalname: string, mimetype?: string, buffer: Buffer }} file
 * @param {{ apiKey?: string, model?: string }} [options]
 * @returns {Promise<string>}
 */
export async function ocrDrawingRegion(file, options) {
  options = options || {};
  const apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY が未設定です');

  const mediaType = detectDrawingMediaType(file);
  if (!mediaType || !mediaType.startsWith('image/')) {
    throw new Error('OCR 範囲指定は JPEG/PNG 画像のみ対応です');
  }

  const modelId = options.model || process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-pro';
  const ai = new GoogleGenAI({ apiKey });
  const data = bufferToBase64(mediaType, file.buffer);
  const imagePart = createPartFromBase64(data, mediaType, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH);
  return extractOcrPlainText(ai, modelId, imagePart);
}

const PURCHASE_EXTRACT_PROMPT = `添付は材料（丸棒・六角材）の請求書・納品書・見積書などの写真またはスキャンです。
材料の明細行を読み取り、次のヘッダーのタブ区切り（TSV）だけを出力してください。説明文は不要です。

日付	仕入先	材質	径	長さ	本数	合計金額

ルール:
- 日付は YYYY-MM-DD（明細ごとの日付がなければ書類の日付を全行に使う）
- 仕入先は書類の発行元の会社名（全行同じでよい）
- 材質は次の表記に寄せる: SS400磨 / SS400黒皮 / S25C / SCM435H / SNB7 / SNB16 / S45CH / S45C磨 / S45C黒皮 / SUS304磨 / SUS304ピーリング / SUS304酸 / SUS304スキンパス六角 / SUS304酸洗六角 / SUS304磨き六角 / SUS403 / SUS316 / SUS316L / SUS321 / XM-19 / Alloy718 / SUS420J2HT。どれにも該当しなければ原文のまま
- 径は mm 数値のみ（φ25×4000 のような表記から 25）。六角材は対辺寸法
- 長さは mm 数値のみ（4m は 4000）
- 合計金額はその明細行の金額（円・数値のみ・カンマ不可）。単価しか無ければ 単価×本数
- 送料・消費税・値引き・材料以外の行は出力しない
- 読み取れる明細が無ければヘッダー行だけを出力する`;

/**
 * 請求書・納品書の写真から材料明細を TSV で抽出（material-pricing.html の AI 取り込み用）
 * @param {{ originalname?: string, mimetype?: string, buffer: Buffer }} file
 * @param {{ apiKey?: string, model?: string }} [options]
 * @returns {Promise<string>} TSV テキスト
 */
export async function extractPurchaseTable(file, options) {
  options = options || {};
  const apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY が未設定です');

  const mediaType = detectDrawingMediaType(file);
  if (!mediaType) throw new Error('JPEG/PNG/PDF のみ対応です');

  const modelId = options.model || process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const ai = new GoogleGenAI({ apiKey });
  const data = bufferToBase64(mediaType, file.buffer);
  const part = createPartFromBase64(data, mediaType, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH);
  const text = await generate(ai, modelId, [part, { text: PURCHASE_EXTRACT_PROMPT }], {
    json: false,
    system: 'あなたは製造業の請求書・納品書を正確に読み取る事務アシスタントです。指示された形式だけを出力し、推測で行を補いません。',
  });
  return text.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}

/**
 * @param {{ originalname?: string, mimetype?: string, buffer: Buffer }} cropFile
 * @param {import('@google/genai').GoogleGenAI} ai
 * @param {string} modelId
 * @param {string} fileName
 */
async function analyzeTitleCrop(cropFile, ai, modelId, fileName) {
  const mediaType = detectDrawingMediaType(cropFile);
  if (!mediaType?.startsWith('image/')) return { ocrText: '', response: null };

  const data = bufferToBase64(mediaType, cropFile.buffer);
  const cropPart = createPartFromBase64(data, mediaType, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH);
  const ocrText = await extractOcrPlainText(ai, modelId, cropPart);
  const mergeText = await generate(ai, modelId, [
    cropPart,
    { text: VISION_TITLE_BLOCK_PROMPT + '\n\nOCR テキスト:\n' + ocrText.slice(0, 8000) },
  ], { json: true });

  const response = normalizeVisionResponse(parseModelJson(mergeText), {
    modelId: 'gemini:' + modelId + '+title-crop',
    fileName,
    allowDemoProcessFallback: false,
  });
  return { ocrText, response };
}

/**
 * @param {{ originalname: string, mimetype?: string, buffer: Buffer }} file
 * @param {{ apiKey?: string, model?: string, titleCrop?: { originalname?: string, mimetype?: string, buffer: Buffer } }} [options]
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
  const isImage = mediaType.startsWith('image/');
  const ocrChunks = [];

  const mainText = await generate(ai, modelId, [
    imagePart,
    { text: VISION_USER_PROMPT },
  ], { json: true });

  let response = normalizeVisionResponse(parseModelJson(mainText), {
    modelId: 'gemini:' + modelId,
    fileName: file.originalname,
    allowDemoProcessFallback: false,
  });

  if (isImage && options.titleCrop?.buffer?.length) {
    try {
      console.log('[gemini] title crop analyze:', file.originalname);
      const cropResult = await analyzeTitleCrop(options.titleCrop, ai, modelId, file.originalname);
      if (cropResult.ocrText) ocrChunks.push(cropResult.ocrText);
      if (cropResult.response) {
        /* 切り出し位置は右下固定なので、表題欄が別の場所にある図面ではクロップに
           図番・材質が写らない。その場合の寸法値は手描き部の R 表記などの誤読が
           多いため、フィールドのマージをスキップする */
        const cf = cropResult.response.fields || {};
        const cropHasTitleBlock = (cf.drawing_no && cf.drawing_no.value) ||
          (cf.material && cf.material.value);
        if (cropHasTitleBlock) {
          response = mergeVisionResponses(response, cropResult.response);
        } else {
          console.log('[gemini] title crop lacks title block, skip field merge');
        }
      }
    } catch (cropErr) {
      console.warn('[gemini] title crop failed:', cropErr.message || cropErr);
    }
  }

  response = sanitizeUiHallucination(response);
  response = sanitizeSeedHallucination(response, { ocrText: ocrChunks.join('\n') });

  let readable = countReadableFields(response);
  if (isImage && readable < MIN_READABLE_FIELDS) {
    console.log('[gemini] OCR retry (' + readable + ' fields):', file.originalname);
    try {
      const retry = await analyzeWithOcrRetry(ai, modelId, imagePart, file.originalname);
      if (retry.ocrText) ocrChunks.push(retry.ocrText);
      response = mergeVisionResponses(response, retry.response);
      response = sanitizeUiHallucination(response);
      response = sanitizeSeedHallucination(response, { ocrText: ocrChunks.join('\n') });
      readable = countReadableFields(response);
    } catch (ocrErr) {
      console.warn('[gemini] OCR retry failed:', ocrErr.message || ocrErr);
    }
  }

  const combinedOcr = ocrChunks.join('\n\n');
  if (combinedOcr.trim()) {
    response = enrichResponseFromOcrText(response, combinedOcr);
    response = sanitizeSeedHallucination(response, { ocrText: combinedOcr });
  }

  return response;
}
