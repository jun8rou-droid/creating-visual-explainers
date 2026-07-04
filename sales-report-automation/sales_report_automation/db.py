from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Generator, Optional

# メール等を実装するときの channel 引数に使う識別子（週次サマリー通知）
CHANNEL_WEEKLY_SUMMARY_EMAIL = "weekly_summary_email"

SCHEMA = """
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_key TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    source_path TEXT NOT NULL,
    file_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    row_index INTEGER NOT NULL,
    customer_code TEXT NOT NULL,
    product_code TEXT NOT NULL,
    quantity REAL,
    unit_price REAL,
    amount REAL NOT NULL,
    ship_date TEXT NOT NULL,
    channel TEXT,
    FOREIGN KEY (import_id) REFERENCES imports(id),
    UNIQUE (import_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_lines_customer_product ON lines(customer_code, product_code);
CREATE INDEX IF NOT EXISTS idx_lines_ship_date ON lines(ship_date);

CREATE TABLE IF NOT EXISTS notification_dispatches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_key TEXT NOT NULL,
    channel TEXT NOT NULL,
    import_id INTEGER,
    status TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_dispatches_import_channel
    ON notification_dispatches(import_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_dispatches_week_channel
    ON notification_dispatches(week_key, channel, created_at);

CREATE TABLE IF NOT EXISTS report_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL UNIQUE,
    week_key TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (import_id) REFERENCES imports(id)
);

CREATE INDEX IF NOT EXISTS idx_report_summaries_week_key
    ON report_summaries(week_key);
"""


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_lines_channel_column(conn: sqlite3.Connection) -> None:
    """既存 DB 向け: lines に channel 列が無ければ追加する。"""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(lines)").fetchall()]
    if cols and "channel" not in cols:
        conn.execute("ALTER TABLE lines ADD COLUMN channel TEXT")
        conn.commit()


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()
    _ensure_lines_channel_column(conn)


def delete_imports_for_week(conn: sqlite3.Connection, week_key: str) -> None:
    conn.execute(
        """
        DELETE FROM notification_dispatches WHERE week_key = ?
        """,
        (week_key,),
    )
    conn.execute(
        """
        DELETE FROM report_summaries WHERE import_id IN (
            SELECT id FROM imports WHERE week_key = ?
        )
        """,
        (week_key,),
    )
    conn.execute(
        """
        DELETE FROM lines WHERE import_id IN (
            SELECT id FROM imports WHERE week_key = ?
        )
        """,
        (week_key,),
    )
    conn.execute("DELETE FROM imports WHERE week_key = ?", (week_key,))
    conn.commit()


def insert_import(
    conn: sqlite3.Connection,
    week_key: str,
    run_id: str,
    source_path: str,
    file_sha256: str,
) -> int:
    created = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        """
        INSERT INTO imports (week_key, run_id, source_path, file_sha256, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (week_key, run_id, source_path, file_sha256, created),
    )
    conn.commit()
    return int(cur.lastrowid)


def insert_line(
    conn: sqlite3.Connection,
    import_id: int,
    row_index: int,
    customer_code: str,
    product_code: str,
    quantity: Optional[float],
    unit_price: Optional[float],
    amount: float,
    ship_date: str,
    channel: Optional[str] = None,
) -> None:
    conn.execute(
        """
        INSERT INTO lines (
            import_id, row_index, customer_code, product_code,
            quantity, unit_price, amount, ship_date, channel
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            import_id,
            row_index,
            customer_code,
            product_code,
            quantity,
            unit_price,
            amount,
            ship_date,
            channel,
        ),
    )


def commit_lines(conn: sqlite3.Connection) -> None:
    conn.commit()


def insert_report_summary(
    conn: sqlite3.Connection,
    import_id: int,
    week_key: str,
    body: str,
) -> None:
    """取り込み1回あたり最大1件。CLI で Claude 文案を生成したときに保存する。"""
    created = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO report_summaries (import_id, week_key, body, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (import_id, week_key, body, created),
    )
    conn.commit()


def fetch_report_summary_for_import(
    conn: sqlite3.Connection, import_id: int
) -> Optional[tuple[str, str]]:
    """(body, created_at) または None。"""
    row = conn.execute(
        """
        SELECT body, created_at FROM report_summaries
        WHERE import_id = ?
        LIMIT 1
        """,
        (import_id,),
    ).fetchone()
    if row is None:
        return None
    return str(row[0]), str(row[1])


def insert_notification_dispatch(
    conn: sqlite3.Connection,
    week_key: str,
    channel: str,
    status: str,
    import_id: Optional[int] = None,
    detail: Optional[str] = None,
) -> int:
    """配信の試行を1行記録する。status は 'sent' / 'failed' / 'skipped' など。"""
    created = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        """
        INSERT INTO notification_dispatches (
            week_key, channel, import_id, status, detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (week_key, channel, import_id, status, detail, created),
    )
    conn.commit()
    return int(cur.lastrowid)


def has_successful_dispatch_for_import(
    conn: sqlite3.Connection,
    import_id: int,
    channel: str,
) -> bool:
    """同一取り込み・同一チャネルで既に成功送信があるか（二重送信防止）。"""
    row = conn.execute(
        """
        SELECT 1 FROM notification_dispatches
        WHERE import_id = ? AND channel = ? AND status = 'sent'
        LIMIT 1
        """,
        (import_id, channel),
    ).fetchone()
    return row is not None


def find_historical_unit_price(
    conn: sqlite3.Connection,
    customer_code: str,
    product_code: str,
    exclude_import_id: int,
) -> Optional[tuple[float, str]]:
    """過去インポートから同一顧客・同一品目の最新単価を返す (price, ship_date)。"""
    row = conn.execute(
        """
        SELECT unit_price, ship_date FROM lines
        WHERE customer_code = ? AND product_code = ?
          AND unit_price IS NOT NULL
          AND import_id != ?
        ORDER BY ship_date DESC, id DESC
        LIMIT 1
        """,
        (customer_code, product_code, exclude_import_id),
    ).fetchone()
    if row is None:
        return None
    return float(row[0]), str(row[1])


@contextmanager
def db_session(db_path: str) -> Generator[sqlite3.Connection, None, None]:
    conn = connect(db_path)
    try:
        init_db(conn)
        yield conn
    finally:
        conn.close()
