"""JST の「月曜 08:00 〜 翌週月曜 08:00 未満」を 1 週とする週キー（YYYY-Www）。"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Iterable
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")


def parse_ship_date(s: str) -> date:
    raw = (s or "").strip()
    if not raw:
        raise ValueError("ship_date が空です")
    parts = raw.replace("/", "-").split("-")
    if len(parts) != 3:
        raise ValueError(f"ship_date の形式が不正です: {s!r}")
    y, m, d = (int(parts[0]), int(parts[1]), int(parts[2]))
    return date(y, m, d)


def _monday_midnight_jst(d: date) -> datetime:
    """d が属する ISO 週の月曜 00:00（JST、naive 成分は JST として解釈）。"""
    # weekday(): 月曜=0
    monday = d - timedelta(days=d.weekday())
    return datetime.combine(monday, time(0, 0), tzinfo=JST)


def business_week_start_jst(instant: datetime) -> datetime:
    """instant（タイムゾーン付き想定）を含む運用週の開始（月曜 08:00 JST）。"""
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=JST)
    else:
        instant = instant.astimezone(JST)
    d = instant.date()
    w0 = _monday_midnight_jst(d)
    this_start = w0 + timedelta(hours=8)
    if instant < this_start:
        return this_start - timedelta(weeks=1)
    return this_start


def week_key_for_instant(instant: datetime) -> str:
    start = business_week_start_jst(instant)
    iy, iw, _ = start.date().isocalendar()
    return f"{iy}-W{iw:02d}"


def jst_noon_on(ship_date: date) -> datetime:
    """出荷日のみの行を正午 JST の瞬間とみなす（日付のみの境界を曖昧にしない）。"""
    return datetime.combine(ship_date, time(12, 0), tzinfo=JST)


def infer_week_key_from_ship_dates(dates: Iterable[date]) -> str:
    dates_list = list(dates)
    if not dates_list:
        raise ValueError("ship_date が 1 件もありません（週を推定できません）")
    keys: set[str] = set()
    for d in dates_list:
        keys.add(week_key_for_instant(jst_noon_on(d)))
    if len(keys) > 1:
        ordered = ", ".join(sorted(keys))
        raise ValueError(
            "複数の運用週にまたがる ship_date です。"
            "パイプラインの --week auto では週ごとに自動分割して取り込みます。"
            "単一週だけを明示したい場合は --week で週キーを指定するか、CSV を週単位に分割してください。"
            f" 検出: {ordered}"
        )
    return next(iter(keys))


def split_rows_by_business_week(
    rows: list[dict[str, str]],
) -> list[tuple[str, list[dict[str, str]]]]:
    """各行の ship_date から運用週キーを求め、週ごとの行リストに分ける（週キー昇順）。"""
    buckets: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        d = parse_ship_date(row["ship_date"])
        wk = week_key_for_instant(jst_noon_on(d))
        buckets[wk].append(row)
    return sorted(buckets.items(), key=lambda x: x[0])
