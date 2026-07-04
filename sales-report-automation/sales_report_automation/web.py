"""週次ダッシュボード Web（FastAPI）。CLI で取り込んだ SQLite を参照する。"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import db, env_bootstrap
from .dashboard_data import (
    build_dashboard_payload,
    build_month_dashboard_payload,
    build_period_context,
    entity_profile,
    list_recent_month_keys,
    list_recent_week_keys,
    missing_unit_prices_csv_text,
    parse_month_key,
    parse_week_key,
    search_entities,
)

# uvicorn 直起動でも .env を読む（SALES_REPORT_DB / SALES_REPORT_DASHBOARD_URL 等）
env_bootstrap.load_project_dotenv()

app = FastAPI(title="週次売上ダッシュボード", version="0.1.0")

_STATIC = Path(__file__).resolve().parent / "static"


def _db_path() -> Path:
    return Path(os.environ.get("SALES_REPORT_DB", "data/report_store.sqlite")).resolve()


@app.get("/api/weeks")
def api_weeks() -> dict:
    path = _db_path()
    if not path.is_file():
        return {"week_keys": [], "db_path": str(path), "hint": "CLI で取り込むと週が表示されます"}
    conn = db.connect(str(path))
    try:
        db.init_db(conn)
        keys = list_recent_week_keys(conn)
    finally:
        conn.close()
    return {"week_keys": keys, "db_path": str(path)}


@app.get("/api/months")
def api_months() -> dict:
    path = _db_path()
    if not path.is_file():
        return {"month_keys": [], "db_path": str(path), "hint": "CLI で取り込むと月が表示されます"}
    conn = db.connect(str(path))
    try:
        db.init_db(conn)
        keys = list_recent_month_keys(conn)
    finally:
        conn.close()
    return {"month_keys": keys, "db_path": str(path)}


@app.get("/api/month_summary")
def api_month_summary(month: str = Query(..., description='YYYY-MM')):
    try:
        parse_month_key(month)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    path = _db_path()
    if not path.is_file():
        raise HTTPException(
            status_code=503,
            detail=f"DB がまだありません: {path}（先に CLI で取り込み）",
        )
    conn = db.connect(str(path))
    try:
        db.init_db(conn)
        payload = build_month_dashboard_payload(conn, month)
    finally:
        conn.close()
    if payload.get("error") == "not_found":
        raise HTTPException(status_code=404, detail=payload.get("message", "not found"))
    return payload


@app.get("/api/missing_unit_prices.csv")
def api_missing_unit_prices_csv(
    month: Optional[str] = Query(None, description="YYYY-MM（暦月・ship_date 基準）"),
    week: Optional[str] = Query(None, description='週キー（例 "2026-W14"、当週インポート横断）'),
):
    if (month is None) == (week is None):
        raise HTTPException(
            status_code=400,
            detail="month=YYYY-MM または week=YYYY-Www のどちらか一方を指定してください",
        )
    if month is not None:
        try:
            parse_month_key(month)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    if week is not None:
        try:
            parse_week_key(week)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    path = _db_path()
    if not path.is_file():
        raise HTTPException(
            status_code=503,
            detail=f"DB がまだありません: {path}（先に CLI で取り込み）",
        )
    conn = db.connect(str(path))
    try:
        db.init_db(conn)
        text, fname = missing_unit_prices_csv_text(
            conn, month_key=month, week_key=week
        )
    finally:
        conn.close()
    body = ("\ufeff" + text).encode("utf-8")
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.get("/api/summary")
def api_summary(week: str = Query(..., description='週キー（例: "2026-W14")')):
    try:
        parse_week_key(week)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    path = _db_path()
    if not path.is_file():
        raise HTTPException(
            status_code=503,
            detail=f"DB がまだありません: {path}（先に CLI で取り込み）",
        )
    conn = db.connect(str(path))
    try:
        db.init_db(conn)
        payload = build_dashboard_payload(conn, week)
    finally:
        conn.close()
    if payload.get("error") == "not_found":
        raise HTTPException(status_code=404, detail=payload.get("message", "not found"))
    return payload


@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1, max_length=80, description="部分一致検索")):
    path = _db_path()
    if not path.is_file():
        return {"customers": [], "products": [], "query": q}
    conn = db.connect(str(path))
    try:
        db.init_db(conn)
        return search_entities(conn, q)
    finally:
        conn.close()


@app.get("/api/profile")
def api_profile(
    customer: Optional[str] = Query(None),
    product: Optional[str] = Query(None),
):
    if (customer is None) == (product is None):
        raise HTTPException(
            status_code=400,
            detail="customer または product のどちらか一方を指定してください",
        )
    path = _db_path()
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"DB がありません: {path}")
    conn = db.connect(str(path))
    try:
        db.init_db(conn)
        return entity_profile(conn, customer_code=customer, product_code=product)
    finally:
        conn.close()


class AskRequest(BaseModel):
    question: str
    context: Optional[Dict[str, Any]] = None
    period: Optional[str] = None  # "current" | "all" | "months"
    month_from: Optional[str] = None  # YYYY-MM
    month_to: Optional[str] = None  # YYYY-MM


@app.post("/api/ask")
def api_ask(req: AskRequest) -> Dict[str, str]:
    """指定期間のデータをコンテキストにClaudeへ質問。数値はpayload内のものだけを使う制約付き。"""
    q = (req.question or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="質問が空です")
    if len(q) > 600:
        raise HTTPException(status_code=400, detail="質問は600文字以内で")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY が未設定のため質問BOXは使えません（.env を確認）",
        )
    try:
        import anthropic
    except ImportError as e:
        raise HTTPException(status_code=500, detail="anthropic パッケージが未インストールです") from e

    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    client = anthropic.Anthropic()

    # 期間指定がある場合はサーバー側でコンテキストを組み立てる
    period = (req.period or "current").lower()
    period_intro = "現在ダッシュボードで表示している期間のデータです"
    if period in ("all", "months"):
        path = _db_path()
        if not path.is_file():
            raise HTTPException(status_code=503, detail=f"DB がまだありません: {path}")
        conn = db.connect(str(path))
        try:
            db.init_db(conn)
            try:
                light = build_period_context(
                    conn,
                    period=period,
                    month_from=req.month_from,
                    month_to=req.month_to,
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
        finally:
            conn.close()
        period_intro = (
            "ユーザーが指定した期間「"
            + str(light.get("period_label", ""))
            + "」のデータです（DBから集計）"
        )
    else:
        # 現在表示中: フロントから受け取った payload を軽量化
        ctx = req.context or {}
        light = {
            "view_mode": ctx.get("view_mode"),
            "week_key": ctx.get("week_key"),
            "month_key": ctx.get("month_key"),
            "period_ja": ctx.get("period_ja"),
            "metrics": ctx.get("metrics"),
            "week_over_week": ctx.get("week_over_week"),
            "year_over_year": ctx.get("year_over_year"),
            "weekly_summary": ctx.get("weekly_summary"),
            "channel_breakdown": ctx.get("channel_breakdown"),
            "top_customers": ctx.get("top_customers"),
            "top_products": ctx.get("top_products"),
            "transaction_matrix": ctx.get("transaction_matrix"),
            "ytd": ctx.get("ytd"),
            "weekly_in_month": ctx.get("weekly_in_month"),
            "history_period_keys": ctx.get("history_period_keys"),
        }

    payload_json = json.dumps(light, ensure_ascii=False, indent=2, default=str)

    msg = client.messages.create(
        model=model,
        max_tokens=900,
        system=(
            "あなたは営業データの社内アシスタントです。"
            "数値は与えられた JSON のものだけを使い、推定や捏造はしません。"
            "JSON にない情報を聞かれたら、その旨を率直に伝えます。"
            "簡潔に、有能な部下が口頭で答えるトーンで日本語で返答してください。"
            "箇条書きより自然な文を優先します（必要なら短い箇条書き可）。"
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    period_intro
                    + ":\n```json\n"
                    + payload_json
                    + "\n```\n\n質問: "
                    + q
                ),
            }
        ],
    )
    parts: list = []
    for block in msg.content:
        if block.type == "text":
            parts.append(block.text)
    return {"answer": "\n".join(parts).strip()}


@app.get("/")
def index() -> FileResponse:
    index_path = _STATIC / "dashboard.html"
    if not index_path.is_file():
        raise HTTPException(status_code=500, detail="static/dashboard.html が見つかりません")
    return FileResponse(index_path, media_type="text/html; charset=utf-8")
