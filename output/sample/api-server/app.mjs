/**
 * Express アプリ本体（ローカル · Vercel 共通）
 */

import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  API_PATH_ANALYZE,
  API_PATH_FEEDBACK,
  API_PATH_OCR_CROP,
  buildDemoAnalyzeResponse,
  createSuggestionRecord,
  validateAnalyzeResponse,
} from '../js/drawing-analyze/shared.mjs';
import { findSuggestionByDrawingHash, insertAiFeedback, insertAiSuggestion, isDemoSuggestionRow } from './ai-db.mjs';
import { isDbEnabled, pingDb } from './db.mjs';
import {
  confirmQuoteRevision,
  createDraftQuote,
  ensureDraftFromLatestRev,
  getConfirmedRevision,
  getDraftQuote,
  getQuoteRevisionMeta,
  listQuotes,
  resolveOrCreateQuoteId,
  saveDraftQuote,
} from './quotes-db.mjs';
import { getMasterBundle, saveMasterBundle } from './masters-db.mjs';
import { listPurchases, purchaseSummaryFor, replacePurchases } from './purchases-db.mjs';
import {
  PORTAL_MATERIALS,
  createSupplier,
  deleteSupplier,
  getSupplierByKey,
  insertDeliveries,
  listRecentBySupplier,
  listSuppliers,
} from './material-suppliers-db.mjs';
import { extractPurchaseRowsClaude, isClaudeOcrEnabled } from './purchase-ocr.mjs';
import { analyzeDrawing, getVisionStatus, isVisionEnabled } from './vision-router.mjs';
import {
  extractNeageOrderInfo,
  extractPurchaseTable,
  neageCompose,
  neageCostCompare,
  neageQa,
  neageRefreshBreakdown,
  neageRefreshEvidence,
  neageReview,
  neageRewrite,
  ocrDrawingRegion,
} from './gemini-analyze.mjs';
import {
  isSimilarDiffAiEnabled,
  summarizeSimilarDiffRuleOnly,
  summarizeSimilarDiffWithGemini,
} from './similar-diff.mjs';
import { API_PATH_SIMILAR_DIFF } from '../js/similar-diff/shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const SAMPLE_ROOT = path.resolve(__dirname, '..');
const FEEDBACK_LOG = process.env.VERCEL
  ? path.join('/tmp', 'machining-quote-feedback.jsonl')
  : path.join(__dirname, 'feedback-log.jsonl');
const PORT = Number(process.env.PORT || 3847);
const visionStatus = getVisionStatus();
const VISION_ENABLED = visionStatus.enabled;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const analyzeUpload = upload.fields([
  { name: 'drawing', maxCount: 1 },
  { name: 'title_crop', maxCount: 1 },
]);

const app = express();
app.use(cors());
/* Vercel のボディ上限（約4.5MB）に合わせる。マスタ・仕入れ記録の全置換 PUT が 1MB を超え得るため */
app.use(express.json({ limit: '4mb' }));

/** メモリキャッシュ（DB 無効時 · API5 デモ） */
const analyzeCache = new Map();

function fileCacheKey(file) {
  if (!file || !file.buffer) return null;
  return file.originalname + ':' + file.size + ':' + file.buffer.length;
}

function drawingFileHash(file) {
  if (!file || !file.buffer?.length) return null;
  return crypto.createHash('sha256').update(file.buffer).digest('hex');
}

function appendFeedbackLog(entry) {
  try {
    fs.appendFileSync(FEEDBACK_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.warn('[feedback] log skip', err.message);
  }
}

/**
 * @param {object} row
 * @param {object} response
 * @param {number} quoteId
 */
function suggestionFromDbRow(row, response, quoteId) {
  return {
    id: String(row.id),
    quote_id: quoteId,
    model_version: response.model,
    response: response,
    feedback: null,
    created_at: row.created_at,
    db: true,
  };
}

// 工具費くらべ（tool-price-app）用 AI-OCR。既存APIとは独立
app.post('/api/tool-ocr', async (req, res) => {
  try {
    const { analyzeToolImage } = await import('./tool-ocr.mjs');
    const result = await analyzeToolImage(req.body);
    res.json(result);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: (err && err.status ? err.message : 'サーバーエラーが発生しました') });
  }
});

// 工具費くらべ: 未分類工具のカテゴリ自動仕分け（提案のみ）
app.post('/api/tool-classify', async (req, res) => {
  try {
    const { classifyTools } = await import('./tool-ocr.mjs');
    const result = await classifyTools(req.body);
    res.json(result);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: (err && err.status ? err.message : 'サーバーエラーが発生しました') });
  }
});

app.get('/api/health', async (_req, res) => {
  const db = await pingDb();
  const vision = getVisionStatus();
  res.json({
    ok: true,
    service: 'machining-quote-api',
    port: PORT,
    deploy: process.env.VERCEL ? 'vercel' : 'local',
    vision: vision.enabled
      ? { enabled: true, provider: vision.provider, model: vision.model }
      : { enabled: false, error: vision.error || null },
    db: isDbEnabled()
      ? { enabled: true, connected: db.ok, reason: db.reason || null }
      : { enabled: false },
  });
});

app.get('/api/masters', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    res.json(await getMasterBundle());
  } catch (err) {
    console.error('[masters get]', err);
    res.status(500).json({ error: 'マスタの取得に失敗しました' });
  }
});

app.put('/api/masters', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    res.json(await saveMasterBundle(req.body));
  } catch (err) {
    console.error('[masters put]', err);
    res.status(500).json({ error: err.message || 'マスタの保存に失敗しました' });
  }
});

app.get('/api/material-purchases', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    res.json(await listPurchases());
  } catch (err) {
    console.error('[purchases get]', err);
    res.status(500).json({ error: '仕入れ記録の取得に失敗しました' });
  }
});

app.put('/api/material-purchases', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    const body = req.body || {};
    const expected = body.version != null && Number.isFinite(Number(body.version))
      ? Number(body.version)
      : null;
    res.json(await replacePurchases(body.records, expected));
  } catch (err) {
    if (err && err.status === 409) {
      /* 材料屋さん入力とぶつかった。最新の記録を返してクライアント側でマージさせる */
      try {
        const latest = await listPurchases();
        return res.status(409).json({ error: err.message, records: latest.records, version: latest.version });
      } catch (err2) {
        console.error('[purchases put conflict reload]', err2);
      }
    }
    console.error('[purchases put]', err);
    res.status(500).json({ error: err.message || '仕入れ記録の保存に失敗しました' });
  }
});

app.post('/api/material-purchases/extract', upload.single('file'), async (req, res) => {
  if (!isClaudeOcrEnabled() && !VISION_ENABLED) {
    return res.status(503).json({ error: 'AI 読み取りが無効です（APIキー未設定）' });
  }
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.status(400).json({ error: 'ファイルが届いていません' });
  }
  /* 高精度版: Claude が使えるときは行＋項目別自信度の JSON を返す */
  if (isClaudeOcrEnabled()) {
    try {
      const out = await extractPurchaseRowsClaude(req.file);
      return res.json(out);
    } catch (err) {
      console.error('[purchases extract claude]', err);
      if (!VISION_ENABLED || (err && (err.status === 400 || err.status === 413 || err.status === 429))) {
        return res.status(err.status || 500).json({ error: err.message || 'AI 読み取りに失敗しました' });
      }
      /* Claude 側の一時障害は Gemini TSV にフォールバック */
    }
  }
  try {
    const table = await extractPurchaseTable(req.file);
    res.json({ table });
  } catch (err) {
    console.error('[purchases extract]', err);
    res.status(500).json({ error: err.message || 'AI 読み取りに失敗しました' });
  }
});

/* ---- 材料屋さん入力ページ（material-nonyu.html）と取引先管理 ---- */

app.get('/api/material-suppliers', async (req, res) => {
  if (!isDbEnabled()) return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  try {
    res.json({ suppliers: await listSuppliers() });
  } catch (err) {
    console.error('[suppliers get]', err);
    res.status(500).json({ error: '取引先の取得に失敗しました' });
  }
});

app.post('/api/material-suppliers', async (req, res) => {
  if (!isDbEnabled()) return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  try {
    res.json(await createSupplier(req.body && req.body.name));
  } catch (err) {
    console.error('[suppliers post]', err);
    res.status(err.status || 500).json({ error: err.message || '取引先の登録に失敗しました' });
  }
});

app.delete('/api/material-suppliers/:id', async (req, res) => {
  if (!isDbEnabled()) return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  try {
    res.json(await deleteSupplier(req.params.id));
  } catch (err) {
    console.error('[suppliers delete]', err);
    res.status(err.status || 500).json({ error: err.message || '取引先の削除に失敗しました' });
  }
});

/** 材料屋さん側: キー確認（会社名と材質リストを返す） */
app.get('/api/nonyu/me', async (req, res) => {
  if (!isDbEnabled()) return res.status(503).json({ error: 'ただいま準備中です。しばらくしてからお試しください' });
  try {
    const sup = await getSupplierByKey(req.query.k);
    if (!sup) return res.status(403).json({ error: 'この URL は無効です。お手数ですが発行元にご確認ください' });
    res.json({
      name: sup.name,
      materials: PORTAL_MATERIALS.map((m) => ({ key: m.key, label: m.label, rho: m.rho })),
    });
  } catch (err) {
    console.error('[nonyu me]', err);
    res.status(500).json({ error: '確認に失敗しました。時間をおいてお試しください' });
  }
});

/** 材料屋さん側: 納入明細の送信（そのまま蓄積に追記） */
app.post('/api/nonyu/deliveries', async (req, res) => {
  if (!isDbEnabled()) return res.status(503).json({ error: 'ただいま準備中です。しばらくしてからお試しください' });
  try {
    const body = req.body || {};
    const sup = await getSupplierByKey(body.k);
    if (!sup) return res.status(403).json({ error: 'この URL は無効です。お手数ですが発行元にご確認ください' });
    res.json(await insertDeliveries(sup, body.date, body.items));
  } catch (err) {
    console.error('[nonyu deliveries]', err);
    res.status(err.status || 500).json({ error: err.message || '送信に失敗しました。時間をおいてお試しください' });
  }
});

/** 材料屋さん側: 自分が送った直近の明細 */
app.get('/api/nonyu/recent', async (req, res) => {
  if (!isDbEnabled()) return res.status(503).json({ error: 'ただいま準備中です' });
  try {
    const sup = await getSupplierByKey(req.query.k);
    if (!sup) return res.status(403).json({ error: 'この URL は無効です' });
    res.json({ records: await listRecentBySupplier(sup.id, req.query.limit) });
  } catch (err) {
    console.error('[nonyu recent]', err);
    res.status(500).json({ error: '履歴の取得に失敗しました' });
  }
});

app.post('/api/neage-extract', upload.single('file'), async (req, res) => {
  if (!VISION_ENABLED) {
    return res.status(503).json({ error: 'AI 読み取りが無効です（GOOGLE_API_KEY 未設定）' });
  }
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.status(400).json({ error: 'ファイルが届いていません' });
  }
  try {
    res.json(await extractNeageOrderInfo(req.file));
  } catch (err) {
    console.error('[neage extract]', err);
    res.status(500).json({ error: err.message || 'AI 読み取りに失敗しました' });
  }
});

app.post('/api/neage-review', async (req, res) => {
  if (!VISION_ENABLED) return res.status(503).json({ error: 'AI が無効です（GOOGLE_API_KEY 未設定）' });
  try {
    res.json({ text: await neageReview(req.body || {}) });
  } catch (err) {
    console.error('[neage review]', err);
    res.status(500).json({ error: err.message || 'AI講評に失敗しました' });
  }
});

app.post('/api/neage-qa', async (req, res) => {
  if (!VISION_ENABLED) return res.status(503).json({ error: 'AI が無効です（GOOGLE_API_KEY 未設定）' });
  try {
    res.json(await neageQa((req.body && req.body.doc) || ''));
  } catch (err) {
    console.error('[neage qa]', err);
    res.status(500).json({ error: err.message || '想定問答の生成に失敗しました' });
  }
});

app.post('/api/neage-cost-compare', upload.array('files', 6), async (req, res) => {
  if (!VISION_ENABLED) return res.status(503).json({ error: 'AI が無効です（GOOGLE_API_KEY 未設定）' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'ファイルが届いていません' });
  try {
    res.json(await neageCostCompare(req.files));
  } catch (err) {
    console.error('[neage cost-compare]', err);
    res.status(500).json({ error: err.message || '伝票の読み取りに失敗しました' });
  }
});

app.post('/api/neage-compose', async (req, res) => {
  if (!VISION_ENABLED) return res.status(503).json({ error: 'AI が無効です（GOOGLE_API_KEY 未設定）' });
  if (!req.body || !req.body.purpose) return res.status(400).json({ error: '文書の内容が必要です' });
  try {
    res.json({ doc: await neageCompose(req.body) });
  } catch (err) {
    console.error('[neage compose]', err);
    res.status(500).json({ error: err.message || '文書の作成に失敗しました' });
  }
});

app.post('/api/neage-rewrite', async (req, res) => {
  if (!VISION_ENABLED) return res.status(503).json({ error: 'AI が無効です（GOOGLE_API_KEY 未設定）' });
  const { doc, request } = req.body || {};
  if (!doc || !request) return res.status(400).json({ error: '文書と指示が必要です' });
  try {
    res.json({ doc: await neageRewrite(doc, request) });
  } catch (err) {
    console.error('[neage rewrite]', err);
    res.status(500).json({ error: err.message || '本文の調整に失敗しました' });
  }
});

app.post('/api/neage-bd-refresh', async (req, res) => {
  if (!VISION_ENABLED) return res.status(503).json({ error: 'AI が無効です（GOOGLE_API_KEY 未設定）' });
  try {
    res.json(await neageRefreshBreakdown(req.body || {}));
  } catch (err) {
    console.error('[neage bd-refresh]', err);
    res.status(500).json({ error: err.message || '内訳の更新に失敗しました' });
  }
});

app.post('/api/neage-refresh', async (req, res) => {
  if (!VISION_ENABLED) return res.status(503).json({ error: 'AI が無効です（GOOGLE_API_KEY 未設定）' });
  try {
    res.json(await neageRefreshEvidence((req.body && req.body.items) || []));
  } catch (err) {
    console.error('[neage refresh]', err);
    res.status(500).json({ error: err.message || '根拠の更新に失敗しました' });
  }
});

app.get('/api/material-purchases/summary', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    const summary = await purchaseSummaryFor(req.query.material);
    res.json({ summary });
  } catch (err) {
    console.error('[purchases summary]', err);
    res.status(500).json({ error: '実勢単価の取得に失敗しました' });
  }
});

app.get('/api/quotes', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await listQuotes(limit);
    res.json({ quotes: rows });
  } catch (err) {
    console.error('[quotes]', err);
    res.status(500).json({ error: err.message || '一覧の取得に失敗しました' });
  }
});

app.post('/api/quotes', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    const quoteId = await createDraftQuote();
    const draft = await getDraftQuote(quoteId);
    res.status(201).json({
      ok: true,
      quote_id: quoteId,
      draft_no: draft ? draft.draft_no : null,
    });
  } catch (err) {
    console.error('[quotes create]', err);
    res.status(500).json({ error: err.message || '案件の作成に失敗しました' });
  }
});

app.get('/api/quotes/:ref/draft', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    let draft = await getDraftQuote(req.params.ref);
    if (!draft && req.query.ensure === '1') {
      draft = await ensureDraftFromLatestRev(req.params.ref);
    }
    if (!draft) {
      return res.status(404).json({ error: '下書きが見つかりません' });
    }
    res.json(draft);
  } catch (err) {
    console.error('[draft get]', err);
    res.status(500).json({ error: err.message || '下書きの取得に失敗しました' });
  }
});

app.get('/api/quotes/:ref/meta', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    const meta = await getQuoteRevisionMeta(req.params.ref);
    if (!meta) {
      return res.status(404).json({ error: '案件が見つかりません' });
    }
    res.json(meta);
  } catch (err) {
    console.error('[quote meta]', err);
    res.status(500).json({ error: err.message || '版情報の取得に失敗しました' });
  }
});

app.get('/api/quotes/:ref/revisions/:rev', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    const rev = await getConfirmedRevision(req.params.ref, req.params.rev);
    if (!rev) {
      return res.status(404).json({ error: '確定版が見つかりません' });
    }
    res.json(rev);
  } catch (err) {
    console.error('[revision get]', err);
    res.status(500).json({ error: err.message || '確定版の取得に失敗しました' });
  }
});

app.post('/api/quotes/:ref/confirm', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    const result = await confirmQuoteRevision(req.params.ref, req.body);
    console.log('[confirm]', result.formal_id, 'rev' + result.rev, '¥' + result.unit_total);
    res.json(result);
  } catch (err) {
    console.error('[confirm]', err);
    const status = /見つかりません|不正|未入力|未対応|存在しません|上限/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message || '版の確定に失敗しました' });
  }
});

app.put('/api/quotes/:ref/draft', async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({ error: 'DATABASE_URL が未設定です' });
  }
  try {
    const result = await saveDraftQuote(req.params.ref, req.body);
    console.log('[draft] saved', result.draft_no, 'ops=' + result.operation_count);
    res.json(result);
  } catch (err) {
    console.error('[draft]', err);
    const status = /見つかりません|不正|未対応|存在しません/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message || '下書きの保存に失敗しました' });
  }
});

app.post(API_PATH_ANALYZE, analyzeUpload, async (req, res) => {
  try {
    const reqFile = req.files?.drawing?.[0] || req.file;
    const titleCropFile = req.files?.title_crop?.[0] || null;
    const fileName = reqFile
      ? reqFile.originalname
      : (req.body && req.body.fileName) || 'drawing.pdf';
    const quoteRef = req.body && req.body.quote_id;
    const forceReanalyze = req.query.force === '1' || req.body?.force === '1';
    const hash = reqFile ? drawingFileHash(reqFile) : null;
    const cacheKey = reqFile ? fileCacheKey(reqFile) : fileName;

    let quoteId = null;
    if (isDbEnabled()) {
      quoteId = await resolveOrCreateQuoteId(quoteRef);

      if (hash && !forceReanalyze) {
        const cachedDb = await findSuggestionByDrawingHash(hash);
        const useCache = cachedDb?.suggestion_json
          && !(VISION_ENABLED && isDemoSuggestionRow(cachedDb));
        if (useCache) {
          const response = cachedDb.suggestion_json;
          return res.json({
            response,
            suggestion: suggestionFromDbRow(
              { id: cachedDb.id, created_at: cachedDb.created_at },
              response,
              cachedDb.quote_id,
            ),
            cached: true,
            source: isDemoSuggestionRow(cachedDb) ? 'db' : 'vision-google',
            visionEnabled: VISION_ENABLED,
            demoMode: isDemoSuggestionRow(cachedDb),
            analyzeDebug: {
              fileName,
              fileBytes: reqFile?.buffer?.length ?? 0,
              cached: true,
              forceReanalyze: false,
              hadFile: Boolean(reqFile?.buffer?.length),
            },
          });
        }
      }
    } else if (cacheKey && analyzeCache.has(cacheKey)) {
      return res.json({ ...analyzeCache.get(cacheKey), cached: true });
    }

    let response;
    let analyzeSource = 'demo';
    let visionModel = null;
    let visionError = null;

    if (VISION_ENABLED && reqFile && reqFile.buffer?.length) {
      try {
        const visionResult = await analyzeDrawing(reqFile, {
          titleCrop: titleCropFile,
        });
        response = visionResult.response;
        analyzeSource = visionResult.source;
        visionModel = visionResult.model;
        console.log('[analyze] vision ok:', fileName, '(' + visionResult.provider + ')');
      } catch (visionErr) {
        visionError = visionErr.message || String(visionErr);
        console.error('[analyze] vision failed:', visionError);
        return res.status(502).json({
          error: '図面の AI 解析に失敗しました: ' + visionError,
          visionEnabled: true,
          visionError,
        });
      }
    } else {
      if (VISION_ENABLED && !reqFile?.buffer?.length) {
        return res.status(400).json({
          error: '図面ファイル本体が必要です。PDF / PNG / JPEG をアップロードしてから解析してください。',
        });
      }
      if (VISION_ENABLED && !reqFile) {
        console.log('[analyze] no file body — demo by fileName only');
      }
      if (VISION_ENABLED && reqFile && !reqFile.buffer?.length) {
        console.warn('[analyze] file present but empty buffer:', fileName);
      }
      response = buildDemoAnalyzeResponse(fileName);
    }

    if (!validateAnalyzeResponse(response)) {
      return res.status(500).json({ error: '応答の生成に失敗しました' });
    }

    let suggestion;
    if (isDbEnabled() && quoteId) {
      const row = await insertAiSuggestion({
        quoteId,
        response,
        apiModel: analyzeSource.startsWith('vision-') ? visionModel : null,
        drawingFileHash: hash,
      });
      suggestion = suggestionFromDbRow(row, response, quoteId);
    } else {
      suggestion = createSuggestionRecord(response, { quoteId: quoteRef });
    }

    const payload = {
      response,
      suggestion,
      cached: false,
      source: analyzeSource,
      visionEnabled: VISION_ENABLED,
      demoMode: !analyzeSource.startsWith('vision-'),
      visionError,
      analyzeDebug: {
        fileName,
        fileBytes: reqFile?.buffer?.length ?? 0,
        titleCropBytes: titleCropFile?.buffer?.length ?? 0,
        forceReanalyze,
        hadFile: Boolean(reqFile?.buffer?.length),
      },
    };

    if (!isDbEnabled() && cacheKey) analyzeCache.set(cacheKey, payload);

    res.json(payload);
  } catch (err) {
    console.error('[analyze]', err);
    res.status(500).json({ error: err.message || '解析に失敗しました' });
  }
});

app.post(API_PATH_SIMILAR_DIFF, async (req, res) => {
  try {
    const body = req.body || {};
    const current = body.current;
    const similar = body.similar;
    if (!current || !similar) {
      return res.status(400).json({ error: 'current と similar が必要です' });
    }
    if (!current.quote_id || !similar.quote_id) {
      return res.status(400).json({ error: 'quote_id が必要です' });
    }

    const ruleOnly = summarizeSimilarDiffRuleOnly(current, similar);

    if (!isSimilarDiffAiEnabled()) {
      return res.json({
        summary: ruleOnly.summary,
        lines: ruleOnly.lines,
        source: 'rule',
        model: ruleOnly.model,
      });
    }

    try {
      const ai = await summarizeSimilarDiffWithGemini(current, similar);
      return res.json({
        summary: ai.summary,
        lines: ai.lines,
        source: 'gemini',
        model: ai.model,
        ruleLines: ai.ruleLines,
      });
    } catch (aiErr) {
      console.warn('[similar-diff] gemini failed:', aiErr.message || aiErr);
      return res.json({
        summary: ruleOnly.summary,
        lines: ruleOnly.lines,
        source: 'rule-fallback',
        model: ruleOnly.model,
        visionError: aiErr.message || String(aiErr),
      });
    }
  } catch (err) {
    console.error('[similar-diff]', err);
    res.status(500).json({ error: err.message || '差分要約に失敗しました' });
  }
});

app.post(API_PATH_OCR_CROP, upload.single('crop'), async (req, res) => {
  try {
    if (!VISION_ENABLED) {
      return res.status(503).json({ error: 'Vision API が無効です' });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'crop 画像が必要です' });
    }
    const text = await ocrDrawingRegion(req.file);
    res.json({ text: String(text || '').trim() });
  } catch (err) {
    console.error('[ocr-crop]', err);
    res.status(502).json({ error: err.message || 'OCR に失敗しました' });
  }
});

app.post(API_PATH_FEEDBACK, async (req, res) => {
  const body = req.body || {};
  if (!body.suggestion_id || !body.user_action) {
    return res.status(400).json({ error: 'suggestion_id と user_action が必要です' });
  }

  const entry = {
    ...body,
    received_at: new Date().toISOString(),
  };

  try {
    if (isDbEnabled() && /^\d+$/.test(String(body.suggestion_id))) {
      const row = await insertAiFeedback(body);
      appendFeedbackLog({ ...entry, db_id: row.id });
      return res.json({ ok: true, id: row.id, db: true });
    }

    appendFeedbackLog(entry);
    res.json({ ok: true, id: body.suggestion_id, db: false });
  } catch (err) {
    console.error('[feedback]', err);
    try {
      appendFeedbackLog({ ...entry, db_error: err.message });
    } catch (logErr) {
      console.error('[feedback] log failed', logErr);
    }
    res.status(500).json({ error: err.message || 'feedback の保存に失敗しました' });
  }
});

/** ローカル開発時のみ静的ファイルを配信（Vercel は CDN が担当） */
if (!process.env.VERCEL) {
  app.use(express.static(SAMPLE_ROOT));
}

/* body-parser / multer のエラーも JSON で返す（既定だと HTML が返りクライアントの res.json() が壊れる） */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message = err.type === 'entity.too.large' || status === 413
    ? 'データが大きすぎます（上限を超えています）'
    : 'サーバーエラーが発生しました';
  console.error('[express]', err.message || err);
  res.status(status).json({ error: message });
});

export default app;
