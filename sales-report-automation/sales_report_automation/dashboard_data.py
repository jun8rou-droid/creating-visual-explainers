"""週次ダッシュボード用の DB 集計（CLI パイプラインの取り込み結果を読む）。"""

from __future__ import annotations

import calendar
import re
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Optional, Tuple

import csv
import io
import sqlite3

from . import db, week_calendar

_WEEK_KEY_RE = re.compile(r"^(\d{4})-W(\d{2})$")
_MONTH_KEY_RE = re.compile(r"^(\d{4})-(\d{2})$")

# ダッシュボードの単価欠けミニ一覧の最大行数
MISSING_UNIT_PRICE_PREVIEW_LIMIT = 25
# 月末作業用 CSV の行数上限（異常データの暴走防止）
MISSING_UNIT_PRICE_CSV_LIMIT = 20000


def _sql_ship_date_normalized(column: str) -> str:
    """SQLite 用: / ・ . を - に寄せた出荷日（暦月集計の前提）。"""
    return f"replace(replace(trim({column}), '/', '-'), '.', '-')"


def _sql_calendar_month_key(column: str) -> str:
    """SQLite 用: 正規化した出荷日から YYYY-MM（8桁のみ YYYYMMDD も可）。"""
    n = _sql_ship_date_normalized(column)
    return (
        "CASE "
        f"WHEN length({n}) >= 10 AND substr({n}, 5, 1) = '-' THEN substr({n}, 1, 7) "
        f"WHEN length({n}) = 8 AND {n} GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' "
        f"THEN substr({n}, 1, 4) || '-' || substr({n}, 5, 2) "
        "ELSE NULL END"
    )


def extract_material_key(product_code: str) -> Optional[str]:
    """
    マッピング JSON の product_code_parts が
    [商品コード, 寸法, 材質, 商品名] のとき、連結後の 3 番目セグメントを材質とみなす。
    （区切りは既定 |。セグメントが3未満の品目キーでは None）
    """
    s = (product_code or "").strip()
    if not s:
        return None
    parts = [p.strip() for p in s.split("|")]
    if len(parts) < 3:
        return None
    m = parts[2]
    return m if m else None


class CustomerMaterialHistoryCache:
    """得意先ごとに単価付き明細を遅延ロードし、同一材質の最新単価（別 import）を探す。"""

    __slots__ = ("_conn", "_by_customer")

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._by_customer: dict[str, list[tuple[str, float, str, int]]] = {}

    def lookup(
        self, customer_code: str, product_code: str, exclude_import_id: int
    ) -> Optional[tuple[float, str]]:
        mat = extract_material_key(product_code)
        if not mat:
            return None
        if customer_code not in self._by_customer:
            cur = self._conn.execute(
                """
                SELECT product_code, unit_price, ship_date, import_id
                FROM lines
                WHERE customer_code = ? AND unit_price IS NOT NULL
                ORDER BY ship_date DESC, id DESC
                LIMIT 12000
                """,
                (customer_code,),
            )
            self._by_customer[customer_code] = [
                (str(a), float(b), str(c), int(d)) for a, b, c, d in cur.fetchall()
            ]
        for pr_pc, up, sd, imp in self._by_customer[customer_code]:
            if imp == exclude_import_id:
                continue
            if extract_material_key(pr_pc) == mat:
                return up, sd
        return None


def implied_unit_price(amount: float, quantity: Optional[float]) -> Optional[float]:
    """金額÷数量。数量が無い・0 に近いときは None。"""
    if quantity is None:
        return None
    q = float(quantity)
    if abs(q) < 1e-12:
        return None
    return round(float(amount) / q, 6)


def pick_recommended_unit_price(
    historical_exact: Optional[float],
    historical_customer_material: Optional[float],
    peer_customer_material: Optional[float],
    peer_product: Optional[float],
    implied: Optional[float],
) -> Optional[float]:
    """入力補助用: 同一品目過去 → 同一得意先×材質の過去 → 同月/同週の同先×材質平均 → 同品目平均 → 逆算。"""
    for x in (
        historical_exact,
        historical_customer_material,
        peer_customer_material,
        peer_product,
        implied,
    ):
        if x is not None:
            return round(float(x), 6)
    return None


def map_peer_avg_unit_price_by_product_for_month(
    conn: sqlite3.Connection, ym: str
) -> dict[str, float]:
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT product_code, AVG(unit_price) AS av
        FROM lines
        WHERE {mk} = ? AND unit_price IS NOT NULL
        GROUP BY product_code
        """,
        (ym,),
    )
    return {str(r[0]): float(r[1]) for r in cur.fetchall()}


def map_peer_avg_unit_price_by_product_for_week(
    conn: sqlite3.Connection, week_key: str
) -> dict[str, float]:
    cur = conn.execute(
        """
        SELECT l.product_code, AVG(l.unit_price) AS av
        FROM lines l
        INNER JOIN imports i ON l.import_id = i.id
        WHERE i.week_key = ? AND l.unit_price IS NOT NULL
        GROUP BY l.product_code
        """,
        (week_key,),
    )
    return {str(r[0]): float(r[1]) for r in cur.fetchall()}


def map_peer_avg_unit_price_by_customer_material_for_month(
    conn: sqlite3.Connection, ym: str
) -> dict[tuple[str, str], float]:
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT customer_code, product_code, unit_price
        FROM lines
        WHERE {mk} = ? AND unit_price IS NOT NULL
        """,
        (ym,),
    )
    buckets: dict[tuple[str, str], list[float]] = defaultdict(list)
    for cust, pc, up in cur.fetchall():
        mat = extract_material_key(str(pc))
        if not mat:
            continue
        buckets[(str(cust), mat)].append(float(up))
    return {k: sum(vals) / len(vals) for k, vals in buckets.items()}


def map_peer_avg_unit_price_by_customer_material_for_week(
    conn: sqlite3.Connection, week_key: str
) -> dict[tuple[str, str], float]:
    cur = conn.execute(
        """
        SELECT l.customer_code, l.product_code, l.unit_price
        FROM lines l
        INNER JOIN imports i ON l.import_id = i.id
        WHERE i.week_key = ? AND l.unit_price IS NOT NULL
        """,
        (week_key,),
    )
    buckets: dict[tuple[str, str], list[float]] = defaultdict(list)
    for cust, pc, up in cur.fetchall():
        mat = extract_material_key(str(pc))
        if not mat:
            continue
        buckets[(str(cust), mat)].append(float(up))
    return {k: sum(vals) / len(vals) for k, vals in buckets.items()}


def parse_week_key(week_key: str) -> tuple[int, int]:
    m = _WEEK_KEY_RE.fullmatch(week_key.strip())
    if not m:
        raise ValueError('week_key は "YYYY-Www" 形式で指定してください（例: 2026-W14）')
    return int(m.group(1)), int(m.group(2))


def parse_month_key(month_key: str) -> tuple[int, int]:
    m = _MONTH_KEY_RE.fullmatch(month_key.strip())
    if not m:
        raise ValueError('month は "YYYY-MM" 形式で指定してください（例: 2026-04）')
    y, mo = int(m.group(1)), int(m.group(2))
    if mo < 1 or mo > 12:
        raise ValueError("month の月は 01〜12 です")
    return y, mo


def prev_month_key(month_key: str) -> str:
    y, m = parse_month_key(month_key)
    d0 = date(y, m, 1) - timedelta(days=1)
    return f"{d0.year}-{d0.month:02d}"


def prev_year_same_calendar_month_key(month_key: str) -> str:
    y, m = parse_month_key(month_key)
    return f"{y - 1}-{m:02d}"


def period_ja_for_month(month_key: str) -> str:
    y, m = parse_month_key(month_key)
    _, last_d = calendar.monthrange(y, m)
    return f"{y}年{m}月1日〜{m}月{last_d}日"


def prev_week_key(week_key: str) -> str:
    y, w = parse_week_key(week_key)
    monday = date.fromisocalendar(y, w, 1)
    prev = monday - timedelta(weeks=1)
    py, pw, _ = prev.isocalendar()
    return f"{py}-W{pw:02d}"


def prev_year_same_iso_week_key(week_key: str) -> Optional[str]:
    """前年の同一 ISO 週番号（例: 2024-W05 → 2023-W05）。前年にその週がない場合は None。"""
    y, w = parse_week_key(week_key)
    try:
        monday = date.fromisocalendar(y - 1, w, 1)
    except ValueError:
        return None
    py, pw, _ = monday.isocalendar()
    return f"{py}-W{pw:02d}"


def latest_import_id_for_week(conn: sqlite3.Connection, week_key: str) -> Optional[int]:
    row = conn.execute(
        """
        SELECT id FROM imports
        WHERE week_key = ?
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 1
        """,
        (week_key,),
    ).fetchone()
    return int(row[0]) if row else None


def aggregate_for_import(conn: sqlite3.Connection, import_id: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
            COUNT(*) AS line_count,
            COALESCE(SUM(amount), 0) AS total_amount,
            SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END) AS missing_unit_count,
            COALESCE(SUM(quantity), 0) AS sum_qty,
            COUNT(DISTINCT customer_code) AS distinct_customers,
            MIN(ship_date) AS min_ship,
            MAX(ship_date) AS max_ship
        FROM lines WHERE import_id = ?
        """,
        (import_id,),
    ).fetchone()
    line_count = int(row[0])
    total = float(row[1])
    missing = int(row[2])
    sum_qty = float(row[3]) if row[3] is not None else 0.0
    distinct_cust = int(row[4])
    min_ship = row[5]
    max_ship = row[6]
    avg_per_line = (total / line_count) if line_count else 0.0
    avg_unit_weighted = (total / sum_qty) if sum_qty > 0 else None
    return {
        "line_count": line_count,
        "total_amount": total,
        "missing_unit_price_rows": missing,
        "sum_quantity": sum_qty,
        "distinct_customers": distinct_cust,
        "min_ship_date": min_ship,
        "max_ship_date": max_ship,
        "avg_amount_per_line": avg_per_line,
        "avg_unit_price_weighted": avg_unit_weighted,
    }


def daily_amounts_for_import(conn: sqlite3.Connection, import_id: int) -> list[dict[str, Any]]:
    cur = conn.execute(
        """
        SELECT ship_date, SUM(amount) AS day_total, COUNT(*) AS day_lines
        FROM lines
        WHERE import_id = ?
        GROUP BY ship_date
        ORDER BY ship_date
        """,
        (import_id,),
    )
    return [
        {"ship_date": str(r[0]), "amount": float(r[1]), "line_count": int(r[2])}
        for r in cur.fetchall()
    ]


def _missing_row_payload(
    conn: sqlite3.Connection,
    *,
    line_id: int,
    import_id: int,
    row_index: int,
    week_key: str,
    customer_code: str,
    product_code: str,
    quantity: Optional[float],
    amount: float,
    ship_date: str,
    peer_by_product: dict[str, float],
    peer_by_customer_material: dict[tuple[str, str], float],
    hist_cm_cache: CustomerMaterialHistoryCache,
) -> dict[str, Any]:
    hist = db.find_historical_unit_price(conn, customer_code, product_code, import_id)
    hval = hist[0] if hist else None
    peer = peer_by_product.get(product_code)
    mat = extract_material_key(product_code)
    hist_cm = hist_cm_cache.lookup(customer_code, product_code, import_id)
    hcm_val = hist_cm[0] if hist_cm else None
    hcm_sd = hist_cm[1] if hist_cm else None
    peer_cm = (
        peer_by_customer_material.get((customer_code, mat)) if mat else None
    )
    impl = implied_unit_price(amount, quantity)
    rec = pick_recommended_unit_price(hval, hcm_val, peer_cm, peer, impl)
    return {
        "line_id": line_id,
        "import_id": import_id,
        "week_key": week_key,
        "row_index": row_index,
        "customer_code": customer_code,
        "product_code": product_code,
        "material_key": mat,
        "quantity": quantity,
        "amount": amount,
        "ship_date": ship_date,
        "suggested_unit_price": hval,
        "suggested_from_ship_date": hist[1] if hist else None,
        "same_customer_material_hist_unit_price": hcm_val,
        "same_customer_material_hist_ship_date": hcm_sd,
        "peer_avg_customer_material_unit_price": peer_cm,
        "peer_avg_unit_price": peer,
        "implied_unit_price": impl,
        "recommended_unit_price": rec,
    }


def missing_unit_price_preview(
    conn: sqlite3.Connection,
    import_id: int,
    week_key: str,
    limit: int = MISSING_UNIT_PRICE_PREVIEW_LIMIT,
) -> list[dict[str, Any]]:
    """単価が NULL の行を先頭 limit 件。候補・推奨を付与。"""
    peers = map_peer_avg_unit_price_by_product_for_week(conn, week_key)
    peers_cm = map_peer_avg_unit_price_by_customer_material_for_week(conn, week_key)
    hist_cm_cache = CustomerMaterialHistoryCache(conn)
    cur = conn.execute(
        """
        SELECT l.id, l.row_index, l.customer_code, l.product_code, l.quantity, l.amount, l.ship_date, i.week_key
        FROM lines l
        INNER JOIN imports i ON l.import_id = i.id
        WHERE l.import_id = ? AND l.unit_price IS NULL
        ORDER BY l.row_index
        LIMIT ?
        """,
        (import_id, limit),
    )
    out: list[dict[str, Any]] = []
    for r in cur.fetchall():
        qty_raw = r[4]
        qty = float(qty_raw) if qty_raw is not None else None
        out.append(
            _missing_row_payload(
                conn,
                line_id=int(r[0]),
                import_id=import_id,
                row_index=int(r[1]),
                week_key=str(r[7]),
                customer_code=str(r[2]),
                product_code=str(r[3]),
                quantity=qty,
                amount=float(r[5]),
                ship_date=str(r[6]),
                peer_by_product=peers,
                peer_by_customer_material=peers_cm,
                hist_cm_cache=hist_cm_cache,
            )
        )
    return out


def import_meta(conn: sqlite3.Connection, import_id: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT id, week_key, run_id, source_path, created_at
        FROM imports WHERE id = ?
        """,
        (import_id,),
    ).fetchone()
    if row is None:
        raise ValueError("import が見つかりません")
    return {
        "id": int(row[0]),
        "week_key": str(row[1]),
        "run_id": str(row[2]),
        "source_path": str(row[3]),
        "created_at": str(row[4]),
    }


def _period_ja_pretty(min_ship: str, max_ship: str) -> str:
    def parts(d: str) -> Optional[Tuple[int, int, int]]:
        ps = d.split("-")
        if len(ps) != 3:
            return None
        return int(ps[0]), int(ps[1]), int(ps[2])

    p0, p1 = parts(min_ship), parts(max_ship)
    if not p0 or not p1:
        return f"{min_ship} 〜 {max_ship}" if min_ship != max_ship else min_ship
    y0, m0, d0 = p0
    y1, m1, d1 = p1
    a = f"{y0}年{m0}月{d0}日"
    if min_ship == max_ship:
        return a
    if y0 == y1:
        b = f"{m1}月{d1}日"
    else:
        b = f"{y1}年{m1}月{d1}日"
    return f"{a} 〜 {b}"


def pct_change(prev: float, curr: float) -> Optional[float]:
    if prev == 0:
        return None
    return round(100.0 * (curr - prev) / prev, 1)


def channel_breakdown_for_import(conn: sqlite3.Connection, import_id: int) -> dict[str, Any]:
    cur = conn.execute(
        """
        SELECT COALESCE(NULLIF(TRIM(channel), ''), '(未分類)') AS ch, SUM(amount) AS amt
        FROM lines
        WHERE import_id = ?
        GROUP BY COALESCE(NULLIF(TRIM(channel), ''), '(未分類)')
        ORDER BY amt DESC
        """,
        (import_id,),
    )
    rows = [{"channel": str(r[0]), "amount": float(r[1])} for r in cur.fetchall()]
    total = float(sum(b["amount"] for b in rows))
    for b in rows:
        b["pct"] = round(100.0 * b["amount"] / total, 1) if total > 0 else 0.0
    only_uncategorized = len(rows) == 1 and rows[0]["channel"] == "(未分類)"
    return {
        "buckets": rows,
        "total_amount": total,
        "has_distinct_channels": not only_uncategorized,
    }


def top_customers_for_import(
    conn: sqlite3.Connection, import_id: int, limit: int = 10
) -> list[dict[str, Any]]:
    cur = conn.execute(
        """
        SELECT customer_code, SUM(amount) AS total, COUNT(*) AS n,
               COALESCE(SUM(quantity), 0) AS qty
        FROM lines
        WHERE import_id = ?
        GROUP BY customer_code
        ORDER BY total DESC
        LIMIT ?
        """,
        (import_id, limit),
    )
    return [
        {
            "rank": i,
            "customer_code": str(r[0]),
            "total_amount": float(r[1]),
            "line_count": int(r[2]),
            "sum_quantity": float(r[3] or 0.0),
        }
        for i, r in enumerate(cur.fetchall(), start=1)
    ]


def top_products_for_import(
    conn: sqlite3.Connection, import_id: int, limit: int = 10
) -> list[dict[str, Any]]:
    cur = conn.execute(
        """
        SELECT product_code, SUM(amount) AS total, COUNT(*) AS n,
               COALESCE(SUM(quantity), 0) AS qty
        FROM lines
        WHERE import_id = ?
        GROUP BY product_code
        ORDER BY total DESC
        LIMIT ?
        """,
        (import_id, limit),
    )
    return [
        {
            "rank": i,
            "product_code": str(r[0]),
            "total_amount": float(r[1]),
            "line_count": int(r[2]),
            "sum_quantity": float(r[3] or 0.0),
        }
        for i, r in enumerate(cur.fetchall(), start=1)
    ]


def ytd_metrics(
    conn: sqlite3.Connection,
    reference_date_str: Optional[str] = None,
) -> dict[str, Any]:
    """
    年初来累計（YTD）と前年同期累計、過去5年分の年合計を返す。
    reference_date_str: 'YYYY-MM-DD'。省略時は DB 内の最大 ship_date を基準にする。
    """
    n_norm = _sql_ship_date_normalized("ship_date")
    if reference_date_str:
        ref = reference_date_str
    else:
        row = conn.execute(
            f"SELECT MAX({n_norm}) FROM lines"
        ).fetchone()
        ref = str(row[0]) if row and row[0] else ""
    if not ref or len(ref) < 10:
        return {
            "reference_date": None,
            "year": None,
            "ytd_amount": 0.0,
            "ytd_line_count": 0,
            "prev_ytd_amount": 0.0,
            "prev_ytd_line_count": 0,
            "yoy_pct": None,
            "annual_history": [],
        }
    year = ref[:4]
    mmdd = ref[5:10]  # "MM-DD"
    cutoff = f"{year}-{mmdd}"
    prev_year = f"{int(year) - 1:04d}"
    prev_cutoff = f"{prev_year}-{mmdd}"

    def _agg_year_to(date_inclusive: str, year_str: str) -> tuple[float, int]:
        row = conn.execute(
            f"""
            SELECT COALESCE(SUM(amount), 0), COUNT(*)
            FROM lines
            WHERE {n_norm} >= ? AND {n_norm} <= ?
              AND substr({n_norm}, 1, 4) = ?
            """,
            (f"{year_str}-01-01", date_inclusive, year_str),
        ).fetchone()
        return float(row[0] or 0.0), int(row[1] or 0)

    ytd_amt, ytd_n = _agg_year_to(cutoff, year)
    prev_amt, prev_n = _agg_year_to(prev_cutoff, prev_year)
    yoy_pct = pct_change(prev_amt, ytd_amt) if prev_amt > 0 else None

    cur = conn.execute(
        f"""
        SELECT substr({n_norm}, 1, 4) AS y, COALESCE(SUM(amount), 0) AS amt
        FROM lines
        WHERE substr({n_norm}, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
        GROUP BY y
        ORDER BY y DESC
        LIMIT 5
        """
    )
    annual: list[dict[str, Any]] = []
    for r in cur.fetchall():
        annual.append({"year": str(r[0]), "amount": float(r[1])})
    annual.reverse()  # 古い順
    return {
        "reference_date": ref,
        "year": year,
        "ytd_amount": ytd_amt,
        "ytd_line_count": ytd_n,
        "prev_year": prev_year,
        "prev_ytd_amount": prev_amt,
        "prev_ytd_line_count": prev_n,
        "yoy_pct": yoy_pct,
        "annual_history": annual,
    }


def transaction_matrix_for_import(
    conn: sqlite3.Connection,
    import_id: int,
    top_n: int = 5,
) -> dict[str, Any]:
    """週次（単一インポート基準）の Top5顧客 × Top5品目 クロス集計。"""
    cust_rows = conn.execute(
        """
        SELECT customer_code, SUM(amount) AS amt
        FROM lines WHERE import_id = ?
        GROUP BY customer_code
        ORDER BY amt DESC
        LIMIT ?
        """,
        (import_id, top_n),
    ).fetchall()
    prod_rows = conn.execute(
        """
        SELECT product_code, SUM(amount) AS amt
        FROM lines WHERE import_id = ?
        GROUP BY product_code
        ORDER BY amt DESC
        LIMIT ?
        """,
        (import_id, top_n),
    ).fetchall()
    customers = [str(r[0]) for r in cust_rows]
    products = [str(r[0]) for r in prod_rows]
    if not customers or not products:
        return {"customers": [], "products": [], "cells": []}
    ph_c = ",".join(["?"] * len(customers))
    ph_p = ",".join(["?"] * len(products))
    cur = conn.execute(
        f"""
        SELECT customer_code, product_code, SUM(amount) AS amt
        FROM lines
        WHERE import_id = ? AND customer_code IN ({ph_c}) AND product_code IN ({ph_p})
        GROUP BY customer_code, product_code
        """,
        [import_id, *customers, *products],
    )
    cell_map: dict[tuple[str, str], float] = {}
    for r in cur.fetchall():
        cell_map[(str(r[0]), str(r[1]))] = float(r[2])
    cells: list[list[float]] = []
    for c in customers:
        row = [cell_map.get((c, p), 0.0) for p in products]
        cells.append(row)
    return {"customers": customers, "products": products, "cells": cells}


def transaction_matrix_for_month(
    conn: sqlite3.Connection,
    month_key: str,
    top_n: int = 5,
) -> dict[str, Any]:
    """月次（暦月・出荷日基準）の Top5顧客 × Top5品目 クロス集計。"""
    mk = _sql_calendar_month_key("ship_date")
    cust_rows = conn.execute(
        f"""
        SELECT customer_code, SUM(amount) AS amt
        FROM lines WHERE {mk} = ?
        GROUP BY customer_code
        ORDER BY amt DESC
        LIMIT ?
        """,
        (month_key, top_n),
    ).fetchall()
    prod_rows = conn.execute(
        f"""
        SELECT product_code, SUM(amount) AS amt
        FROM lines WHERE {mk} = ?
        GROUP BY product_code
        ORDER BY amt DESC
        LIMIT ?
        """,
        (month_key, top_n),
    ).fetchall()
    customers = [str(r[0]) for r in cust_rows]
    products = [str(r[0]) for r in prod_rows]
    if not customers or not products:
        return {"customers": [], "products": [], "cells": []}
    ph_c = ",".join(["?"] * len(customers))
    ph_p = ",".join(["?"] * len(products))
    cur = conn.execute(
        f"""
        SELECT customer_code, product_code, SUM(amount) AS amt
        FROM lines
        WHERE {mk} = ? AND customer_code IN ({ph_c}) AND product_code IN ({ph_p})
        GROUP BY customer_code, product_code
        """,
        [month_key, *customers, *products],
    )
    cell_map: dict[tuple[str, str], float] = {}
    for r in cur.fetchall():
        cell_map[(str(r[0]), str(r[1]))] = float(r[2])
    cells: list[list[float]] = []
    for c in customers:
        row = [cell_map.get((c, p), 0.0) for p in products]
        cells.append(row)
    return {"customers": customers, "products": products, "cells": cells}


def list_recent_month_keys(conn: sqlite3.Connection, limit: int = 24) -> list[str]:
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT DISTINCT {mk} AS ym
        FROM lines
        WHERE {mk} IS NOT NULL
        ORDER BY ym DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [str(r[0]) for r in cur.fetchall()]


def aggregate_lines_for_month(conn: sqlite3.Connection, ym: str) -> dict[str, Any]:
    mk = _sql_calendar_month_key("ship_date")
    row = conn.execute(
        f"""
        SELECT
            COUNT(*),
            COALESCE(SUM(amount), 0),
            SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END),
            COALESCE(SUM(quantity), 0),
            COUNT(DISTINCT customer_code),
            MIN(ship_date),
            MAX(ship_date)
        FROM lines
        WHERE {mk} = ?
        """,
        (ym,),
    ).fetchone()
    line_count = int(row[0] or 0)
    total = float(row[1] or 0)
    missing = int(row[2] or 0)
    sum_qty = float(row[3]) if row[3] is not None else 0.0
    distinct_cust = int(row[4] or 0)
    min_ship = row[5]
    max_ship = row[6]
    avg_per_line = (total / line_count) if line_count else 0.0
    avg_unit_weighted = (total / sum_qty) if sum_qty > 0 else None
    return {
        "line_count": line_count,
        "total_amount": total,
        "missing_unit_price_rows": missing,
        "sum_quantity": sum_qty,
        "distinct_customers": distinct_cust,
        "min_ship_date": min_ship,
        "max_ship_date": max_ship,
        "avg_amount_per_line": avg_per_line,
        "avg_unit_price_weighted": avg_unit_weighted,
    }


def weekly_amounts_in_month(conn: sqlite3.Connection, ym: str) -> list[dict[str, Any]]:
    """
    暦月内の出荷日を運用週（JST月曜8時境界）でまとめた週別集計を返す。
    月またぎ週は、月内に該当する出荷日分のみが計上される。
    """
    daily = daily_amounts_for_month(conn, ym)
    buckets: dict[str, dict[str, Any]] = {}
    for d in daily:
        try:
            sd = week_calendar.parse_ship_date(str(d["ship_date"]))
        except ValueError:
            continue
        wk = week_calendar.week_key_for_instant(week_calendar.jst_noon_on(sd))
        b = buckets.setdefault(
            wk,
            {"week_key": wk, "amount": 0.0, "line_count": 0, "ship_dates": []},
        )
        b["amount"] += float(d["amount"])
        b["line_count"] += int(d["line_count"])
        b["ship_dates"].append(str(d["ship_date"]))
    out: list[dict[str, Any]] = []
    for wk in sorted(buckets.keys()):
        b = buckets[wk]
        sds = b["ship_dates"]
        out.append(
            {
                "week_key": wk,
                "amount": float(b["amount"]),
                "line_count": int(b["line_count"]),
                "min_ship_date": min(sds) if sds else None,
                "max_ship_date": max(sds) if sds else None,
            }
        )
    return out


def daily_amounts_for_month(conn: sqlite3.Connection, ym: str) -> list[dict[str, Any]]:
    norm = _sql_ship_date_normalized("ship_date")
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT {norm} AS ship_date, SUM(amount) AS day_total, COUNT(*) AS day_lines
        FROM lines
        WHERE {mk} = ?
        GROUP BY {norm}
        ORDER BY {norm}
        """,
        (ym,),
    )
    return [
        {"ship_date": str(r[0]), "amount": float(r[1]), "line_count": int(r[2])}
        for r in cur.fetchall()
    ]


def channel_breakdown_for_month(conn: sqlite3.Connection, ym: str) -> dict[str, Any]:
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT COALESCE(NULLIF(TRIM(channel), ''), '(未分類)') AS ch, SUM(amount) AS amt
        FROM lines
        WHERE {mk} = ?
        GROUP BY COALESCE(NULLIF(TRIM(channel), ''), '(未分類)')
        ORDER BY amt DESC
        """,
        (ym,),
    )
    rows = [{"channel": str(r[0]), "amount": float(r[1])} for r in cur.fetchall()]
    total = float(sum(b["amount"] for b in rows))
    for b in rows:
        b["pct"] = round(100.0 * b["amount"] / total, 1) if total > 0 else 0.0
    only_uncategorized = len(rows) == 1 and rows[0]["channel"] == "(未分類)"
    return {
        "buckets": rows,
        "total_amount": total,
        "has_distinct_channels": not only_uncategorized,
    }


def top_customers_for_month(
    conn: sqlite3.Connection, ym: str, limit: int = 10
) -> list[dict[str, Any]]:
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT customer_code, SUM(amount) AS total, COUNT(*) AS n,
               COALESCE(SUM(quantity), 0) AS qty
        FROM lines
        WHERE {mk} = ?
        GROUP BY customer_code
        ORDER BY total DESC
        LIMIT ?
        """,
        (ym, limit),
    )
    return [
        {
            "rank": i,
            "customer_code": str(r[0]),
            "total_amount": float(r[1]),
            "line_count": int(r[2]),
            "sum_quantity": float(r[3] or 0.0),
        }
        for i, r in enumerate(cur.fetchall(), start=1)
    ]


def top_products_for_month(
    conn: sqlite3.Connection, ym: str, limit: int = 10
) -> list[dict[str, Any]]:
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT product_code, SUM(amount) AS total, COUNT(*) AS n,
               COALESCE(SUM(quantity), 0) AS qty
        FROM lines
        WHERE {mk} = ?
        GROUP BY product_code
        ORDER BY total DESC
        LIMIT ?
        """,
        (ym, limit),
    )
    return [
        {
            "rank": i,
            "product_code": str(r[0]),
            "total_amount": float(r[1]),
            "line_count": int(r[2]),
            "sum_quantity": float(r[3] or 0.0),
        }
        for i, r in enumerate(cur.fetchall(), start=1)
    ]


def missing_unit_price_preview_for_month(
    conn: sqlite3.Connection,
    ym: str,
    limit: int = MISSING_UNIT_PRICE_PREVIEW_LIMIT,
) -> list[dict[str, Any]]:
    """
    暦月内の単価欠け行プレビュー。
    同一CSVの再取り込みで「見た目同じ行」が複数出るのを避けるため、
    customer+product+ship_date+amount+quantity が同じものは集約して
    occurrences フィールドに出現回数を入れる。
    """
    peers = map_peer_avg_unit_price_by_product_for_month(conn, ym)
    peers_cm = map_peer_avg_unit_price_by_customer_material_for_month(conn, ym)
    hist_cm_cache = CustomerMaterialHistoryCache(conn)
    mk = _sql_calendar_month_key("l.ship_date")
    # 集約用に多めに引いてから limit 件に絞る
    raw_limit = max(limit * 8, 200)
    cur = conn.execute(
        f"""
        SELECT l.id, l.import_id, l.row_index, l.customer_code, l.product_code, l.quantity, l.amount, l.ship_date, i.week_key
        FROM lines l
        INNER JOIN imports i ON l.import_id = i.id
        WHERE {mk} = ? AND l.unit_price IS NULL
        ORDER BY l.ship_date, l.id
        LIMIT ?
        """,
        (ym, raw_limit),
    )

    grouped: dict[tuple, dict[str, Any]] = {}
    order: list[tuple] = []
    for r in cur.fetchall():
        qty_raw = r[5]
        qty = float(qty_raw) if qty_raw is not None else None
        amount = float(r[6])
        ship_date = str(r[7])
        cust = str(r[3])
        prod = str(r[4])
        key = (cust, prod, ship_date, amount, qty)
        if key not in grouped:
            payload = _missing_row_payload(
                conn,
                line_id=int(r[0]),
                import_id=int(r[1]),
                row_index=int(r[2]),
                week_key=str(r[8]),
                customer_code=cust,
                product_code=prod,
                quantity=qty,
                amount=amount,
                ship_date=ship_date,
                peer_by_product=peers,
                peer_by_customer_material=peers_cm,
                hist_cm_cache=hist_cm_cache,
            )
            payload["occurrences"] = 1
            grouped[key] = payload
            order.append(key)
            if len(order) >= limit:
                # limit に達したらこれ以上のグループは作らない（既存グループの加算は続ける）
                pass
        else:
            grouped[key]["occurrences"] += 1
    return [grouped[k] for k in order[:limit]]


def missing_unit_price_rows_for_month_export(
    conn: sqlite3.Connection, ym: str
) -> list[dict[str, Any]]:
    parse_month_key(ym)
    peers = map_peer_avg_unit_price_by_product_for_month(conn, ym)
    peers_cm = map_peer_avg_unit_price_by_customer_material_for_month(conn, ym)
    hist_cm_cache = CustomerMaterialHistoryCache(conn)
    mk = _sql_calendar_month_key("l.ship_date")
    cur = conn.execute(
        f"""
        SELECT l.id, l.import_id, l.row_index, l.customer_code, l.product_code, l.quantity, l.amount, l.ship_date, i.week_key
        FROM lines l
        INNER JOIN imports i ON l.import_id = i.id
        WHERE {mk} = ? AND l.unit_price IS NULL
        ORDER BY l.ship_date, l.id
        LIMIT ?
        """,
        (ym, MISSING_UNIT_PRICE_CSV_LIMIT),
    )
    out: list[dict[str, Any]] = []
    for r in cur.fetchall():
        qty_raw = r[5]
        qty = float(qty_raw) if qty_raw is not None else None
        out.append(
            _missing_row_payload(
                conn,
                line_id=int(r[0]),
                import_id=int(r[1]),
                row_index=int(r[2]),
                week_key=str(r[8]),
                customer_code=str(r[3]),
                product_code=str(r[4]),
                quantity=qty,
                amount=float(r[6]),
                ship_date=str(r[7]),
                peer_by_product=peers,
                peer_by_customer_material=peers_cm,
                hist_cm_cache=hist_cm_cache,
            )
        )
    return out


def missing_unit_price_rows_for_week_export(
    conn: sqlite3.Connection, week_key: str
) -> list[dict[str, Any]]:
    parse_week_key(week_key)
    peers = map_peer_avg_unit_price_by_product_for_week(conn, week_key)
    peers_cm = map_peer_avg_unit_price_by_customer_material_for_week(conn, week_key)
    hist_cm_cache = CustomerMaterialHistoryCache(conn)
    cur = conn.execute(
        """
        SELECT l.id, l.import_id, l.row_index, l.customer_code, l.product_code, l.quantity, l.amount, l.ship_date, i.week_key
        FROM lines l
        INNER JOIN imports i ON l.import_id = i.id
        WHERE i.week_key = ? AND l.unit_price IS NULL
        ORDER BY l.ship_date, l.id
        LIMIT ?
        """,
        (week_key, MISSING_UNIT_PRICE_CSV_LIMIT),
    )
    out: list[dict[str, Any]] = []
    for r in cur.fetchall():
        imp_id = int(r[1])
        qty_raw = r[5]
        qty = float(qty_raw) if qty_raw is not None else None
        out.append(
            _missing_row_payload(
                conn,
                line_id=int(r[0]),
                import_id=imp_id,
                row_index=int(r[2]),
                week_key=str(r[8]),
                customer_code=str(r[3]),
                product_code=str(r[4]),
                quantity=qty,
                amount=float(r[6]),
                ship_date=str(r[7]),
                peer_by_product=peers,
                peer_by_customer_material=peers_cm,
                hist_cm_cache=hist_cm_cache,
            )
        )
    return out


def missing_unit_prices_csv_text(
    conn: sqlite3.Connection,
    *,
    month_key: Optional[str] = None,
    week_key: Optional[str] = None,
) -> tuple[str, str]:
    """UTF-8（BOM なし）の CSV 本文と推奨ファイル名を返す。month / week のどちらか一方のみ。"""
    if month_key is not None and week_key is not None:
        raise ValueError("month_key と week_key は同時に指定できません")
    if month_key is None and week_key is None:
        raise ValueError("month_key と week_key のどちらか一方を指定してください")

    if month_key is not None:
        rows = missing_unit_price_rows_for_month_export(conn, month_key)
        fname = f"missing_unit_prices_{month_key}.csv"
    else:
        rows = missing_unit_price_rows_for_week_export(conn, week_key)
        fname = f"missing_unit_prices_{week_key}.csv"

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "line_id",
            "week_key",
            "import_id",
            "csv_row_estimate",
            "customer_code",
            "product_code",
            "material_key",
            "quantity",
            "amount",
            "ship_date",
            "historical_unit_price",
            "historical_ref_ship_date",
            "hist_same_customer_material_unit_price",
            "hist_same_customer_material_ref_ship_date",
            "peer_avg_same_customer_material_unit_price",
            "peer_avg_same_product_unit_price",
            "implied_amount_div_qty",
            "recommended_unit_price",
        ]
    )
    for r in rows:
        w.writerow(
            [
                r["line_id"],
                r["week_key"],
                r["import_id"],
                int(r["row_index"]) + 2,
                r["customer_code"],
                r["product_code"],
                r["material_key"] or "",
                r["quantity"] if r["quantity"] is not None else "",
                r["amount"],
                r["ship_date"],
                r["suggested_unit_price"] if r["suggested_unit_price"] is not None else "",
                r["suggested_from_ship_date"] or "",
                r["same_customer_material_hist_unit_price"]
                if r["same_customer_material_hist_unit_price"] is not None
                else "",
                r["same_customer_material_hist_ship_date"] or "",
                r["peer_avg_customer_material_unit_price"]
                if r["peer_avg_customer_material_unit_price"] is not None
                else "",
                r["peer_avg_unit_price"] if r["peer_avg_unit_price"] is not None else "",
                r["implied_unit_price"] if r["implied_unit_price"] is not None else "",
                r["recommended_unit_price"] if r["recommended_unit_price"] is not None else "",
            ]
        )
    return buf.getvalue(), fname


def build_month_dashboard_payload(conn: sqlite3.Connection, month_key: str) -> dict[str, Any]:
    parse_month_key(month_key)
    agg = aggregate_lines_for_month(conn, month_key)
    if agg["line_count"] == 0:
        return {"error": "not_found", "message": f"month={month_key!r} の明細がありません"}

    daily = daily_amounts_for_month(conn, month_key)
    missing_preview: list[dict[str, Any]] = (
        missing_unit_price_preview_for_month(conn, month_key)
        if int(agg["missing_unit_price_rows"]) > 0
        else []
    )
    period_ja = period_ja_for_month(month_key)

    prev_m = prev_month_key(month_key)
    prev_agg = aggregate_lines_for_month(conn, prev_m)
    prev_has_data = int(prev_agg["line_count"]) > 0
    wow_prev_amount_zero = float(prev_agg["total_amount"]) == 0.0
    wow_prev_lines_zero = int(prev_agg["line_count"]) == 0
    wow_total_pct: Optional[float] = None
    wow_lines_pct: Optional[float] = None
    if prev_has_data:
        wow_total_pct = pct_change(prev_agg["total_amount"], agg["total_amount"])
        wow_lines_pct = pct_change(float(prev_agg["line_count"]), float(agg["line_count"]))

    yoy_mk = prev_year_same_calendar_month_key(month_key)
    yoy_agg = aggregate_lines_for_month(conn, yoy_mk)
    yoy_has_data = int(yoy_agg["line_count"]) > 0
    yoy_amount_zero = float(yoy_agg["total_amount"]) == 0.0
    yoy_lines_zero = int(yoy_agg["line_count"]) == 0
    yoy_total_pct: Optional[float] = None
    yoy_lines_pct: Optional[float] = None
    if yoy_has_data:
        yoy_total_pct = pct_change(yoy_agg["total_amount"], agg["total_amount"])
        yoy_lines_pct = pct_change(float(yoy_agg["line_count"]), float(agg["line_count"]))

    meta = {
        "id": None,
        "week_key": month_key,
        "run_id": "",
        "source_path": "（月次: ship_date が属する月の全明細を合算）",
        "created_at": "",
    }

    channel_breakdown = channel_breakdown_for_month(conn, month_key)
    top_customers = top_customers_for_month(conn, month_key)
    top_products = top_products_for_month(conn, month_key)

    cust_codes = [c["customer_code"] for c in top_customers]
    prod_codes = [p["product_code"] for p in top_products]
    history_months = build_recent_month_keys(month_key, 8)
    cust_hist = monthly_history_amounts_for_customers(conn, cust_codes, month_key, 8)
    prod_hist = monthly_history_amounts_for_products(conn, prod_codes, month_key, 8)
    for c in top_customers:
        c["history"] = cust_hist.get(c["customer_code"], [])
    for p in top_products:
        p["history"] = prod_hist.get(p["product_code"], [])

    weekly_in_month = weekly_amounts_in_month(conn, month_key)
    matrix_m = transaction_matrix_for_month(conn, month_key)
    ytd_m = ytd_metrics(conn, reference_date_str=str(agg["max_ship_date"] or ""))

    return {
        "view_mode": "month",
        "history_period_keys": history_months,
        "weekly_in_month": weekly_in_month,
        "transaction_matrix": matrix_m,
        "ytd": ytd_m,
        "month_key": month_key,
        "week_key": month_key,
        "period_ja": period_ja,
        "import": meta,
        "metrics": {
            "total_amount": agg["total_amount"],
            "line_count": agg["line_count"],
            "sum_quantity": agg.get("sum_quantity", 0.0),
            "distinct_customers": agg["distinct_customers"],
            "missing_unit_price_rows": agg["missing_unit_price_rows"],
            "missing_unit_price_preview_limit": MISSING_UNIT_PRICE_PREVIEW_LIMIT,
            "avg_amount_per_line": round(agg["avg_amount_per_line"], 2),
            "avg_unit_price_weighted": (
                round(agg["avg_unit_price_weighted"], 2)
                if agg["avg_unit_price_weighted"] is not None
                else None
            ),
        },
        "week_over_week": {
            "prev_week_key": prev_m,
            "prev_has_import": prev_has_data,
            "prev_amount_zero": wow_prev_amount_zero,
            "prev_lines_zero": wow_prev_lines_zero,
            "total_amount_pct": wow_total_pct,
            "line_count_pct": wow_lines_pct,
        },
        "year_over_year": {
            "prev_year_week_key": yoy_mk,
            "has_import": yoy_has_data,
            "amount_zero": yoy_amount_zero,
            "lines_zero": yoy_lines_zero,
            "total_amount_pct": yoy_total_pct,
            "line_count_pct": yoy_lines_pct,
        },
        "daily": daily,
        "missing_unit_price_preview": missing_preview,
        "weekly_summary": None,
        "channel_breakdown": channel_breakdown,
        "top_customers": top_customers,
        "top_products": top_products,
    }


def build_recent_week_keys(end_week_key: str, num_weeks: int) -> list[str]:
    """end_week_key を含めて過去 num_weeks 個の週キーを古い順で返す。"""
    parse_week_key(end_week_key)
    keys = [end_week_key]
    cur = end_week_key
    for _ in range(num_weeks - 1):
        cur = prev_week_key(cur)
        keys.append(cur)
    return list(reversed(keys))


def build_recent_month_keys(end_month_key: str, num_months: int) -> list[str]:
    """end_month_key を含めて過去 num_months 個の月キーを古い順で返す。"""
    parse_month_key(end_month_key)
    keys = [end_month_key]
    cur = end_month_key
    for _ in range(num_months - 1):
        cur = prev_month_key(cur)
        keys.append(cur)
    return list(reversed(keys))


def _latest_import_ids_for_weeks(
    conn: sqlite3.Connection, week_keys: list[str]
) -> dict[str, int]:
    """各週キーの「最新インポート（top_customers_for_import が見る基準）」を返す。"""
    if not week_keys:
        return {}
    out: dict[str, int] = {}
    for wk in week_keys:
        imp_id = latest_import_id_for_week(conn, wk)
        if imp_id is not None:
            out[wk] = int(imp_id)
    return out


def weekly_history_amounts_for_customers(
    conn: sqlite3.Connection,
    customer_codes: list[str],
    end_week_key: str,
    num_weeks: int = 8,
) -> dict[str, list[float]]:
    """各得意先の過去 num_weeks 週分の売上計（各週「最新インポート」基準）を古い順に返す。"""
    if not customer_codes:
        return {}
    weeks = build_recent_week_keys(end_week_key, num_weeks)
    latest = _latest_import_ids_for_weeks(conn, weeks)
    out: dict[str, list[float]] = {c: [0.0] * len(weeks) for c in customer_codes}
    if not latest:
        return out
    ph_codes = ",".join(["?"] * len(customer_codes))
    import_ids = list(latest.values())
    ph_imp = ",".join(["?"] * len(import_ids))
    cur = conn.execute(
        f"""
        SELECT i.week_key, l.customer_code, SUM(l.amount) AS amt
        FROM lines l
        INNER JOIN imports i ON l.import_id = i.id
        WHERE l.customer_code IN ({ph_codes}) AND l.import_id IN ({ph_imp})
        GROUP BY i.week_key, l.customer_code
        """,
        list(customer_codes) + import_ids,
    )
    week_idx = {w: i for i, w in enumerate(weeks)}
    for r in cur.fetchall():
        wk, cc, amt = str(r[0]), str(r[1]), float(r[2])
        if cc in out and wk in week_idx:
            out[cc][week_idx[wk]] = amt
    return out


def weekly_history_amounts_for_products(
    conn: sqlite3.Connection,
    product_codes: list[str],
    end_week_key: str,
    num_weeks: int = 8,
) -> dict[str, list[float]]:
    """各品目の過去 num_weeks 週分の売上計（各週「最新インポート」基準）を古い順に返す。"""
    if not product_codes:
        return {}
    weeks = build_recent_week_keys(end_week_key, num_weeks)
    latest = _latest_import_ids_for_weeks(conn, weeks)
    out: dict[str, list[float]] = {p: [0.0] * len(weeks) for p in product_codes}
    if not latest:
        return out
    ph_codes = ",".join(["?"] * len(product_codes))
    import_ids = list(latest.values())
    ph_imp = ",".join(["?"] * len(import_ids))
    cur = conn.execute(
        f"""
        SELECT i.week_key, l.product_code, SUM(l.amount) AS amt
        FROM lines l
        INNER JOIN imports i ON l.import_id = i.id
        WHERE l.product_code IN ({ph_codes}) AND l.import_id IN ({ph_imp})
        GROUP BY i.week_key, l.product_code
        """,
        list(product_codes) + import_ids,
    )
    week_idx = {w: i for i, w in enumerate(weeks)}
    for r in cur.fetchall():
        wk, pc, amt = str(r[0]), str(r[1]), float(r[2])
        if pc in out and wk in week_idx:
            out[pc][week_idx[wk]] = amt
    return out


def monthly_history_amounts_for_customers(
    conn: sqlite3.Connection,
    customer_codes: list[str],
    end_month_key: str,
    num_months: int = 8,
) -> dict[str, list[float]]:
    """各得意先の過去 num_months ヶ月の売上計を古い順に返す。出荷日基準の暦月集計。"""
    if not customer_codes:
        return {}
    months = build_recent_month_keys(end_month_key, num_months)
    ph_codes = ",".join(["?"] * len(customer_codes))
    ph_months = ",".join(["?"] * len(months))
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT {mk} AS ym, customer_code, SUM(amount) AS amt
        FROM lines
        WHERE customer_code IN ({ph_codes}) AND {mk} IN ({ph_months})
        GROUP BY ym, customer_code
        """,
        list(customer_codes) + months,
    )
    out: dict[str, list[float]] = {c: [0.0] * len(months) for c in customer_codes}
    month_idx = {m: i for i, m in enumerate(months)}
    for r in cur.fetchall():
        ym, cc, amt = str(r[0]), str(r[1]), float(r[2])
        if cc in out and ym in month_idx:
            out[cc][month_idx[ym]] = amt
    return out


def monthly_history_amounts_for_products(
    conn: sqlite3.Connection,
    product_codes: list[str],
    end_month_key: str,
    num_months: int = 8,
) -> dict[str, list[float]]:
    """各品目の過去 num_months ヶ月の売上計を古い順に返す。"""
    if not product_codes:
        return {}
    months = build_recent_month_keys(end_month_key, num_months)
    ph_codes = ",".join(["?"] * len(product_codes))
    ph_months = ",".join(["?"] * len(months))
    mk = _sql_calendar_month_key("ship_date")
    cur = conn.execute(
        f"""
        SELECT {mk} AS ym, product_code, SUM(amount) AS amt
        FROM lines
        WHERE product_code IN ({ph_codes}) AND {mk} IN ({ph_months})
        GROUP BY ym, product_code
        """,
        list(product_codes) + months,
    )
    out: dict[str, list[float]] = {p: [0.0] * len(months) for p in product_codes}
    month_idx = {m: i for i, m in enumerate(months)}
    for r in cur.fetchall():
        ym, pc, amt = str(r[0]), str(r[1]), float(r[2])
        if pc in out and ym in month_idx:
            out[pc][month_idx[ym]] = amt
    return out


def build_period_context(
    conn: sqlite3.Connection,
    *,
    period: str,
    month_from: Optional[str] = None,
    month_to: Optional[str] = None,
) -> dict[str, Any]:
    """
    AI質問BOX用の期間横断コンテキストを組み立てる。
    period: "all"（DBの全期間）/ "months"（month_from..month_to の月範囲）
    """
    n_norm = _sql_ship_date_normalized("ship_date")
    mk = _sql_calendar_month_key("ship_date")

    if period == "all":
        row = conn.execute(
            f"SELECT MIN({n_norm}), MAX({n_norm}) FROM lines WHERE {n_norm} != ''"
        ).fetchone()
        start_date = str(row[0]) if row and row[0] else ""
        end_date = str(row[1]) if row and row[1] else ""
        period_label = "全期間"
        where_clause = f"{n_norm} != ''"
        params: list = []
    elif period == "months":
        if not month_from or not month_to:
            raise ValueError("月範囲指定には month_from と month_to が必要です")
        parse_month_key(month_from)
        parse_month_key(month_to)
        if month_from > month_to:
            month_from, month_to = month_to, month_from
        from calendar import monthrange as _monthrange

        start_date = f"{month_from}-01"
        ey, em = month_to.split("-")
        last_d = _monthrange(int(ey), int(em))[1]
        end_date = f"{month_to}-{last_d:02d}"
        period_label = f"{month_from} 〜 {month_to}"
        where_clause = f"{mk} >= ? AND {mk} <= ?"
        params = [month_from, month_to]
    else:
        raise ValueError(f"未対応の period: {period}")

    # KPI
    row = conn.execute(
        f"""
        SELECT
            COUNT(*),
            COALESCE(SUM(amount), 0),
            SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END),
            COUNT(DISTINCT customer_code),
            COALESCE(SUM(quantity), 0)
        FROM lines
        WHERE {where_clause}
        """,
        params,
    ).fetchone()
    line_count = int(row[0] or 0)
    total = float(row[1] or 0.0)
    missing = int(row[2] or 0)
    distinct_cust = int(row[3] or 0)
    sum_qty = float(row[4]) if row[4] is not None else 0.0
    avg_per_line = (total / line_count) if line_count else 0.0
    avg_unit_weighted = (total / sum_qty) if sum_qty > 0 else None

    metrics = {
        "total_amount": total,
        "line_count": line_count,
        "sum_quantity": sum_qty,
        "distinct_customers": distinct_cust,
        "missing_unit_price_rows": missing,
        "avg_amount_per_line": round(avg_per_line, 2),
        "avg_unit_price_weighted": (
            round(avg_unit_weighted, 2) if avg_unit_weighted is not None else None
        ),
    }

    # Top10 顧客（数量も含む）
    cur = conn.execute(
        f"""
        SELECT customer_code, SUM(amount) AS amt, COUNT(*) AS n,
               COALESCE(SUM(quantity), 0) AS qty
        FROM lines
        WHERE {where_clause}
        GROUP BY customer_code
        ORDER BY amt DESC
        LIMIT 10
        """,
        params,
    )
    top_customers = [
        {
            "rank": i,
            "customer_code": str(r[0]),
            "total_amount": float(r[1]),
            "line_count": int(r[2]),
            "sum_quantity": float(r[3] or 0.0),
        }
        for i, r in enumerate(cur.fetchall(), start=1)
    ]

    # Top10 品目（数量も含む）
    cur = conn.execute(
        f"""
        SELECT product_code, SUM(amount) AS amt, COUNT(*) AS n,
               COALESCE(SUM(quantity), 0) AS qty
        FROM lines
        WHERE {where_clause}
        GROUP BY product_code
        ORDER BY amt DESC
        LIMIT 10
        """,
        params,
    )
    top_products = [
        {
            "rank": i,
            "product_code": str(r[0]),
            "total_amount": float(r[1]),
            "line_count": int(r[2]),
            "sum_quantity": float(r[3] or 0.0),
        }
        for i, r in enumerate(cur.fetchall(), start=1)
    ]

    # チャネル
    cur = conn.execute(
        f"""
        SELECT COALESCE(NULLIF(TRIM(channel), ''), '(未分類)') AS ch, SUM(amount) AS amt
        FROM lines
        WHERE {where_clause}
        GROUP BY COALESCE(NULLIF(TRIM(channel), ''), '(未分類)')
        ORDER BY amt DESC
        """,
        params,
    )
    chan_rows = [{"channel": str(r[0]), "amount": float(r[1])} for r in cur.fetchall()]
    chan_total = float(sum(b["amount"] for b in chan_rows))
    for b in chan_rows:
        b["pct"] = round(100.0 * b["amount"] / chan_total, 1) if chan_total > 0 else 0.0
    only_uncategorized = len(chan_rows) == 1 and chan_rows[0]["channel"] == "(未分類)"

    # 月次トレンド（期間内）
    cur = conn.execute(
        f"""
        SELECT {mk} AS ym, SUM(amount) AS amt, COUNT(*) AS n
        FROM lines
        WHERE {where_clause} AND {mk} IS NOT NULL
        GROUP BY ym
        ORDER BY ym
        LIMIT 36
        """,
        params,
    )
    monthly_trend = [
        {"month_key": str(r[0]), "amount": float(r[1]), "line_count": int(r[2])}
        for r in cur.fetchall()
    ]

    return {
        "view_mode": "period",
        "period_label": period_label,
        "period_start": start_date,
        "period_end": end_date,
        "metrics": metrics,
        "channel_breakdown": {
            "buckets": chan_rows,
            "total_amount": chan_total,
            "has_distinct_channels": not only_uncategorized,
        },
        "top_customers": top_customers,
        "top_products": top_products,
        "monthly_trend": monthly_trend,
    }


def search_entities(
    conn: sqlite3.Connection,
    query: str,
    limit: int = 12,
) -> dict[str, Any]:
    """得意先コード・品目キーから q を含むものを部分一致検索し、最新数週の合計でランク。"""
    q = (query or "").strip()
    if not q:
        return {"customers": [], "products": []}
    pat = f"%{q}%"
    cur_c = conn.execute(
        """
        SELECT customer_code, COALESCE(SUM(amount), 0) AS amt, COUNT(*) AS n
        FROM lines
        WHERE customer_code LIKE ?
        GROUP BY customer_code
        ORDER BY amt DESC
        LIMIT ?
        """,
        (pat, limit),
    )
    customers = [
        {"customer_code": str(r[0]), "total_amount": float(r[1]), "line_count": int(r[2])}
        for r in cur_c.fetchall()
    ]
    cur_p = conn.execute(
        """
        SELECT product_code, COALESCE(SUM(amount), 0) AS amt, COUNT(*) AS n
        FROM lines
        WHERE product_code LIKE ?
        GROUP BY product_code
        ORDER BY amt DESC
        LIMIT ?
        """,
        (pat, limit),
    )
    products = [
        {"product_code": str(r[0]), "total_amount": float(r[1]), "line_count": int(r[2])}
        for r in cur_p.fetchall()
    ]
    return {"query": q, "customers": customers, "products": products}


def entity_profile(
    conn: sqlite3.Connection,
    *,
    customer_code: Optional[str] = None,
    product_code: Optional[str] = None,
    history_weeks: int = 12,
) -> dict[str, Any]:
    """得意先または品目の全期間集計と直近N週の推移を返す。"""
    if (customer_code is None) == (product_code is None):
        raise ValueError("customer_code と product_code はどちらか一方を指定してください")

    if customer_code is not None:
        col = "customer_code"
        val = customer_code
        kind = "customer"
        agg_other = """
            SELECT product_code, SUM(amount) AS amt, COUNT(*) AS n
            FROM lines WHERE customer_code = ?
            GROUP BY product_code ORDER BY amt DESC LIMIT 10
        """
    else:
        col = "product_code"
        val = product_code
        kind = "product"
        agg_other = """
            SELECT customer_code, SUM(amount) AS amt, COUNT(*) AS n
            FROM lines WHERE product_code = ?
            GROUP BY customer_code ORDER BY amt DESC LIMIT 10
        """

    total_row = conn.execute(
        f"""
        SELECT COALESCE(SUM(amount),0), COUNT(*),
               MIN(ship_date), MAX(ship_date)
        FROM lines WHERE {col} = ?
        """,
        (val,),
    ).fetchone()
    related = [
        {"code": str(r[0]), "total_amount": float(r[1]), "line_count": int(r[2])}
        for r in conn.execute(agg_other, (val,)).fetchall()
    ]

    # 直近 history_weeks 週の amount 推移（最新インポート基準）
    week_row = conn.execute(
        f"""
        SELECT i.week_key
        FROM lines l INNER JOIN imports i ON l.import_id = i.id
        WHERE l.{col} = ?
        GROUP BY i.week_key
        ORDER BY i.week_key DESC
        LIMIT 1
        """,
        (val,),
    ).fetchone()
    history: list[dict[str, Any]] = []
    if week_row:
        latest_wk = str(week_row[0])
        weeks = build_recent_week_keys(latest_wk, history_weeks)
        latest_imp = _latest_import_ids_for_weeks(conn, weeks)
        if latest_imp:
            ph_imp = ",".join(["?"] * len(latest_imp))
            cur = conn.execute(
                f"""
                SELECT i.week_key, COALESCE(SUM(l.amount),0)
                FROM lines l INNER JOIN imports i ON l.import_id = i.id
                WHERE l.{col} = ? AND l.import_id IN ({ph_imp})
                GROUP BY i.week_key
                """,
                [val, *latest_imp.values()],
            )
            amt_map = {str(r[0]): float(r[1]) for r in cur.fetchall()}
            history = [{"week_key": w, "amount": amt_map.get(w, 0.0)} for w in weeks]

    return {
        "kind": kind,
        "code": val,
        "total_amount": float(total_row[0] or 0.0),
        "line_count": int(total_row[1] or 0),
        "first_ship_date": str(total_row[2]) if total_row[2] else None,
        "last_ship_date": str(total_row[3]) if total_row[3] else None,
        "top_related": related,
        "weekly_history": history,
    }


def list_recent_week_keys(conn: sqlite3.Connection, limit: int = 40) -> list[str]:
    cur = conn.execute(
        """
        SELECT week_key FROM imports
        GROUP BY week_key
        ORDER BY MAX(datetime(created_at)) DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [str(r[0]) for r in cur.fetchall()]


def build_dashboard_payload(conn: sqlite3.Connection, week_key: str) -> dict[str, Any]:
    parse_week_key(week_key)
    import_id = latest_import_id_for_week(conn, week_key)
    if import_id is None:
        return {"error": "not_found", "message": f"week_key={week_key!r} の取り込みがありません"}

    meta = import_meta(conn, import_id)
    agg = aggregate_for_import(conn, import_id)
    daily = daily_amounts_for_import(conn, import_id)
    missing_preview: list[dict[str, Any]] = (
        missing_unit_price_preview(conn, import_id, week_key)
        if int(agg["missing_unit_price_rows"]) > 0
        else []
    )
    period_ja = _period_ja_pretty(
        str(agg["min_ship_date"] or ""),
        str(agg["max_ship_date"] or ""),
    )

    prev_wk = prev_week_key(week_key)
    prev_id = latest_import_id_for_week(conn, prev_wk)
    wow_total_pct: Optional[float] = None
    wow_lines_pct: Optional[float] = None
    prev_has_import = prev_id is not None
    wow_prev_amount_zero = False
    wow_prev_lines_zero = False
    if prev_id is not None:
        prev_agg = aggregate_for_import(conn, prev_id)
        wow_prev_amount_zero = float(prev_agg["total_amount"]) == 0.0
        wow_prev_lines_zero = int(prev_agg["line_count"]) == 0
        wow_total_pct = pct_change(prev_agg["total_amount"], agg["total_amount"])
        wow_lines_pct = pct_change(float(prev_agg["line_count"]), float(agg["line_count"]))

    yoy_wk = prev_year_same_iso_week_key(week_key)
    yoy_total_pct: Optional[float] = None
    yoy_lines_pct: Optional[float] = None
    yoy_has_import = False
    yoy_amount_zero = False
    yoy_lines_zero = False
    if yoy_wk is not None:
        yoy_imp = latest_import_id_for_week(conn, yoy_wk)
        if yoy_imp is not None:
            yoy_has_import = True
            yoy_agg = aggregate_for_import(conn, yoy_imp)
            yoy_amount_zero = float(yoy_agg["total_amount"]) == 0.0
            yoy_lines_zero = int(yoy_agg["line_count"]) == 0
            yoy_total_pct = pct_change(yoy_agg["total_amount"], agg["total_amount"])
            yoy_lines_pct = pct_change(float(yoy_agg["line_count"]), float(agg["line_count"]))

    summary_row = db.fetch_report_summary_for_import(conn, import_id)
    weekly_summary: Optional[dict[str, str]] = None
    if summary_row is not None:
        weekly_summary = {
            "body": summary_row[0],
            "created_at": summary_row[1],
        }

    channel_breakdown = channel_breakdown_for_import(conn, import_id)
    top_customers = top_customers_for_import(conn, import_id)
    top_products = top_products_for_import(conn, import_id)

    cust_codes = [c["customer_code"] for c in top_customers]
    prod_codes = [p["product_code"] for p in top_products]
    history_weeks = build_recent_week_keys(week_key, 8)
    cust_hist = weekly_history_amounts_for_customers(conn, cust_codes, week_key, 8)
    prod_hist = weekly_history_amounts_for_products(conn, prod_codes, week_key, 8)
    for c in top_customers:
        c["history"] = cust_hist.get(c["customer_code"], [])
    for p in top_products:
        p["history"] = prod_hist.get(p["product_code"], [])

    matrix = transaction_matrix_for_import(conn, import_id)
    ytd = ytd_metrics(conn, reference_date_str=str(agg["max_ship_date"] or ""))

    return {
        "view_mode": "week",
        "history_period_keys": history_weeks,
        "transaction_matrix": matrix,
        "ytd": ytd,
        "month_key": None,
        "week_key": week_key,
        "period_ja": period_ja,
        "import": meta,
        "metrics": {
            "total_amount": agg["total_amount"],
            "line_count": agg["line_count"],
            "sum_quantity": agg.get("sum_quantity", 0.0),
            "distinct_customers": agg["distinct_customers"],
            "missing_unit_price_rows": agg["missing_unit_price_rows"],
            "missing_unit_price_preview_limit": MISSING_UNIT_PRICE_PREVIEW_LIMIT,
            "avg_amount_per_line": round(agg["avg_amount_per_line"], 2),
            "avg_unit_price_weighted": (
                round(agg["avg_unit_price_weighted"], 2)
                if agg["avg_unit_price_weighted"] is not None
                else None
            ),
        },
        "week_over_week": {
            "prev_week_key": prev_wk,
            "prev_has_import": prev_has_import,
            "prev_amount_zero": wow_prev_amount_zero,
            "prev_lines_zero": wow_prev_lines_zero,
            "total_amount_pct": wow_total_pct,
            "line_count_pct": wow_lines_pct,
        },
        "year_over_year": {
            "prev_year_week_key": yoy_wk,
            "has_import": yoy_has_import,
            "amount_zero": yoy_amount_zero,
            "lines_zero": yoy_lines_zero,
            "total_amount_pct": yoy_total_pct,
            "line_count_pct": yoy_lines_pct,
        },
        "daily": daily,
        "missing_unit_price_preview": missing_preview,
        "weekly_summary": weekly_summary,
        "channel_breakdown": channel_breakdown,
        "top_customers": top_customers,
        "top_products": top_products,
    }
