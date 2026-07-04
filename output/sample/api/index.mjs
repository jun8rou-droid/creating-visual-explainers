/**
 * Vercel Serverless Function — Express API
 * 静的 HTML/JS は Vercel CDN、/api/* はこのハンドラ
 */
import app from '../api-server/app.mjs';

export default app;
