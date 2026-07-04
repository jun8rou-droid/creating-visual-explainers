"""プロジェクト直下の .env を os.environ に取り込む（未設定のキーのみ）。"""

from __future__ import annotations

import os
from pathlib import Path


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_project_dotenv() -> None:
    """
    sales-report-automation/.env を読む。
    既に os.environ にあるキーは上書きしない（シェルで export した値を優先）。
    """
    path = project_root() / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if not key:
            continue
        if key not in os.environ:
            os.environ[key] = val
