/**
 * メール送信（Gmail SMTP + アプリパスワード）
 * 必要な環境変数: GMAIL_USER（送信元 Gmail）, GMAIL_APP_PASSWORD（アプリパスワード16桁）
 * 未設定のときは isMailEnabled() が false になり、呼び出し側は URL 手渡し運用にフォールバックする
 */

import nodemailer from 'nodemailer';

export function isMailEnabled() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

/**
 * @param {{ to: string, subject: string, text: string }} mail
 * @returns {Promise<{ok: boolean, error?: string}>} 失敗しても throw しない（発注自体は成立させる）
 */
export async function sendMail(mail) {
  if (!isMailEnabled()) return { ok: false, error: 'メール未設定（GMAIL_USER / GMAIL_APP_PASSWORD）' };
  const to = String(mail.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, error: '宛先メールアドレスが不正です' };
  try {
    await getTransporter().sendMail({
      from: `"日勝ネジ 発注システム" <${process.env.GMAIL_USER}>`,
      to,
      subject: String(mail.subject || '').slice(0, 200),
      text: String(mail.text || '').slice(0, 10000),
    });
    return { ok: true };
  } catch (err) {
    console.error('[mailer]', err && err.message);
    return { ok: false, error: 'メール送信に失敗しました: ' + (err && err.message ? err.message : '') };
  }
}
