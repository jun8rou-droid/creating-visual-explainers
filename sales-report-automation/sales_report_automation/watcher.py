"""受信フォルダ（inbox）を監視し、CSV/TSV が置かれたら取り込みを実行する。"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from threading import Lock, Timer
from typing import Optional, Set

from .pipeline import run

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
except ImportError as e:
    raise SystemExit(
        "watchdog パッケージが必要です: pip install watchdog"
    ) from e

# 受信直後はコピー中のことがあるため、拡張子のない一時名などは除外
_SUFFIX_OK = {".csv", ".tsv", ".txt"}


def _is_ready_file(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.name.startswith("."):
        return False
    if path.suffix.lower() not in _SUFFIX_OK:
        return False
    return True


def _wait_size_stable(path: Path, *, checks: int = 5, delay: float = 0.4) -> bool:
    """コピー完了待ち: ファイルサイズが短い間隔で変わらなければ読みにいく。"""
    last = -1
    stable = 0
    for _ in range(checks):
        if not path.is_file():
            return False
        sz = path.stat().st_size
        if sz == last and sz > 0:
            stable += 1
            if stable >= 2:
                return True
        else:
            stable = 0
        last = sz
        time.sleep(delay)
    return path.is_file() and path.stat().st_size > 0


class _InboxHandler(FileSystemEventHandler):
    def __init__(self, args: argparse.Namespace) -> None:
        self._args = args
        self._inbox: Path = args.inbox.resolve()
        self._processed: Path = (self._inbox / args.processed_subdir).resolve()
        self._failed: Path = (self._inbox / args.failed_subdir).resolve()
        self._lock = Lock()
        self._pending: dict[str, Timer] = {}
        self._seen: Set[str] = set()

    def on_created(self, event: object) -> None:  # noqa: ANN001
        if getattr(event, "is_directory", False):
            return
        path = Path(str(event.src_path))
        if not _is_ready_file(path):
            return
        if path.resolve().parent != self._inbox:
            return
        self._schedule(path)

    def on_modified(self, event: object) -> None:  # noqa: ANN001
        if getattr(event, "is_directory", False):
            return
        path = Path(str(event.src_path))
        if not _is_ready_file(path):
            return
        if path.resolve().parent != self._inbox:
            return
        self._schedule(path)

    def _schedule(self, path: Path) -> None:
        key = str(path.resolve())

        def fire() -> None:
            with self._lock:
                self._pending.pop(key, None)
            self._process(path)

        with self._lock:
            if key in self._seen:
                return
            t = self._pending.get(key)
            if t is not None:
                t.cancel()
            debounce = float(self._args.debounce_sec)
            tmr = Timer(debounce, fire)
            self._pending[key] = tmr
            tmr.start()

    def _process(self, path: Path) -> None:
        key = str(path.resolve())
        if key in self._seen:
            return
        if not _is_ready_file(path):
            return
        if not _wait_size_stable(path):
            print(f"[watch] スキップ（ファイルが安定しません）: {path}", file=sys.stderr)
            return

        with self._lock:
            if key in self._seen:
                return
            self._seen.add(key)

        self._processed.mkdir(parents=True, exist_ok=True)
        self._failed.mkdir(parents=True, exist_ok=True)

        rc = 1
        try:
            print(f"[watch] 取り込み開始: {path.name}", file=sys.stderr)
            argv = self._build_argv(path)
            try:
                rc = run(argv)
            except Exception as e:  # noqa: BLE001
                print(f"[watch] 内部エラー: {e}", file=sys.stderr)
                rc = 1

            if rc == 0:
                if self._args.no_move:
                    print(f"[watch] 成功（移動なし）: {path}", file=sys.stderr)
                else:
                    dest = self._unique_dest(self._processed, path.name)
                    try:
                        shutil.move(str(path), str(dest))
                        print(f"[watch] 成功 → {dest}", file=sys.stderr)
                    except OSError as e:
                        print(f"[watch] 成功だが移動失敗: {e}", file=sys.stderr)
            else:
                dest = self._unique_dest(self._failed, path.name)
                if not self._args.no_move:
                    try:
                        shutil.move(str(path), str(dest))
                        print(f"[watch] 失敗 (exit {rc}) → {dest}", file=sys.stderr)
                    except OSError as e:
                        print(f"[watch] 失敗し移動もできません: {e}", file=sys.stderr)
                else:
                    print(
                        f"[watch] 失敗 (exit {rc}): ファイルは {path} に残します",
                        file=sys.stderr,
                    )
        finally:
            with self._lock:
                self._seen.discard(key)

    def _unique_dest(self, folder: Path, name: str) -> Path:
        base = folder / name
        if not base.exists():
            return base
        stem = base.stem
        suf = base.suffix
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        return folder / f"{stem}_{ts}{suf}"

    def _build_argv(self, path: Path) -> list[str]:
        a: list[str] = [
            "--csv",
            str(path),
            "--week",
            self._args.week,
            "--db",
            str(self._args.db),
        ]
        if self._args.config is not None:
            a.extend(["--config", str(self._args.config)])
        if self._args.replace_week:
            a.append("--replace-week")
        if self._args.dry_run:
            a.append("--dry-run")
        if self._args.no_mail:
            a.append("--no-mail")
        if self._args.report_style_file is not None:
            a.extend(
                [
                    "--report-style-file",
                    str(self._args.report_style_file.resolve()),
                ]
            )
        return a


def watcher_main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="inbox フォルダに CSV/TSV が置かれたら、取り込みパイプラインを実行します。"
    )
    p.add_argument(
        "--inbox",
        type=Path,
        required=True,
        help="監視するフォルダ（ここに直接ファイルを置く。サブフォルダは見ません）",
    )
    p.add_argument(
        "--config",
        type=Path,
        default=None,
        help="列マッピング JSON（タブ区切りなら nissyo_tab_export.json 等）",
    )
    p.add_argument(
        "--db",
        type=Path,
        default=Path("data/report_store.sqlite"),
        help="SQLite のパス",
    )
    p.add_argument(
        "--week",
        default="auto",
        help='週キー。自動なら "auto"（行の ship_date から推定）',
    )
    p.add_argument(
        "--replace-week",
        action="store_true",
        help="同一 week 内の再取り込み時に上書きする",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Claude を呼ばない（テスト用）",
    )
    p.add_argument(
        "--no-mail",
        action="store_true",
        help="週次メール（環境変数で有効な場合）を送らない（Claude は呼ぶ・検証用）",
    )
    p.add_argument(
        "--report-style-file",
        type=Path,
        default=None,
        help="週次サマリー文案の追指示（UTF-8）。取り込みのたびに pipeline に渡す",
    )
    p.add_argument(
        "--debounce-sec",
        type=float,
        default=2.0,
        dest="debounce_sec",
        help="ファイル作成/更新から何秒待ってから読み始めるか（コピー完了用）",
    )
    p.add_argument(
        "--processed-subdir",
        default="processed",
        help="inbox 直下のこの子フォルダへ、成功したファイルを移す",
    )
    p.add_argument(
        "--failed-subdir",
        default="failed",
        help="inbox 直下のこの子フォルドへ、失敗したファイルを移す",
    )
    p.add_argument(
        "--no-move",
        action="store_true",
        help="成否にかかわらずファイルを移さない",
    )
    args = p.parse_args(argv)

    inbox = args.inbox.resolve()
    if not inbox.is_dir():
        print(f"inbox がありません: {inbox}", file=sys.stderr)
        return 1
    (inbox / args.processed_subdir).mkdir(parents=True, exist_ok=True)
    (inbox / args.failed_subdir).mkdir(parents=True, exist_ok=True)

    print(
        f"[watch] 監視中: {inbox}\n"
        f"  成功 → {args.processed_subdir}/\n"
        f"  失敗 → {args.failed_subdir}/\n"
        f"  Ctrl+C で停止",
        file=sys.stderr,
    )
    handler = _InboxHandler(args)
    observer = Observer()
    observer.schedule(handler, str(inbox), recursive=False)
    observer.start()
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\n[watch] 停止します", file=sys.stderr)
    observer.stop()
    observer.join(timeout=3.0)
    return 0


def main() -> None:
    raise SystemExit(watcher_main())


if __name__ == "__main__":
    main()
