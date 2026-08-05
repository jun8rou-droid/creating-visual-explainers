/**
 * 工具費くらべ — AI-OCR（工具ラベル・納品書から工具情報/購入情報を抽出）
 * プロバイダ: ANTHROPIC_API_KEY があれば Claude、なければ Gemini（GOOGLE_API_KEY）
 */

import { GoogleGenAI } from '@google/genai';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function buildPrompt(ocrText, categories, suppliers) {
  const catList = Array.isArray(categories) ? categories.slice(0, 50).map(String) : [];
  const supList = Array.isArray(suppliers) ? suppliers.slice(0, 50).map(String) : [];
  return `あなたは町工場の工具購入情報の抽出係です。画像は工具のラベル・箱・本体・納品書・見積書・請求書のいずれかです。
納品書などに明細行が複数ある場合は、工具の明細を「すべて」items配列に入れてください（工具1点だけの写真ならitemsは1件）。
次のJSON形式「だけ」で出力してください（説明文は不要）。

{"common":{"supplier":"工具屋名","purchaseDate":"YYYY-MM-DD","taxType":"税込か税別か不明","documentNumber":"納品書・見積番号",
  "confidence":{"supplier":"high","purchaseDate":"mid","taxType":"low","documentNumber":"low"}},
"items":[
  {"manufacturer":"メーカー名","name":"工具名","modelNumber":"品番・型番","category":"カテゴリ","notes":"備考",
   "unitPrice":単価数値,"quantity":個数数値,
   "confidence":{"manufacturer":"high","name":"mid","modelNumber":"high","category":"low","notes":"low","unitPrice":"high","quantity":"high"}}
]}

ルール:
- 明細行ごとに items の要素を1つ作る（送料・値引き・小計行は含めない。工具・工具関連消耗品のみ）
- 読み取れない項目は空文字（数値はnull）にして confidence を "low" にする
- confidence は各項目 "high"（確実）/"mid"（たぶん）/"low"（不明・推測）
- カテゴリは次の既存リストに合うものがあればそれを使う: ${JSON.stringify(catList)}
- 工具屋は次の既存リストに合うものがあればそれを使う: ${JSON.stringify(supList)}
- メーカー名は日本語の正式表記に統一（例: KYOCERA→京セラ、MITSUBISHI→三菱マテリアル、SUMITOMO→住友電工）
- 単価は1個あたりの金額（金額欄しか無い場合は 金額÷数量）。カンマなしの数値
- 税込/税別は表記から判断し、判断できなければ"不明"
- 日付は西暦YYYY-MM-DD。和暦や「R6」等は西暦に変換
- 参考: 通常OCRの結果（誤認識を含む）: ${String(ocrText || '').slice(0, 2000)}`;
}

function parseModelJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 20) : [];
    if (!items.length) return null;
    return { common: parsed.common || {}, items };
  } catch {
    return null;
  }
}

async function callClaude(image, mediaType, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
        { type: 'text', text: prompt },
      ] }],
    }),
  });
  if (r.status === 429) { const e = new Error('AIの利用上限に達しました。少し待ってからお試しください'); e.status = 429; throw e; }
  if (!r.ok) { const e = new Error('AIが応答しませんでした。もう一度お試しください'); e.status = 502; throw e; }
  const data = await r.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

async function callGemini(image, mediaType, prompt) {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ apiKey });
  const modelId = process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const result = await ai.models.generateContent({
    model: modelId,
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: mediaType, data: image } },
      { text: prompt },
    ] }],
  });
  return result.text || '';
}

async function callText(prompt) {
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) { const e = new Error('AIが応答しませんでした'); e.status = r.status === 429 ? 429 : 502; throw e; }
    const data = await r.json();
    return (data.content && data.content[0] && data.content[0].text) || '';
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY });
  const result = await ai.models.generateContent({
    model: process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  return result.text || '';
}

/**
 * 工具のカテゴリ自動仕分け（テキストのみ・提案止まり）
 * @param {{ tools: Array<{partNumber:string, maker?:string, name?:string, usage?:string, size?:string}>, categories: string[] }} body
 */
export async function classifyTools(body) {
  const { tools, categories } = body || {};
  if (!Array.isArray(tools) || !tools.length) { const e = new Error('工具リストがありません'); e.status = 400; throw e; }
  if (tools.length > 100) { const e = new Error('一度に仕分けできるのは100件までです'); e.status = 400; throw e; }
  if (!isToolOcrEnabled()) { const e = new Error('AIが未設定です'); e.status = 503; throw e; }
  const catList = (Array.isArray(categories) ? categories : []).slice(0, 50).map(String);
  const list = tools.slice(0, 100).map(t => ({
    partNumber: String(t.partNumber || '').slice(0, 60),
    maker: String(t.maker || '').slice(0, 40),
    name: String(t.name || '').slice(0, 60),
    usage: String(t.usage || '').slice(0, 100),
    size: String(t.size || '').slice(0, 40),
  }));
  const prompt = `あなたは切削工具の分類係です。以下の工具リストを、カテゴリリストのどれかに仕分けしてください。
カテゴリリスト: ${JSON.stringify(catList)}
工具リスト: ${JSON.stringify(list)}

型番の規則も手がかりにしてください（例: CCMT/DCMT/TNMG/VNMG等はチップ、EX-SUS等のタップ表記、VQ/MS2等のエンドミル型番、BT/SK始まりはホルダー、ノギス・マイクロメータは測定具）。
次のJSON配列「だけ」を出力（説明不要）:
[{"partNumber":"...","category":"リスト内のカテゴリ名","confidence":"high|mid|low"}]
自信がなければ confidence を "low" にし、どうしても判断できなければ category は空文字にする。リストにないカテゴリ名は使わない。`;
  const text = await callText(prompt);
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) { const e = new Error('解析結果を読み取れませんでした'); e.status = 502; throw e; }
  let arr;
  try { arr = JSON.parse(m[0]); } catch { const e = new Error('解析結果の形式が不正でした'); e.status = 502; throw e; }
  return { results: arr.filter(x => x && x.partNumber).map(x => ({
    partNumber: String(x.partNumber), category: catList.includes(x.category) ? x.category : '', confidence: ['high','mid','low'].includes(x.confidence) ? x.confidence : 'low',
  })) };
}

export function isToolOcrEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
}

/**
 * @param {{ image: string, mediaType: string, ocrText?: string, categories?: string[], suppliers?: string[] }} body
 */
export async function analyzeToolImage(body) {
  const { image, mediaType, ocrText, categories, suppliers } = body || {};
  if (!image || typeof image !== 'string') { const e = new Error('画像がありません'); e.status = 400; throw e; }
  if (!ALLOWED_TYPES.has(mediaType)) { const e = new Error('対応していない画像形式です（JPEG/PNG/WebP）'); e.status = 400; throw e; }
  if (image.length > 4 * 1024 * 1024) { const e = new Error('画像が大きすぎます'); e.status = 413; throw e; }
  if (!/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 100))) { const e = new Error('画像データが不正です'); e.status = 400; throw e; }
  if (!isToolOcrEnabled()) { const e = new Error('AIが未設定です（管理者がAPIキーを設定してください）'); e.status = 503; throw e; }

  const prompt = buildPrompt(ocrText, categories, suppliers);
  const text = process.env.ANTHROPIC_API_KEY
    ? await callClaude(image, mediaType, prompt)
    : await callGemini(image, mediaType, prompt);

  const parsed = parseModelJson(text);
  if (!parsed) { const e = new Error('解析結果を読み取れませんでした'); e.status = 502; throw e; }
  return parsed;
}
