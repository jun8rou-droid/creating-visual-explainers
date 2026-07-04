from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from io import StringIO
from pathlib import Path
from typing import Any, Optional

from . import db
from . import notify_mail
from . import week_calendar
from .dashboard_data import (
    CustomerMaterialHistoryCache,
    extract_material_key,
    implied_unit_price,
    map_peer_avg_unit_price_by_customer_material_for_week,
    map_peer_avg_unit_price_by_product_for_week,
    pick_recommended_unit_price,
)

REQUIRED_COLUMNS = (
    "customer_code",
    "product_code",
    "quantity",
    "unit_price",
    "amount",
    "ship_date",
)


def _parse_float(val: str) -> Optional[float]:
    s = (val or "").strip()
    if s == "":
        return None
    return float(s)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_csv_text_auto_encoding(path: Path) -> str:
    """UTF-8（BOM 付き可）→ UTF-8 → CP932 の順でデコード（Excel 日本語 CSV 向け）。"""
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "cp932"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def load_csv(path: Path) -> list[dict[str, str]]:
    text = _read_csv_text_auto_encoding(path)
    reader = csv.reader(StringIO(text))
    try:
        raw_header = next(reader)
    except StopIteration:
        raise ValueError("CSV が空です")
    headers = [h.strip() for h in raw_header]
    missing = [c for c in REQUIRED_COLUMNS if c not in headers]
    if missing:
        raise ValueError(
            f"必須列がありません: {missing}. 必要: {list(REQUIRED_COLUMNS)}。"
            " 先頭行が日本語列名の CSV のときは、--config で config/nichisho_nissyo.json などのマッピング JSON を指定してください。"
        )
    col_index = {name: headers.index(name) for name in REQUIRED_COLUMNS}
    row_keys: list[str] = list(REQUIRED_COLUMNS)
    if "channel" in headers:
        col_index["channel"] = headers.index("channel")
        row_keys.append("channel")
    rows: list[dict[str, str]] = []
    for cells in reader:
        if not cells or all((c or "").strip() == "" for c in cells):
            continue
        row = {}
        for name in row_keys:
            j = col_index[name]
            row[name] = (cells[j] if j < len(cells) else "").strip()
        rows.append(row)
    return rows


def ingest_canonical(
    conn: sqlite3.Connection,
    week_key: str,
    run_id: str,
    rows: list[dict[str, str]],
    source_path: str,
    file_sha256: str,
    replace_week: bool,
) -> int:
    if replace_week:
        db.delete_imports_for_week(conn, week_key)

    import_id = db.insert_import(conn, week_key, run_id, source_path, file_sha256)

    for idx, row in enumerate(rows):
        qty = _parse_float(row["quantity"])
        unit_p = _parse_float(row["unit_price"])
        amt_raw = row.get("amount", "").strip()
        if not amt_raw:
            raise ValueError(f"{idx + 2} 行目: amount が空です")
        amount = float(amt_raw)
        ship = row["ship_date"]
        if not ship:
            raise ValueError(f"{idx + 2} 行目: ship_date が空です")
        ch_raw = (row.get("channel") or "").strip()
        db.insert_line(
            conn,
            import_id,
            idx,
            row["customer_code"],
            row["product_code"],
            qty,
            unit_p,
            amount,
            ship,
            ch_raw or None,
        )
    db.commit_lines(conn)
    return import_id


def aggregate_for_import(conn: sqlite3.Connection, import_id: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
            COUNT(*) AS line_count,
            COALESCE(SUM(amount), 0) AS total_amount,
            SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END) AS missing_unit_count
        FROM lines WHERE import_id = ?
        """,
        (import_id,),
    ).fetchone()
    return {
        "line_count": int(row[0]),
        "total_amount": float(row[1]),
        "missing_unit_count": int(row[2]),
    }


def unit_price_hints(
    conn: sqlite3.Connection, import_id: int
) -> list[dict[str, Any]]:
    wk_row = conn.execute(
        "SELECT week_key FROM imports WHERE id = ?", (import_id,)
    ).fetchone()
    if wk_row is None:
        return []
    week_key = str(wk_row[0])
    peers = map_peer_avg_unit_price_by_product_for_week(conn, week_key)
    peers_cm = map_peer_avg_unit_price_by_customer_material_for_week(conn, week_key)
    hist_cm_cache = CustomerMaterialHistoryCache(conn)
    cur = conn.execute(
        """
        SELECT row_index, customer_code, product_code, quantity, amount, ship_date
        FROM lines
        WHERE import_id = ? AND unit_price IS NULL
        ORDER BY row_index
        """,
        (import_id,),
    )
    hints: list[dict[str, Any]] = []
    for r in cur.fetchall():
        cust = str(r["customer_code"])
        prod = str(r["product_code"])
        hist = db.find_historical_unit_price(conn, cust, prod, import_id)
        hval = hist[0] if hist else None
        qty_raw = r["quantity"]
        qty = float(qty_raw) if qty_raw is not None else None
        peer = peers.get(prod)
        hist_cm = hist_cm_cache.lookup(cust, prod, import_id)
        hcm_val = hist_cm[0] if hist_cm else None
        hcm_sd = hist_cm[1] if hist_cm else None
        mat = extract_material_key(prod)
        peer_cm = peers_cm.get((cust, mat)) if mat else None
        impl = implied_unit_price(float(r["amount"]), qty)
        rec = pick_recommended_unit_price(hval, hcm_val, peer_cm, peer, impl)
        if hval is not None:
            reason = "historical_match"
        elif hcm_val is not None:
            reason = "historical_same_customer_material"
        elif peer_cm is not None:
            reason = "peer_avg_same_customer_material_same_week"
        elif peer is not None:
            reason = "peer_avg_same_week"
        elif impl is not None:
            reason = "implied_amount_div_qty"
        else:
            reason = "no_hint"
        hints.append(
            {
                "row_index": r["row_index"],
                "customer_code": cust,
                "product_code": prod,
                "quantity": qty,
                "amount": r["amount"],
                "ship_date": r["ship_date"],
                "suggested_unit_price": hval,
                "suggested_from_ship_date": hist[1] if hist else None,
                "same_customer_material_hist_unit_price": hcm_val,
                "same_customer_material_hist_ship_date": hcm_sd,
                "peer_avg_customer_material_unit_price": peer_cm,
                "peer_avg_unit_price": peer,
                "implied_unit_price": impl,
                "recommended_unit_price": rec,
                "reason": reason,
            }
        )
    return hints


def build_llm_payload(
    week_key: str,
    run_id: str,
    stats: dict[str, Any],
    hints: list[dict[str, Any]],
    report_style: Optional[str] = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "week_key": week_key,
        "run_id": run_id,
        "summary": {
            "line_count": stats["line_count"],
            "total_amount": round(stats["total_amount"], 2),
            "missing_unit_price_rows": stats["missing_unit_count"],
        },
        "unit_price_hints": hints,
        "instructions_for_model": (
            "数値はこの JSON の summary / unit_price_hints のみを引用すること。"
            "新しい合計や単価を捏造しないこと。"
        ),
    }
    rs = (report_style or "").strip()
    if rs:
        out["report_style_instructions"] = rs
    return out


def resolve_report_style(
    style_file: Optional[Path], style_cli: Optional[str]
) -> str:
    """週次サマリー文案の追指示。優先度: ファイル > CLI > 環境変数 SALES_REPORT_SUMMARY_STYLE。"""
    if style_file is not None:
        if not style_file.is_file():
            raise ValueError(f"レポート指示ファイルがありません: {style_file}")
        return style_file.read_text(encoding="utf-8").strip()
    if (style_cli or "").strip():
        return str(style_cli).strip()
    return (os.environ.get("SALES_REPORT_SUMMARY_STYLE") or "").strip()


def call_claude_report(payload: dict[str, Any], dry_run: bool) -> str:
    if dry_run:
        return json.dumps(
            {"dry_run": True, "payload": payload}, ensure_ascii=False, indent=2
        )

    try:
        import anthropic
    except ImportError as e:
        raise SystemExit("anthropic パッケージが必要です: pip install -r requirements.txt") from e

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("環境変数 ANTHROPIC_API_KEY を設定してください")

    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    client = anthropic.Anthropic()

    has_style = bool((payload.get("report_style_instructions") or "").strip())
    user_content = (
        "以下の JSON は週次売上の集計結果です。\n"
        "この内容をもとに週次サマリーを日本語で書いてください。\n"
        "文体は「有能な部下が上司に要点を口頭で報告する」イメージにしてください。"
        "テンプレに沿った機械的な列挙や棒読みの箇条書きは避け、自然な文の流れで読み手が一読で状況を掴めるようにします。"
        "長さはおおよそ 3〜8 文程度でよいです（内容に応じて調整）。\n"
        + (
            "JSON の report_style_instructions に、トーン・文量・構成・禁止事項などの追指示がある場合は"
            "それにも従ってください（数値の扱いは instructions_for_model を最優先）。\n"
            if has_style
            else ""
        )
        + "単価が欠けている行があれば、候補が付いていれば簡潔に触れてください。\n"
        "金額・件数などの数字は JSON の記載どおりに用い、新しい集計や推測で数値を足さないでください。\n\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )

    msg = client.messages.create(
        model=model,
        max_tokens=1400,
        system=(
            "あなたは社内で週次売上を上司に報告する、有能で信頼できる部下として文章を書きます。"
            "丁寧語だが、過度に堅い公文書調や接続詞の連発は避け、簡潔で人間味のある報告調にします。"
            "入力 JSON にある数値・事実のみを使い、合計の再計算や新しい数値の創作はしません。"
            "report_style_instructions があるときはそれも尊重しつつ、数値の正確さを最優先してください。"
        ),
        messages=[{"role": "user", "content": user_content}],
    )
    parts = []
    for block in msg.content:
        if block.type == "text":
            parts.append(block.text)
    return "\n".join(parts)


def run(argv: Optional[list[str]] = None) -> int:
    from . import env_bootstrap

    env_bootstrap.load_project_dotenv()
    parser = argparse.ArgumentParser(
        description="週次売上 CSV を取り込み、集計し、Claude で文案を生成します（MVP）。"
    )
    parser.add_argument("--csv", type=Path, required=True, help="取り込む CSV ファイル")
    parser.add_argument(
        "--week",
        required=True,
        help='週キー（例: "2026-W15"）または auto（単一週は ship_date から推定。複数週にまたがる CSV は週ごとに自動分割）',
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("data/report_store.sqlite"),
        help="SQLite のパス",
    )
    parser.add_argument(
        "--replace-week",
        action="store_true",
        help="同一 week_key の過去取り込みを削除してから取り込む",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Claude を呼ばず、渡すペイロードだけ JSON で標準出力",
    )
    parser.add_argument(
        "--no-mail",
        action="store_true",
        help="週次メール（環境変数で有効な場合）を送らない",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="列マッピング JSON（例: config/nichisho_nissyo.json）。指定時は顧客固有 CSV として変換",
    )
    parser.add_argument(
        "--report-style",
        default=None,
        help="週次サマリー文案の追指示（一文でも可）。複数行は --report-style-file か .env の SALES_REPORT_SUMMARY_STYLE",
    )
    parser.add_argument(
        "--report-style-file",
        type=Path,
        default=None,
        help="追指示を UTF-8 テキストから読む（--report-style より優先）",
    )
    args = parser.parse_args(argv)

    if not args.csv.is_file():
        print(f"ファイルがありません: {args.csv}", file=sys.stderr)
        return 1

    try:
        report_style = resolve_report_style(args.report_style_file, args.report_style)
    except ValueError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1

    args.db.parent.mkdir(parents=True, exist_ok=True)

    conn = db.connect(str(args.db))
    try:
        db.init_db(conn)
        if args.config is not None:
            if not args.config.is_file():
                print(f"設定ファイルがありません: {args.config}", file=sys.stderr)
                return 1
            from . import csv_mapping

            mapping_cfg = csv_mapping.load_mapping_config(args.config)
            rows = csv_mapping.load_mapped_csv(args.csv, mapping_cfg)
        else:
            rows = load_csv(args.csv)

        if not rows:
            print("エラー: 取り込むデータ行がありません", file=sys.stderr)
            return 1

        if args.week.strip().lower() == "auto":
            try:
                ship_dates = [
                    week_calendar.parse_ship_date(r["ship_date"]) for r in rows
                ]
            except ValueError as e:
                print(f"エラー: {e}", file=sys.stderr)
                return 1
            keys = {
                week_calendar.week_key_for_instant(week_calendar.jst_noon_on(d))
                for d in ship_dates
            }
            if len(keys) == 1:
                week_batches = [(next(iter(keys)), rows)]
            else:
                week_batches = week_calendar.split_rows_by_business_week(rows)
        else:
            week_batches = [(args.week.strip(), rows)]

        file_hash = _sha256_file(args.csv)
        if len(week_batches) > 1:
            print(
                f"週を自動分割: {len(week_batches)} 週ぶんを順に取り込みます。"
                "（週ごとに集計・Claude。メールも週ごと。不要なら --no-mail）",
                file=sys.stderr,
            )

        for week_key, batch_rows in week_batches:
            if len(week_batches) > 1:
                print(
                    f"\n----- {week_key} ({len(batch_rows)} 行) -----",
                    file=sys.stderr,
                )
            run_id = str(uuid.uuid4())
            import_id = ingest_canonical(
                conn,
                week_key,
                run_id,
                batch_rows,
                str(args.csv.resolve()),
                file_hash,
                replace_week=args.replace_week,
            )
            stats = aggregate_for_import(conn, import_id)
            hints = unit_price_hints(conn, import_id)
            payload = build_llm_payload(
                week_key, run_id, stats, hints, report_style=report_style or None
            )
            text = call_claude_report(payload, dry_run=args.dry_run)
            print(text)
            if not args.dry_run:
                db.insert_report_summary(conn, import_id, week_key, text)
            notify_mail.maybe_send_weekly_report_mail(
                conn,
                week_key,
                import_id,
                text,
                dry_run=args.dry_run,
                no_mail=args.no_mail,
            )
    except ValueError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    return 0


def main() -> None:
    raise SystemExit(run())
