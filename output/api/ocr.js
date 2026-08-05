// 工具費くらべ AI-OCR プロキシ（Vercel Serverless Function）
// 画像+OCRテキストを受け取り、Claude(Vision)で工具情報・購入情報を項目別信頼度付きJSONで返す。
// APIキーは環境変数 ANTHROPIC_API_KEY で管理（フロントに露出させない）。

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

const ALLOWED_ORIGINS = [
  'https://kouguhi-kurabe.surge.sh',
  'https://koguhi-kurabe.surge.sh',
  'http://localhost:3030',
];
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_B64 = 6 * 1024 * 1024; // base64で約6MB（実画像約4.4MB）

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || /\.vercel\.app$/.test(new URL(origin || 'http://x').hostname)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POSTのみ対応です' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'AIが未設定です（管理者がAPIキーを設定してください）' });

  try {
    const { image, mediaType, ocrText, categories, suppliers } = req.body || {};
    if (!image || typeof image !== 'string') return res.status(400).json({ error: '画像がありません' });
    if (!ALLOWED_TYPES.includes(mediaType)) return res.status(400).json({ error: '対応していない画像形式です（JPEG/PNG/WebP）' });
    if (image.length > MAX_IMAGE_B64) return res.status(413).json({ error: '画像が大きすぎます（4MBまで）' });
    if (!/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 100))) return res.status(400).json({ error: '画像データが不正です' });

    const catList = Array.isArray(categories) ? categories.slice(0, 50).map(String) : [];
    const supList = Array.isArray(suppliers) ? suppliers.slice(0, 50).map(String) : [];

    const prompt = `あなたは町工場の工具購入情報の抽出係です。画像は工具のラベル・箱・本体・納品書・見積書・請求書のいずれかです。
画像から読み取れる情報を、次のJSON形式「だけ」で出力してください（説明文は不要）。

{"tool":{"manufacturer":"メーカー名","name":"工具名","modelNumber":"品番・型番","category":"カテゴリ","material":"材質または被削材","size":"サイズ・寸法","coating":"コーティング","application":"用途","notes":"備考"},
"purchase":{"supplier":"工具屋名","purchaseDate":"YYYY-MM-DD","unitPrice":単価数値,"quantity":個数数値,"taxType":"税込か税別か不明","documentNumber":"納品書・見積番号"},
"confidence":{"manufacturer":"high","name":"mid","modelNumber":"high","category":"low","material":"low","size":"low","coating":"low","application":"low","supplier":"low","purchaseDate":"low","unitPrice":"low","quantity":"low","taxType":"low","documentNumber":"low"}}

ルール:
- 読み取れない・写っていない項目は空文字（数値はnull）にして confidence を "low" にする
- confidence は各項目 "high"（確実）/"mid"（たぶん）/"low"（不明・推測）
- カテゴリは次の既存リストに合うものがあればそれを使う: ${JSON.stringify(catList)}
- 工具屋は次の既存リストに合うものがあればそれを使う: ${JSON.stringify(supList)}
- メーカー名は日本語の正式表記に統一（例: KYOCERA→京セラ、MITSUBISHI→三菱マテリアル、SUMITOMO→住友電工）
- 金額・数量はカンマなしの数値。税込/税別は表記から判断し、判断できなければ"不明"
- 日付は西暦YYYY-MM-DD。和暦や「R6」等は西暦に変換
- 参考: 通常OCRの結果（誤認識を含む）: ${String(ocrText || '').slice(0, 2000)}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: prompt },
        ] }],
      }),
    });

    if (r.status === 429) return res.status(429).json({ error: 'AIの利用上限に達しました。少し待ってからお試しください' });
    if (r.status === 401) return res.status(503).json({ error: 'AIの設定に問題があります（APIキーを確認してください）' });
    if (!r.ok) return res.status(502).json({ error: 'AIが応答しませんでした。もう一度お試しください' });

    const data = await r.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ error: '解析結果を読み取れませんでした' });
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return res.status(502).json({ error: '解析結果の形式が不正でした' }); }
    return res.status(200).json({ tool: parsed.tool || {}, purchase: parsed.purchase || {}, confidence: parsed.confidence || {} });
  } catch (e) {
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
