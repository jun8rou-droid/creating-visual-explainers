"""顧客固有 CSV → 内部カノニカル列へのマッピング（JSON 設定）。"""

from __future__ import annotations

import csv
import json
from io import StringIO
from pathlib import Path
from typing import Any

_REQUIRED = (
    "customer_code",
    "product_code",
    "quantity",
    "unit_price",
    "amount",
    "ship_date",
)


def load_mapping_config(path: Path) -> dict[str, Any]:
    """JSON は UTF-8 想定だが、Windows 由来の CP932 保存にも対応する。"""
    suf = path.suffix.lower()
    if suf in (".csv", ".tsv"):
        raise ValueError(
            "マッピング用にデータファイル（CSV/TSV）が渡されています。"
            "取り込み手順では、1つ目のダイアログでデータの CSV、"
            "2つ目で config フォルダ内の .json（例: nichisho_nissyo.json）を選んでください。"
            "2つ目は英語ヘッダのみの CSV ならキャンセルで構いません。"
            f" 渡されたパス: {path}"
        )
    raw = path.read_bytes()
    if not raw.strip():
        raise ValueError(
            f"マッピング設定ファイルが空です（config フォルダの .json を選び直してください）: {path}"
        )
    last_json: json.JSONDecodeError | None = None
    for enc in ("utf-8-sig", "utf-8", "cp932"):
        try:
            text = raw.decode(enc)
        except UnicodeDecodeError:
            continue
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            last_json = e
            continue
        if not isinstance(data, dict) or "columns" not in data:
            raise ValueError(
                f"マッピング JSON に \"columns\" がありません（CSV を誤って選んでいないか確認）: {path}"
            )
        return data
    hint = (
        f"マッピング JSON を解析できません（JSON である config/*.json を選んでください）: {path}"
    )
    if last_json is not None:
        raise ValueError(hint) from last_json
    raise ValueError(hint)


def _normalize_ship_date(raw: str, config: dict[str, Any]) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if config.get("date_compact_yyyymmdd") and len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return s


def map_row_to_canonical(row: dict[str, str], config: dict[str, Any]) -> dict[str, str]:
    cmap: dict[str, Any] = config["columns"]
    delim = config.get("product_delimiter", "|")
    parts_keys: list[str] = cmap["product_code_parts"]
    parts = [(row.get(k) or "").strip() for k in parts_keys]
    product_code = delim.join(parts)

    cc = (row.get(cmap["customer_code"]) or "").strip()
    qty = (row.get(cmap["quantity"]) or "").strip()
    up = (row.get(cmap["unit_price"]) or "").strip()
    amt = (row.get(cmap["amount"]) or "").strip()
    ship = _normalize_ship_date(row.get(cmap["ship_date"], ""), config)

    ch = ""
    ch_src = cmap.get("channel")
    if isinstance(ch_src, str) and ch_src.strip():
        ch = (row.get(ch_src) or "").strip()

    return {
        "customer_code": cc,
        "product_code": product_code,
        "quantity": qty,
        "unit_price": up,
        "amount": amt,
        "ship_date": ship,
        "channel": ch,
    }


def _decode_csv_text(path: Path, config: dict[str, Any]) -> str:
    """
    設定の encoding を優先すると、Excel「CSV UTF-8」が CP932 先読みで落ちることがある。
    そのため utf-8 系を先に試し、続けて設定の主エンコーディングとフォールバックを試す。
    """
    raw = path.read_bytes()
    primary = config.get("encoding", "utf-8-sig")
    fallbacks = list(config.get("encoding_fallbacks") or ["cp932", "utf-8-sig", "utf-8"])
    order: list[str | None] = [
        "utf-8-sig",
        "utf-8",
        primary,
        "cp932",
        *fallbacks,
    ]
    tried: set[str] = set()
    for enc in order:
        if not enc or enc in tried:
            continue
        tried.add(enc)
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def load_mapped_csv(path: Path, config: dict[str, Any]) -> list[dict[str, str]]:
    cmap = config["columns"]
    required_src = (
        [cmap["ship_date"], cmap["customer_code"], cmap["quantity"]]
        + list(cmap["product_code_parts"])
        + [cmap["unit_price"], cmap["amount"]]
    )
    unique_src = list(dict.fromkeys(required_src))

    text = _decode_csv_text(path, config)
    delim_raw = config.get("delimiter", ",")
    if delim_raw in ("\\t", "tab", "\t"):
        delim = "\t"
    else:
        delim = str(delim_raw) if delim_raw else ","
    reader = csv.DictReader(StringIO(text), delimiter=delim)
    if reader.fieldnames is None:
        raise ValueError("CSV にヘッダがありません")
    headers = {h.strip() for h in reader.fieldnames}
    missing = [c for c in unique_src if c not in headers]
    if missing:
        raise ValueError(f"CSV に必要列がありません: {missing}")
    ch_src = cmap.get("channel")
    if isinstance(ch_src, str) and ch_src.strip() and ch_src.strip() not in headers:
        raise ValueError(
            f"マッピングに channel 列「{ch_src}」が指定されていますが、CSV のヘッダにありません。"
        )

    out: list[dict[str, str]] = []
    for i, row in enumerate(reader):
        raw = {k: (v if v is not None else "") for k, v in row.items()}
        if not any((v or "").strip() for v in raw.values()):
            continue
        canon = map_row_to_canonical(raw, config)
        for req in _REQUIRED:
            if req not in canon:
                raise ValueError(f"内部列 {req} の生成に失敗しました（{i+2}行付近）")
        out.append(canon)
    return out
