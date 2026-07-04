"""CSV/TSV をドラッグ＆ドロップで取り込む簡易ウィンドウ（手動取り込み用）。"""

from __future__ import annotations

import os
import subprocess
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext

from . import env_bootstrap


def _want_tkinterdnd2() -> bool:
    """
    macOS では Tcl/Tk と tkinterdnd2 の組み合わせでプロセスが abort することがあるため、
    既定はオフ。有効にする場合のみ SALES_REPORT_TKINTERDND2=1 を設定する。
    """
    raw = os.environ.get("SALES_REPORT_TKINTERDND2", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    if sys.platform == "darwin":
        return False
    return True


def _run_ingest(csv_path: Path, *, log: scrolledtext.ScrolledText) -> int:
    root_dir = env_bootstrap.project_root()
    cmd = [
        sys.executable,
        "-m",
        "sales_report_automation.simple_ingest",
        str(csv_path.resolve()),
    ]
    log.insert(tk.END, f"\n$ {' '.join(cmd)}\n")
    log.see(tk.END)
    log.update_idletasks()
    proc = subprocess.run(
        cmd,
        cwd=str(root_dir),
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.stdout:
        log.insert(tk.END, proc.stdout)
    if proc.stderr:
        log.insert(tk.END, proc.stderr)
    log.insert(
        tk.END,
        f"\n--- 終了コード {proc.returncode} ---\n",
    )
    log.see(tk.END)
    return int(proc.returncode)


def main() -> None:
    env_bootstrap.load_project_dotenv()
    root_dir = env_bootstrap.project_root()
    os.chdir(root_dir)

    TkinterDnD = None  # type: ignore[misc, assignment]
    DND_FILES = None  # type: ignore[misc, assignment]
    if _want_tkinterdnd2():
        try:
            from tkinterdnd2 import DND_FILES as _DND_FILES  # type: ignore[assignment]
            from tkinterdnd2 import TkinterDnD as _TkinterDnD  # type: ignore[assignment]

            DND_FILES = _DND_FILES
            TkinterDnD = _TkinterDnD
        except ImportError:
            TkinterDnD = None

    if TkinterDnD:
        root: tk.Tk = TkinterDnD.Tk()
    else:
        root = tk.Tk()

    root.title("週次売上 — ドラッグで取り込み")
    root.geometry("640x480")

    hint = (
        "ここに CSV / TSV ファイルをドロップしてください（週は auto）。\n"
        "※ ドロップできないときは下の「ファイルを選ぶ」を使ってください。"
    )
    if TkinterDnD is None and sys.platform == "darwin":
        hint = (
            "【Mac】ウィンドウへのドロップは安定性のため既定でオフです。"
            "「ファイルを選ぶ…」から CSV/TSV を選んでください。\n"
            "（上級者向け: 環境変数 SALES_REPORT_TKINTERDND2=1 でドロップを試せます）\n\n"
        ) + hint
    elif TkinterDnD is None:
        hint = (
            "この環境ではドロップ未対応です。"
            "「ファイルを選ぶ」ボタンを使うか、pip install tkinterdnd2 を実行してください。\n"
        ) + hint

    frm = tk.Frame(root, padx=12, pady=8)
    frm.pack(fill=tk.BOTH, expand=True)

    lbl = tk.Label(frm, text=hint, justify=tk.LEFT, wraplength=600)
    lbl.pack(anchor=tk.W)

    mono = ("Consolas", 10) if sys.platform == "win32" else ("Menlo", 11)
    log = scrolledtext.ScrolledText(frm, height=16, wrap=tk.WORD, font=mono)
    log.pack(fill=tk.BOTH, expand=True, pady=(8, 0))

    def run_path(p: Path) -> None:
        suf = p.suffix.lower()
        if suf not in {".csv", ".tsv", ".txt"}:
            messagebox.showwarning("拡張子", f"対応していない拡張子です: {suf}")
            return
        if not p.is_file():
            messagebox.showerror("エラー", f"ファイルがありません: {p}")
            return
        code = _run_ingest(p, log=log)
        if code != 0:
            messagebox.showerror("取り込み", f"失敗しました（終了コード {code}）。ログを確認してください。")
        else:
            messagebox.showinfo("取り込み", "完了しました（終了コード 0）。")

    def on_drop(event: tk.Event) -> None:  # type: ignore[name-defined]
        paths = event.widget.tk.splitlist(event.data)  # type: ignore[attr-defined]
        for s in paths:
            run_path(Path(s))

    if TkinterDnD is not None and DND_FILES is not None:
        lbl.drop_target_register(DND_FILES)  # type: ignore[attr-defined]
        lbl.dnd_bind("<<Drop>>", on_drop)  # type: ignore[attr-defined]

    def browse() -> None:
        p = filedialog.askopenfilename(
            title="取り込む CSV / TSV",
            filetypes=[
                ("表データ", "*.csv *.tsv *.txt"),
                ("すべて", "*.*"),
            ],
        )
        if p:
            run_path(Path(p))

    btn = tk.Button(frm, text="ファイルを選ぶ…", command=browse)
    btn.pack(anchor=tk.W, pady=(8, 0))

    tk.Button(frm, text="閉じる", command=root.destroy).pack(anchor=tk.E, pady=(8, 0))

    root.mainloop()


if __name__ == "__main__":
    main()
