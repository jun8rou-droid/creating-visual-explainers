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
import { analyzeDrawing, getVisionStatus, isVisionEnabled } from './vision-router.mjs';

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

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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

app.post(API_PATH_ANALYZE, upload.single('drawing'), async (req, res) => {
  try {
    const fileName = req.file
      ? req.file.originalname
      : (req.body && req.body.fileName) || 'drawing.pdf';
    const quoteRef = req.body && req.body.quote_id;
    const forceReanalyze = req.query.force === '1' || req.body?.force === '1';
    const hash = req.file ? drawingFileHash(req.file) : null;
    const cacheKey = req.file ? fileCacheKey(req.file) : fileName;

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

    if (VISION_ENABLED && req.file && req.file.buffer?.length) {
      try {
        const visionResult = await analyzeDrawing(req.file);
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
      if (VISION_ENABLED && !req.file?.buffer?.length) {
        return res.status(400).json({
          error: '図面ファイル本体が必要です。PDF / PNG / JPEG をアップロードしてから解析してください。',
        });
      }
      if (VISION_ENABLED && !req.file) {
        console.log('[analyze] no file body — demo by fileName only');
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
    };

    if (!isDbEnabled() && cacheKey) analyzeCache.set(cacheKey, payload);

    res.json(payload);
  } catch (err) {
    console.error('[analyze]', err);
    res.status(500).json({ error: err.message || '解析に失敗しました' });
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

export default app;
