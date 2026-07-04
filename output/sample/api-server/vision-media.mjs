/**
 * Vision プロバイダ共通 — 図面ファイルの MIME 判定
 */

import path from 'path';

export const SUPPORTED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const SUPPORTED_DOC = new Set(['application/pdf']);

/**
 * @param {{ originalname: string, mimetype?: string, buffer: Buffer }} file
 */
export function detectDrawingMediaType(file) {
  const mime = (file.mimetype || '').toLowerCase();
  if (mime && mime !== 'application/octet-stream') {
    if (SUPPORTED_IMAGE.has(mime) || SUPPORTED_DOC.has(mime)) return mime;
  }
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return null;
}

/**
 * @param {string} mediaType
 * @param {Buffer} buffer
 */
export function bufferToBase64(mediaType, buffer) {
  if (!mediaType || !buffer?.length) {
    throw new Error('Vision 未対応のファイル形式、または空ファイルです');
  }
  if (!SUPPORTED_IMAGE.has(mediaType) && !SUPPORTED_DOC.has(mediaType)) {
    throw new Error('Vision 未対応のファイル形式です: ' + mediaType);
  }
  return buffer.toString('base64');
}
