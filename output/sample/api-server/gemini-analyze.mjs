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

const NEAGE_EXTRACT_PROMPT = `この画像は、金属加工業に届いた注文書・図面・FAXです。
値上げのお願い文書を作るために、以下の項目をJSONで抽出してください。

{
  "customer": "発注元（送り主）の会社名。不明なら null",
  "contact": "発注元の担当者名（様・敬称は付けない）。不明なら null",
  "part_name": "品名・部品名（例: STUD、キャスターボルト）。不明なら null",
  "drawing_no": "図番・図面番号。不明なら null",
  "material": "材質（例: SUS304、S45C）。不明なら null",
  "unit_price": 現行単価の数値のみ（円）。@220 なら 220。不明なら null,
  "quantity": 数量の数値のみ。不明なら null
}

ルール:
- 画像に書かれていない情報は推測せず null にする
- 手書きの赤字などで新単価らしき数字があっても unit_price には入れない（印字された現行単価を優先）
- JSONのみを出力する`;

/**
 * 注文書・図面の写真から値上げ文書用の基本情報を抽出（neage-tool.html 用）
 * @param {{ originalname?: string, mimetype?: string, buffer: Buffer }} file
 * @param {{ apiKey?: string, model?: string }} [options]
 */
export async function extractNeageOrderInfo(file, options) {
  options = options || {};
  const apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY が未設定です');

  const mediaType = detectDrawingMediaType(file);
  if (!mediaType) throw new Error('JPEG/PNG/PDF のみ対応です');

  const modelId = options.model || process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const ai = new GoogleGenAI({ apiKey });
  const data = bufferToBase64(mediaType, file.buffer);
  const part = createPartFromBase64(data, mediaType, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH);
  const text = await generate(ai, modelId, [part, { text: NEAGE_EXTRACT_PROMPT }], {
    json: true,
    system: 'あなたは製造業の注文書・図面を正確に読み取る事務アシスタントです。書かれている情報だけを抽出し、推測で補いません。',
  });
  return parseModelJson(text);
}

/* ================= 値上げツール用 AIサポート ================= */

function neageClient(options) {
  options = options || {};
  const apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY が未設定です');
  const modelId = options.model || process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  return { ai: new GoogleGenAI({ apiKey }), modelId };
}

/** ① 値上げ率の妥当性チェック（交渉視点の講評テキストを返す） */
export async function neageReview(payload, options) {
  const { ai, modelId } = neageClient(options);
  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
  const prompt = `今日は${today}です。
あなたは日本の中小製造業（金属加工業）の価格交渉に詳しいアドバイザーです。
以下の値上げ申請の内容を、受け取る側（客先）の視点で講評してください。

${JSON.stringify(payload, null, 1)}

出力ルール:
- 日本語で400字以内。箇条書き中心
- 必ず含める: (1)率が内訳で説明できているかの判定 (2)一番突っ込まれやすい弱点 (3)交渉になった場合に守るべき下限ラインの目安 (4)ひとこと総評
- 世間相場の参考: 中小企業の価格転嫁率の平均は約5割。コスト積み上げで説明できる範囲が最も通りやすい
- 過度に不安をあおらず、実務的に`;
  const text = await generate(ai, modelId, [{ text: prompt }], {
    json: false,
    system: 'あなたは製造業の価格交渉アドバイザーです。簡潔・実務的に助言します。',
  });
  return text.trim();
}

/** ② 想定問答の生成 */
export async function neageQa(docText, options) {
  const { ai, modelId } = neageClient(options);
  const prompt = `以下は金属加工業が客先へ送る値上げのお願い文書です。
送付後の電話や訪問で、客先から来そうな反論・質問を5つ想定し、それぞれに対する返し方を作ってください。

--- 文書 ---
${String(docText).slice(0, 6000)}
--- ここまで ---

JSONで出力:
{"qa":[{"q":"客先の反論・質問（話し言葉）","a":"返し方（話し言葉で2〜3文。文書内の数字・根拠を使う。誠実で、けんか腰にしない）"}]}`;
  const text = await generate(ai, modelId, [{ text: prompt }], {
    json: true,
    system: 'あなたは製造業の価格交渉アドバイザーです。現場で使える自然な話し言葉で作ります。',
  });
  return parseModelJson(text);
}

/** ③ 仕入伝票（複数枚）から材料単価の上昇率を実測 */
export async function neageCostCompare(files, options) {
  const { ai, modelId } = neageClient(options);
  const parts = [];
  for (const file of files) {
    const mediaType = detectDrawingMediaType(file);
    if (!mediaType) continue;
    parts.push(createPartFromBase64(bufferToBase64(mediaType, file.buffer), mediaType, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH));
  }
  if (!parts.length) throw new Error('JPEG/PNG/PDF のみ対応です');
  const prompt = `これらは同じ会社の仕入伝票・請求書の写真です（古いものと新しいものが混ざっています）。
材質ごとに単価（円/kg または 円/本。単位を揃えて比較）を読み取り、古い伝票→新しい伝票でどれだけ上がったかを計算してください。

JSONで出力:
{"items":[{"material":"材質","old_date":"YYYY-MM","old_unit":"古い単価と単位","new_date":"YYYY-MM","new_unit":"新しい単価と単位","rise_percent":上昇率の数値}],
 "average_rise_percent": 全体の平均上昇率の数値,
 "note":"比較にあたっての注意（同一品での比較か等）を1文"}

ルール: 読み取れない・比較できないものは items に入れない。推測で補わない。`;
  parts.push({ text: prompt });
  const text = await generate(ai, modelId, parts, {
    json: true,
    system: 'あなたは製造業の仕入伝票を正確に読み取る事務アシスタントです。書かれている数字だけで計算します。',
  });
  return parseModelJson(text);
}

/** ④ 根拠文の数字をGoogle検索で最新化 */
export async function neageRefreshEvidence(items, options) {
  const { ai, modelId } = neageClient(options);
  const prompt = `以下は、日本の金属加工業が値上げのお願い文書に使っている「根拠文」の一覧です。
Google検索で最新の公的データ・報道を確認し、数字や時点が古くなっていれば書き直してください。

${JSON.stringify(items, null, 1)}

出力ルール（コードブロックでJSONのみ）:
{"items":[{"id":"元のid","body":"更新後の本文（変更不要ならそのまま）","changed":true/false,"note":"何をどう更新したか1文（changed=falseなら「最新です」）"}]}
- 本文の文体・長さは元に合わせる（です・ます調、2〜3文、出典と時点を括弧書き）
- 確認できなかった数字は変えない
- 大げさな表現にしない`;
  const result = await ai.models.generateContent({
    model: modelId,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0,
      maxOutputTokens: 8192,
      systemInstruction: 'あなたは製造業の値上げ文書を支える調査アシスタントです。検索で確認できた事実だけで更新します。',
    },
  });
  const text = (result.text || '').trim();
  if (!text) throw new Error('モデルからテキスト応答がありません');
  return parseModelJson(text);
}

/** ⑤ 内訳表をGoogle検索の最新データで作り直す */
export async function neageRefreshBreakdown(payload, options) {
  const { ai, modelId } = neageClient(options);
  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
  const prompt = `今日は${today}です。
日本の金属加工業（NC旋盤）が、加工単価の値上げ内訳を作っています。
Google検索で最新の公的データ・業界情報を確認し、以下の費目ごとに
「対象期間中のコスト上昇が、加工単価に与える影響（%）」を見積もってください。

対象期間の起点: ${payload.since || 'ここ数年（約3年前）'}
費目一覧: ${JSON.stringify(payload.items || [], null, 1)}

前提（加工単価に占める一般的な費用構成）:
- 材料費 約${payload.matRatio || 35}% ／ 労務費 約30% ／ 工具費 約6% ／ 油剤費 約4% ／ 電力費 約4%
- 影響% ＝ 費用構成比 × その費目の期間中の上昇率

出力ルール（コードブロックでJSONのみ）:
{"items":[{"item":"費目名（入力と同じ名前）","desc":"根拠の短い説明（数字＋出典＋時点。25字前後）","percent":影響%の数値（小数1桁）}],
 "total": 合計の数値,
 "note":"前提や注意を1文"}
- 検索で確認できた実際の上昇率を使う（最低賃金、企業物価指数、各社値上げ発表など）
- 確認できない費目は控えめな数字にする
- 入力にある費目だけを返す（勝手に費目を増やさない）`;
  const result = await ai.models.generateContent({
    model: modelId,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0,
      maxOutputTokens: 8192,
      systemInstruction: 'あなたは製造業の原価計算に詳しい調査アシスタントです。検索で確認できた事実に基づき、保守的に見積もります。',
    },
  });
  const text = (result.text || '').trim();
  if (!text) throw new Error('モデルからテキスト応答がありません');
  return parseModelJson(text);
}

/** ⑥ 自由指示による本文の書き直し */
export async function neageRewrite(docText, request, options) {
  const { ai, modelId } = neageClient(options);
  const prompt = `以下は金属加工業が客先へFAXで送る「単価改定のお願い」文書です。
ユーザーの指示に沿って本文を書き直してください。

--- ユーザーの指示 ---
${String(request).slice(0, 1000)}

--- 現在の文書 ---
${String(docText).slice(0, 8000)}
--- ここまで ---

ルール:
- 書き直した文書の全文だけを出力する（説明・前置き・コードブロック不要）
- 「=====別紙=====」という区切り行がある場合は、その区切りを必ず残す
- 数字（単価・%・日付・出典）は指示がない限り変えない
- 宛名・差出人・敬具などの体裁は保つ
- A4に収まる分量を保つ（大幅に長くしない）
- ビジネス文書として自然な敬語にする`;
  const text = await generate(ai, modelId, [{ text: prompt }], {
    json: false,
    system: 'あなたは日本のビジネス文書に堪能な編集者です。指示された修正だけを丁寧に反映します。',
  });
  return text.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}
