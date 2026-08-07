/**
 * 材料の請求書・納品書 AI 読み取り（material-pricing.html の写真取り込み用）
 *
 * ANTHROPIC_API_KEY があれば Claude で JSON（行ごと・項目ごとの自信度つき）を返す。
 * 無ければ呼び出し側（app.mjs）が従来の Gemini TSV にフォールバックする。
 */

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/* 概算コスト（USD/100万トークン → 円）。tool-ocr.mjs と同じ目安レート */
const USD_JPY = Number(process.env.USD_JPY || 150);
const PRICE_TABLE = [
  { match: /claude.*haiku/, in: 1.00, out: 5.00 },
  { match: /claude/,        in: 3.00, out: 15.0 },
];
function estimateCostYen(model, inputTokens, outputTokens) {
  const row = PRICE_TABLE.find((r) => r.match.test(String(model || ''))) || PRICE_TABLE[1];
  const usd = (inputTokens / 1e6) * row.in + (outputTokens / 1e6) * row.out;
  return Math.round(usd * USD_JPY * 100) / 100;
}

const MATERIAL_LABELS = [
  'SS400磨', 'SS400黒皮', 'S25C', 'SCM435H', 'SNB7', 'SNB16', 'S45CH', 'S45C磨', 'S45C黒皮',
  'SUS304磨', 'SUS304ピーリング', 'SUS304酸', 'SUS304スキンパス六角', 'SUS304酸洗六角',
  'SUS304磨き六角', 'SUS403', 'SUS316', 'SUS316L', 'SUS321', 'XM-19', 'Alloy718', 'SUS420J2HT',
  'SUS303ピーリング', 'SUS303磨', 'SUS304N2', 'SUS309S', 'SUS310S', 'SUS347', 'SUS630',
];

const PROMPT = `添付は材料（丸棒・六角材）の請求書・納品書・見積書などの写真またはスキャンです。
材料の明細行を読み取り、次のJSON「だけ」を出力してください（説明文・コードブロック記号は不要）。

{"docSupplier":"書類の発行元の会社名","docDate":"YYYY-MM-DD",
"rows":[
  {"date":"YYYY-MM-DD","supplier":"仕入先","material":"材質","d":25,"l":4000,"qty":4,"totalYen":15000,
   "confidence":{"date":"high","supplier":"high","material":"mid","d":"high","l":"high","qty":"high","totalYen":"high"}}
]}

ルール:
- 明細行ごとに rows の要素を1つ作る（送料・消費税・値引き・小計・材料以外の行は含めない）
- 日付は西暦 YYYY-MM-DD（明細ごとの日付が無ければ書類の日付。和暦・R6等は西暦に変換）
- supplier は書類の発行元の会社名（全行同じでよい）
- material は次の表記に寄せる: ${MATERIAL_LABELS.join(' / ')}。どれにも該当しなければ原文のまま（「DT」表記はピーリングとみなす）
- d は径の mm 数値のみ（φ25×4000 のような表記から 25。六角材は対辺寸法）
- l は長さの mm 数値のみ（4m は 4000）
- totalYen はその明細行の合計金額（円・数値のみ・カンマ不可）。単価しか無ければ 単価×本数
- confidence は各項目 "high"（はっきり読めた）/"mid"（たぶん合っている）/"low"（かすれ・推測・計算で補った）
- 読み取れない数値は null にして confidence を "low" にする
- 桁が不自然（例: 合計金額が径×長さから見て極端に高い・安い）と感じた項目は "mid" 以下にする
- 読み取れる明細が無ければ rows は空配列にする`;

export function isClaudeOcrEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function detectMediaType(file) {
  const mime = String(file && file.mimetype || '').toLowerCase();
  const name = String(file && file.originalname || '').toLowerCase();
  if (IMAGE_TYPES.has(mime)) return mime;
  if (mime === 'application/pdf' || /\.pdf$/.test(name)) return 'application/pdf';
  if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
  if (/\.png$/.test(name)) return 'image/png';
  if (/\.webp$/.test(name)) return 'image/webp';
  return null;
}

const CONF = new Set(['high', 'mid', 'low']);
function normConfidence(c) {
  const src = c && typeof c === 'object' ? c : {};
  const out = {};
  ['date', 'supplier', 'material', 'd', 'l', 'qty', 'totalYen'].forEach((k) => {
    out[k] = CONF.has(src[k]) ? src[k] : 'low';
  });
  return out;
}

function normRows(parsed) {
  const docDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.docDate || '')) ? parsed.docDate : '';
  const docSupplier = String(parsed.docSupplier || '').slice(0, 100);
  const rows = (Array.isArray(parsed.rows) ? parsed.rows : []).slice(0, 60).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const dateStr = String(r.date || docDate || '').slice(0, 10);
    const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
    return {
      date: /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : '',
      supplier: String(r.supplier || docSupplier || '').slice(0, 100),
      material: String(r.material || '').slice(0, 60),
      d: numOrNull(r.d),
      l: numOrNull(r.l),
      qty: numOrNull(r.qty),
      totalYen: numOrNull(r.totalYen),
      confidence: normConfidence(r.confidence),
    };
  }).filter(Boolean);
  return { docSupplier, docDate, rows };
}

/**
 * @param {{ originalname?: string, mimetype?: string, buffer: Buffer }} file
 * @returns {Promise<{docSupplier: string, docDate: string, rows: object[], meta: object}>}
 */
export async function extractPurchaseRowsClaude(file) {
  if (!isClaudeOcrEnabled()) {
    const e = new Error('ANTHROPIC_API_KEY が未設定です');
    e.status = 503;
    throw e;
  }
  const mediaType = detectMediaType(file);
  if (!mediaType) {
    const e = new Error('JPEG/PNG/WebP/PDF のみ対応です');
    e.status = 400;
    throw e;
  }
  const data = file.buffer.toString('base64');
  const block = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: 'あなたは製造業の請求書・納品書を正確に読み取る事務アシスタントです。指示された形式だけを出力し、推測で行を補いません。',
      messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
    }),
  });
  if (r.status === 429) {
    const e = new Error('AIの利用上限に達しました。少し待ってからお試しください');
    e.status = 429;
    throw e;
  }
  if (!r.ok) {
    const e = new Error('AIが応答しませんでした。もう一度お試しください');
    e.status = 502;
    throw e;
  }
  const body = await r.json();
  const text = (body.content && body.content[0] && body.content[0].text) || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    const e = new Error('解析結果を読み取れませんでした');
    e.status = 502;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    const e = new Error('解析結果の形式が不正でした');
    e.status = 502;
    throw e;
  }
  const out = normRows(parsed);
  const inputTokens = (body.usage && body.usage.input_tokens) || 0;
  const outputTokens = (body.usage && body.usage.output_tokens) || 0;
  out.meta = {
    provider: 'claude',
    model,
    inputTokens,
    outputTokens,
    costYen: estimateCostYen(model, inputTokens, outputTokens),
  };
  return out;
}
