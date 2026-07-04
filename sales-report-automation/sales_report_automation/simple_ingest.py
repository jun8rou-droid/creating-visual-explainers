"""手動取り込みの短縮コマンド（--week auto 既定・パスだけで実行しやすくする）。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import env_bootstrap
from .pipeline import run


def main() -> None:
    env_bootstrap.load_project_dotenv()
    p = argparse.ArgumentParser(
        description=(
            "週次 CSV/TSV を取り込む短縮コマンド。"
            "既定で --week auto。フルオプションは python -m sales_report_automation を参照。"
        )
    )
    p.add_argument(
        "csv",
        type=Path,
        help="取り込むファイル（ドラッグ＆ドロップでパスを貼ってもよい）",
    )
    p.add_argument(
        "config",
        nargs="?",
        type=Path,
        default=None,
        help="任意: 列マッピング JSON（例: config/nissyo_tab_export.json）",
    )
    p.add_argument(
        "--week",
        default="auto",
        help='週キー。省略時は auto（出荷日から推定）。例: "2026-W14"',
    )
    p.add_argument(
        "--db",
        type=Path,
        default=None,
        help="SQLite のパス（省略時は data/report_store.sqlite）",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Claude・メールを使わずペイロード確認（取り込みは DB に行う）",
    )
    p.add_argument(
        "--replace-week",
        action="store_true",
        help="同一週の既存取り込みを消してから入れ直す",
    )
    p.add_argument(
        "--no-mail",
        action="store_true",
        help="週次メールを送らない",
    )
    p.add_argument(
        "--report-style",
        default=None,
        help="週次サマリー文案の追指示（短文）。長文は --report-style-file",
    )
    p.add_argument(
        "--report-style-file",
        type=Path,
        default=None,
        help="追指示を UTF-8 テキストから読む（.env の SALES_REPORT_SUMMARY_STYLE より優先）",
    )
    args = p.parse_args()

    if not args.csv.is_file():
        print(f"ファイルがありません: {args.csv}", file=sys.stderr)
        raise SystemExit(1)

    argv: list[str] = [
        "--csv",
        str(args.csv.resolve()),
        "--week",
        args.week.strip(),
    ]
    if args.config is not None:
        cfg_suf = args.config.suffix.lower()
        if cfg_suf in (".csv", ".tsv"):
            print(
                "エラー: マッピング設定に CSV/TSV が指定されています。"
                "2つ目の引数には config/*.json を渡し、データ CSV は1つ目だけにしてください。"
                f" ({args.config})",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if not args.config.is_file():
            print(f"設定ファイルがありません: {args.config}", file=sys.stderr)
            raise SystemExit(1)
        argv.extend(["--config", str(args.config.resolve())])
    if args.db is not None:
        argv.extend(["--db", str(args.db)])
    if args.dry_run:
        argv.append("--dry-run")
    if args.replace_week:
        argv.append("--replace-week")
    if args.no_mail:
        argv.append("--no-mail")
    if args.report_style_file is not None:
        argv.extend(
            ["--report-style-file", str(args.report_style_file.resolve())]
        )
    if args.report_style is not None and str(args.report_style).strip():
        argv.extend(["--report-style", str(args.report_style).strip()])

    raise SystemExit(run(argv))


if __name__ == "__main__":
    main()  # pragma: no cover
