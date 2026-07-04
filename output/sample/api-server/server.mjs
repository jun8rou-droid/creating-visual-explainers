/**
 * 加工費見積 — ローカル開発サーバ
 * 起動: cd output/sample && npm start
 * DB:   docker compose up -d → npm run migrate
 * ブラウザ: http://localhost:3847/machining-quote-4pane-mock.html
 */

import { isDbEnabled, pingDb } from './db.mjs';
import app from './app.mjs';
import { getVisionStatus } from './vision-router.mjs';
import { API_PATH_ANALYZE, API_PATH_FEEDBACK } from '../js/drawing-analyze/shared.mjs';

const PORT = Number(process.env.PORT || 3847);

app.listen(PORT, async () => {
  const db = await pingDb();
  const vision = getVisionStatus();
  console.log('');
  console.log('  加工費見積 API（ローカル）');
  console.log('  http://localhost:' + PORT + '/machining-quote-4pane-mock.html');
  console.log('  GET  /api/quotes');
  console.log('  POST /api/quotes');
  console.log('  GET  /api/quotes/:ref/meta');
  console.log('  GET  /api/quotes/:ref/revisions/:rev');
  console.log('  POST /api/quotes/:ref/confirm');
  console.log('  GET  /api/quotes/:ref/draft');
  console.log('  PUT  /api/quotes/:ref/draft');
  console.log('  POST ' + API_PATH_ANALYZE);
  console.log('  POST ' + API_PATH_FEEDBACK);
  if (vision.enabled) {
    console.log('  Vision: ON —', vision.provider, '(' + vision.model + ')');
  } else if (vision.error) {
    console.log('  Vision: 設定エラー —', vision.error);
  } else {
    console.log('  Vision: OFF（API キー未設定 → デモ）');
  }
  if (isDbEnabled()) {
    console.log('  DB:', db.ok ? '接続 OK' : '接続失敗 — ' + (db.reason || ''));
    if (!db.ok) console.log('       → docker compose up -d && npm run migrate');
  } else {
    console.log('  DB: OFF（DATABASE_URL 未設定 → feedback は JSONL）');
  }
  console.log('');
});
