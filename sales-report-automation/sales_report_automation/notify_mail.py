from __future__ import annotations

import os
import smtplib
import ssl
import sys
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Optional

import sqlite3

from . import db


@dataclass(frozen=True)
class _SmtpConfig:
    host: str
    port: int
    user: str
    password: str
    use_tls: bool
    mail_from: str
    mail_to: list[str]


def _load_smtp_config() -> Optional[_SmtpConfig]:
    """環境変数が揃っていれば設定を返す。未設定なら None（送らない）。"""
    host = os.environ.get("SALES_REPORT_SMTP_HOST", "").strip()
    mail_to_raw = os.environ.get("SALES_REPORT_MAIL_TO", "").strip()
    if not host and not mail_to_raw:
        return None
    if not host or not mail_to_raw:
        raise SystemExit(
            "週次メールを送るには SALES_REPORT_SMTP_HOST と "
            "SALES_REPORT_MAIL_TO の両方を設定してください（片方だけでは不可）。"
        )
    mail_from = os.environ.get("SALES_REPORT_MAIL_FROM", "").strip()
    if not mail_from:
        raise SystemExit("週次メールに SALES_REPORT_MAIL_FROM（送信元）を設定してください。")
    port_s = os.environ.get("SALES_REPORT_SMTP_PORT", "587").strip()
    try:
        port = int(port_s)
    except ValueError as e:
        raise SystemExit(f"SALES_REPORT_SMTP_PORT が整数ではありません: {port_s!r}") from e
    use_tls = os.environ.get("SALES_REPORT_SMTP_USE_TLS", "1").strip() not in (
        "0",
        "false",
        "False",
        "no",
        "NO",
    )
    user = os.environ.get("SALES_REPORT_SMTP_USER", "").strip()
    password = os.environ.get("SALES_REPORT_SMTP_PASSWORD", "")
    recipients = [a.strip() for a in mail_to_raw.split(",") if a.strip()]
    if not recipients:
        raise SystemExit("SALES_REPORT_MAIL_TO に有効な宛先がありません。")
    return _SmtpConfig(
        host=host,
        port=port,
        user=user,
        password=password,
        use_tls=use_tls,
        mail_from=mail_from,
        mail_to=recipients,
    )


def _print_smtp_failure_hints(cfg: _SmtpConfig, exc: BaseException) -> None:
    """stderr に一般的な切り分けヒントを出す（秘密は出さない）。"""
    if "example.com" in cfg.host.lower():
        print(
            "ヒント: SALES_REPORT_SMTP_HOST が smtp.example.com のままです。"
            "会社メールの案内・Gmail なら smtp.gmail.com など実在するホストに変えてください。",
            file=sys.stderr,
        )
    name = type(exc).__name__
    if name == "SMTPAuthenticationError" or "authentication" in str(exc).lower():
        print(
            "ヒント: 認証エラーです。ユーザー名・パスワードの誤り、"
            "Gmail の場合は「アプリパスワード」が必要なことが多いです。",
            file=sys.stderr,
        )
    if name in ("gaierror", "TimeoutError") or "timed out" in str(exc).lower():
        print(
            "ヒント: 接続できていません。ホスト名の誤り、社内ネットのブロック、"
            "ポート 587 の遮断を情シスに確認してください。",
            file=sys.stderr,
        )


def _send_plain_text(cfg: _SmtpConfig, subject: str, body: str) -> None:
    """SMTP でテキストメールを1通送る（STARTTLS 想定・ポート587など）。"""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg.mail_from
    msg["To"] = ", ".join(cfg.mail_to)
    msg.set_content(body, charset="utf-8")

    context = ssl.create_default_context()
    with smtplib.SMTP(cfg.host, cfg.port, timeout=60) as smtp:
        smtp.ehlo()
        if cfg.use_tls:
            smtp.starttls(context=context)
            smtp.ehlo()
        if cfg.user:
            smtp.login(cfg.user, cfg.password)
        smtp.send_message(msg)


def maybe_send_weekly_report_mail(
    conn: sqlite3.Connection,
    week_key: str,
    import_id: int,
    report_body: str,
    *,
    dry_run: bool,
    no_mail: bool,
) -> None:
    """
    取り込み完了後の週次サマリーメール。--dry-run または --no-mail では送らない。
    環境変数が未設定のときは送らず（終了コードは変えない）、stderr に1行だけ出す。
    """
    if dry_run or no_mail:
        return

    cfg = _load_smtp_config()
    if cfg is None:
        print(
            "(週次メール: SALES_REPORT_SMTP_HOST 等が未設定のため送信しません)",
            file=sys.stderr,
        )
        return

    channel = db.CHANNEL_WEEKLY_SUMMARY_EMAIL
    if db.has_successful_dispatch_for_import(conn, import_id, channel):
        print(
            "(週次メール: この取り込み分は既に送信済みのためスキップしました)",
            file=sys.stderr,
        )
        return

    dash = os.environ.get("SALES_REPORT_DASHBOARD_URL", "").strip()
    footer = (
        f"\n\n---\nダッシュボード: {dash}\n"
        if dash
        else "\n\n---\n（ダッシュボード URL は環境変数 SALES_REPORT_DASHBOARD_URL で設定できます）\n"
    )
    body = report_body.strip() + footer
    subject = f"[週次売上] {week_key}"

    try:
        _send_plain_text(cfg, subject, body)
    except Exception as e:
        detail = f"{type(e).__name__}: {e}"
        db.insert_notification_dispatch(
            conn, week_key, channel, "failed", import_id=import_id, detail=detail[:2000]
        )
        print(f"週次メールの送信に失敗しました: {detail}", file=sys.stderr)
        _print_smtp_failure_hints(cfg, e)
        raise SystemExit(1) from e

    db.insert_notification_dispatch(
        conn, week_key, channel, "sent", import_id=import_id, detail=None
    )
    print("(週次メールを送信しました)", file=sys.stderr)
