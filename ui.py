"""QuantLab — ui.py"""

import ctypes
import os
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path

import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk

# ── Hide console when launched with python.exe ─────────────────────────────
if sys.platform == "win32":
    _con = ctypes.windll.kernel32.GetConsoleWindow()
    if _con:
        ctypes.windll.user32.ShowWindow(_con, 0)

ROOT_DIR      = Path(__file__).resolve().parent
BACKEND_DIR   = ROOT_DIR / "backend"
FRONTEND_DIR  = ROOT_DIR / "frontend"
VPS_DIR       = ROOT_DIR / "vps-deployment"
BACKEND_PORT  = 6173
FRONTEND_PORT = 5173
PROJECT_PORTS = [BACKEND_PORT, FRONTEND_PORT]

# ── Palette ────────────────────────────────────────────────────────────────
C = {
    "bg":     "#0a0a0a",
    "bg1":    "#0e0e0e",
    "bg2":    "#131313",
    "bg3":    "#1a1a1a",
    "bg4":    "#222222",
    "border": "#2c2c2c",
    "text":   "#e2e2e2",
    "muted":  "#5a5a5a",
    "dim":    "#333333",
    "green":  "#22c55e",
    "red":    "#ef4444",
    "yellow": "#f59e0b",
    "blue":   "#3b82f6",
    "log_fg": "#8bbf8b",
    "sel":    "#1e3558",
    "title":  "#111111",
    "wbtn":   "#1e1e1e",
}


# ── OS helpers ─────────────────────────────────────────────────────────────

def _cflags():
    return subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def kill_pid_tree(pid: int):
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True, check=False, creationflags=_cflags(),
        )
    except Exception:
        pass


def pids_on_port(port: int) -> set:
    pids: set = set()
    try:
        out = subprocess.check_output(
            ["netstat", "-ano"], text=True, timeout=10, creationflags=_cflags(),
        )
        for line in out.splitlines():
            if f":{port} " in line or f":{port}\t" in line:
                parts = line.split()
                if parts and parts[-1].isdigit():
                    pids.add(int(parts[-1]))
    except Exception:
        pass
    return pids


def show_in_taskbar(win: tk.Tk):
    """Force a borderless (overrideredirect) Tk window to appear in the
    Windows taskbar. overrideredirect strips the window from the taskbar by
    default; re-adding the WS_EX_APPWINDOW ex-style (and clearing the
    tool-window flag) brings the desktop taskbar button back without
    restoring the native title bar."""
    if sys.platform != "win32":
        return
    GWL_EXSTYLE      = -20
    WS_EX_APPWINDOW  = 0x00040000
    WS_EX_TOOLWINDOW = 0x00000080
    try:
        hwnd = ctypes.windll.user32.GetParent(win.winfo_id())
        style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        style = (style & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW
        ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style)
        # re-map so the taskbar picks up the changed style
        win.withdraw()
        win.after(10, win.deiconify)
    except Exception:
        pass


def process_name(pid: int) -> str:
    try:
        out = subprocess.check_output(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            text=True, timeout=5, creationflags=_cflags(),
        )
        first = out.strip().splitlines()[0] if out.strip() else ""
        if first:
            return first.split(",")[0].strip('"')
    except Exception:
        pass
    return "?"


# ── Shared widget helpers ──────────────────────────────────────────────────

class LogPane(scrolledtext.ScrolledText):
    """Thread-safe timestamped log widget."""

    def __init__(self, parent, **kw):
        super().__init__(
            parent, state="disabled", wrap="word",
            font=("Consolas", 9), bg=C["bg"], fg=C["log_fg"],
            insertbackground=C["text"], relief="flat", bd=8, **kw,
        )
        self.tag_config("err",  foreground="#f97171")
        self.tag_config("warn", foreground="#fbbf24")
        self.tag_config("info", foreground="#60a5fa")
        self.tag_config("dim",  foreground=C["muted"])

    def write(self, text: str, tag: str = ""):
        self.after(0, self._write, text, tag)

    def _write(self, text: str, tag: str):
        ts = datetime.now().strftime("%H:%M:%S")
        self.config(state="normal")
        self.insert("end", f"[{ts}] {text}\n", tag)
        self.see("end")
        self.config(state="disabled")


def _flat_btn(parent, text, fg, cmd, fs=9):
    return tk.Button(
        parent, text=text, font=("Consolas", fs, "bold"),
        bg=C["bg4"], fg=fg,
        activebackground=C["border"], activeforeground=fg,
        relief="flat", bd=0, padx=11, pady=4,
        cursor="hand2", command=cmd,
    )


# ── Service card ───────────────────────────────────────────────────────────

class ServiceCard(tk.Frame):

    def __init__(self, parent, name: str, port: int, cmd: str, cwd: Path):
        super().__init__(parent, bg=C["bg3"], relief="flat", bd=0)
        self.name = name
        self.port = port
        self.cmd  = cmd
        self.cwd  = str(cwd)
        self._proc:   subprocess.Popen | None = None
        self._thread: threading.Thread | None = None
        self._lock    = threading.Lock()
        self._build_header()
        self.log = LogPane(self, height=12)
        self.log.pack(fill="both", expand=True, padx=2, pady=(0, 2))
        self._refresh_buttons(False)

    def _build_header(self):
        hdr = tk.Frame(self, bg=C["bg4"])
        hdr.pack(fill="x")
        left = tk.Frame(hdr, bg=C["bg4"])
        left.pack(side="left", padx=10, pady=8)
        self._dot = tk.Label(left, text="●", font=("Consolas", 10),
                             bg=C["bg4"], fg=C["red"])
        self._dot.pack(side="left")
        tk.Label(left, text=f"  {self.name}", font=("Consolas", 12, "bold"),
                 bg=C["bg4"], fg=C["text"]).pack(side="left")
        tk.Label(left, text=f"  ·  :{self.port}", font=("Consolas", 9),
                 bg=C["bg4"], fg=C["muted"]).pack(side="left")
        right = tk.Frame(hdr, bg=C["bg4"])
        right.pack(side="right", padx=10)
        self._btn_start   = _flat_btn(right, "Start",   C["green"],  self.start)
        self._btn_restart = _flat_btn(right, "Restart", C["yellow"], self.restart)
        self._btn_stop    = _flat_btn(right, "Stop",    C["red"],    self.stop)
        for b in (self._btn_start, self._btn_restart, self._btn_stop):
            b.pack(side="left", padx=3)

    def _refresh_buttons(self, running: bool):
        self._dot.config(fg=C["green"] if running else C["red"])
        if running:
            self._btn_start.config(state="disabled",  fg=C["dim"])
            self._btn_restart.config(state="normal",  fg=C["yellow"])
            self._btn_stop.config(state="normal",     fg=C["red"])
        else:
            self._btn_start.config(state="normal",    fg=C["green"])
            self._btn_restart.config(state="disabled", fg=C["dim"])
            self._btn_stop.config(state="disabled",   fg=C["dim"])

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self):
        with self._lock:
            if self.running or (self._thread and self._thread.is_alive()):
                return
            t = threading.Thread(target=self._run_loop, daemon=True)
            self._thread = t
            t.start()

    def stop(self):
        threading.Thread(target=self._kill, daemon=True).start()

    def restart(self):
        threading.Thread(target=self._restart_seq, daemon=True).start()

    def force_kill(self):
        if self._proc:
            kill_pid_tree(self._proc.pid)
            self._proc = None

    def _run_loop(self):
        self.log.write(f"Starting {self.name}…", "info")
        try:
            proc = subprocess.Popen(
                self.cmd, cwd=self.cwd, shell=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                bufsize=1, universal_newlines=True,
                creationflags=_cflags(),
            )
        except Exception as exc:
            self.log.write(f"Launch failed: {exc}", "err")
            return
        with self._lock:
            self._proc = proc
        self.log.write(f"{self.name} started  (PID {proc.pid})", "info")
        self.after(0, self._refresh_buttons, True)
        for line in proc.stdout:
            s = line.rstrip()
            if s:
                self.log.write(s)
        code = proc.wait()
        with self._lock:
            if self._proc is proc:
                self._proc = None
        self.log.write(f"{self.name} exited  (code {code})", "dim")
        self.after(0, self._refresh_buttons, False)

    def _kill(self, silent=False):
        proc = self._proc
        if proc:
            if not silent:
                self.log.write(f"Stopping {self.name}…", "warn")
            kill_pid_tree(proc.pid)
            if self._thread:
                self._thread.join(timeout=4)
        with self._lock:
            self._proc = None
        self.after(0, self._refresh_buttons, False)

    def _restart_seq(self):
        self._kill(silent=False)
        time.sleep(0.4)
        self._run_loop()


# ── Dependencies tab ───────────────────────────────────────────────────────

class DepsTab(tk.Frame):
    """Check and install backend (pip) and frontend (npm) dependencies."""

    # key imports that cover most of requirements.txt
    _BACKEND_CHECK = "import flask, ccxt, pandas, numpy, sklearn, scipy, optuna, anthropic"

    def __init__(self, parent):
        super().__init__(parent, bg=C["bg"])
        self._build()
        # auto-check on first show
        self.after(300, self.check_all)

    def _build(self):
        bar = tk.Frame(self, bg=C["bg3"])
        bar.pack(fill="x")
        tk.Label(bar, text="Dependencies", font=("Consolas", 11, "bold"),
                 bg=C["bg3"], fg=C["text"], padx=12, pady=8).pack(side="left")
        tk.Label(bar, text="  auto-checks on startup",
                 font=("Consolas", 8), bg=C["bg3"], fg=C["muted"]).pack(side="left")
        _flat_btn(bar, "↓  Install All", C["green"], self.install_all).pack(side="right", padx=4, pady=6)
        _flat_btn(bar, "⟳  Check All",  C["blue"],  self.check_all).pack(side="right", padx=4, pady=6)

        # ── Backend row ───────────────────────────────────────────────
        self._be = self._make_row(
            "Backend — Python packages",
            f"pip install -r requirements.txt  ({BACKEND_DIR / 'requirements.txt'})",
        )
        self._be.pack(fill="x", padx=8, pady=(10, 4))

        # ── Frontend row ──────────────────────────────────────────────
        self._fe = self._make_row(
            "Frontend — npm packages",
            f"npm install  ({FRONTEND_DIR})",
        )
        self._fe.pack(fill="x", padx=8, pady=(4, 10))

        # divider
        tk.Frame(self, bg=C["border"], height=1).pack(fill="x", padx=8, pady=(0, 6))

        tk.Label(self, text="  output", font=("Consolas", 8),
                 bg=C["bg"], fg=C["muted"]).pack(anchor="w", padx=8)
        self.log = LogPane(self, height=16)
        self.log.pack(fill="both", expand=True, padx=6, pady=(0, 8))

    def _make_row(self, title: str, hint: str) -> tk.Frame:
        row = tk.Frame(self, bg=C["bg3"])
        inner = tk.Frame(row, bg=C["bg4"])
        inner.pack(fill="x")

        dot = tk.Label(inner, text="●", font=("Consolas", 10),
                       bg=C["bg4"], fg=C["muted"], padx=12, pady=12)
        dot.pack(side="left")

        info = tk.Frame(inner, bg=C["bg4"])
        info.pack(side="left", fill="both", expand=True, pady=6)
        tk.Label(info, text=title, font=("Consolas", 10, "bold"),
                 bg=C["bg4"], fg=C["text"], anchor="w").pack(anchor="w")
        status_lbl = tk.Label(info, text="not checked",
                              font=("Consolas", 8), bg=C["bg4"],
                              fg=C["muted"], anchor="w")
        status_lbl.pack(anchor="w")
        tk.Label(info, text=hint, font=("Consolas", 7),
                 bg=C["bg4"], fg=C["dim"], anchor="w").pack(anchor="w")

        btn_frame = tk.Frame(inner, bg=C["bg4"])
        btn_frame.pack(side="right", padx=10)
        install_btn = _flat_btn(btn_frame, "Install", C["green"], lambda: None)
        install_btn.pack()

        row._dot        = dot
        row._status_lbl = status_lbl
        row._install_btn = install_btn
        return row

    # ── status helper ─────────────────────────────────────────────────

    _STATUS_MAP = {
        "checking":   (C["yellow"], "checking…"),
        "ok":         (C["green"],  "installed  ✓"),
        "missing":    (C["red"],    "missing — click Install"),
        "installing": (C["yellow"], "installing…"),
        "done":       (C["green"],  "installed  ✓"),
        "error":      (C["red"],    "install failed"),
    }

    def _set_status(self, row: tk.Frame, state: str):
        color, text = self._STATUS_MAP.get(state, (C["muted"], state))
        row._dot.config(fg=color)
        row._status_lbl.config(text=text, fg=color)

    # ── check ─────────────────────────────────────────────────────────

    def check_all(self):
        threading.Thread(target=self._check_backend,  daemon=True).start()
        threading.Thread(target=self._check_frontend, daemon=True).start()

    def _check_backend(self):
        self.after(0, self._set_status, self._be, "checking")
        self.log.write("Checking backend packages…", "info")
        try:
            r = subprocess.run(
                [sys.executable, "-c", self._BACKEND_CHECK],
                capture_output=True, text=True, timeout=60,
                creationflags=_cflags(),
            )
            if r.returncode == 0:
                self.after(0, self._set_status, self._be, "ok")
                self.log.write("Backend: all key packages present ✓", "info")
            else:
                self.after(0, self._set_status, self._be, "missing")
                msg = r.stderr.strip().splitlines()[0] if r.stderr.strip() else "unknown"
                self.log.write(f"Backend: missing — {msg}", "warn")
        except Exception as exc:
            self.after(0, self._set_status, self._be, "error")
            self.log.write(f"Backend check error: {exc}", "err")

    def _check_frontend(self):
        self.after(0, self._set_status, self._fe, "checking")
        self.log.write("Checking frontend node_modules…", "info")
        nm = FRONTEND_DIR / "node_modules"
        if nm.is_dir() and any(nm.iterdir()):
            self.after(0, self._set_status, self._fe, "ok")
            self.log.write("Frontend: node_modules found ✓", "info")
        else:
            self.after(0, self._set_status, self._fe, "missing")
            self.log.write("Frontend: node_modules missing — click Install", "warn")

    # ── install ───────────────────────────────────────────────────────

    def install_all(self):
        self._install_backend()
        self.after(500, self._install_frontend)

    def _install_backend(self):
        cmd = [sys.executable, "-m", "pip", "install", "-r",
               str(BACKEND_DIR / "requirements.txt")]
        threading.Thread(
            target=self._run_install,
            args=(self._be, cmd, str(BACKEND_DIR), self._check_backend),
            daemon=True,
        ).start()

    def _install_frontend(self):
        # npm is a .cmd shim on Windows, so it must run through cmd /c —
        # a bare ["npm", "install"] raises FileNotFoundError there.
        cmd = ["cmd", "/c", "npm", "install"] if sys.platform == "win32" else ["npm", "install"]
        threading.Thread(
            target=self._run_install,
            args=(self._fe, cmd, str(FRONTEND_DIR), self._check_frontend),
            daemon=True,
        ).start()

    def _run_install(self, row: tk.Frame, cmd: list, cwd: str, recheck):
        self.after(0, self._set_status, row, "installing")
        self.log.write(f"$ {' '.join(cmd)}", "info")
        try:
            proc = subprocess.Popen(
                cmd, cwd=cwd,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                bufsize=1, universal_newlines=True,
                creationflags=_cflags(),
            )
            for line in proc.stdout:
                s = line.rstrip()
                if s:
                    self.log.write(s)
            code = proc.wait()
            if code == 0:
                self.log.write("Install finished ✓", "info")
                recheck()
            else:
                self.after(0, self._set_status, row, "error")
                self.log.write(f"Install failed (exit {code})", "err")
        except Exception as exc:
            self.after(0, self._set_status, row, "error")
            self.log.write(f"Install error: {exc}", "err")

    def _wire_buttons(self):
        self._be._install_btn.config(command=self._install_backend)
        self._fe._install_btn.config(command=self._install_frontend)


# ── Netstat tab ────────────────────────────────────────────────────────────

class NetstatTab(tk.Frame):

    def __init__(self, parent):
        super().__init__(parent, bg=C["bg"])
        self._rows: list[dict] = []
        self._build()

    def _build(self):
        bar = tk.Frame(self, bg=C["bg3"])
        bar.pack(fill="x")
        tk.Label(bar, text="Port Monitor", font=("Consolas", 11, "bold"),
                 bg=C["bg3"], fg=C["text"], padx=12, pady=8).pack(side="left")
        tk.Label(bar,
                 text="  watching " + "  ".join(f":{p}" for p in PROJECT_PORTS),
                 font=("Consolas", 9), bg=C["bg3"], fg=C["muted"]).pack(side="left")
        for label, fg, cmd in [
            ("⟳  Refresh",        C["blue"], self.refresh),
            ("✕  Kill Selected",  C["red"],  self._kill_selected),
            ("✕  Kill All Ports", C["red"],  self._kill_all),
        ]:
            _flat_btn(bar, label, fg, cmd).pack(side="right", padx=4, pady=6)

        cols = tk.Frame(self, bg=C["bg4"])
        cols.pack(fill="x", padx=6, pady=(6, 0))
        for label, w in [("Port", 8), ("PID", 8), ("Process", 17),
                          ("State", 13), ("Address", 24)]:
            tk.Label(cols, text=label, font=("Consolas", 9, "bold"),
                     bg=C["bg4"], fg=C["muted"], width=w, anchor="w",
                     padx=6, pady=4).pack(side="left")

        lb_wrap = tk.Frame(self, bg=C["bg2"])
        lb_wrap.pack(fill="both", expand=True, padx=6, pady=(0, 4))
        sb = tk.Scrollbar(lb_wrap, orient="vertical", bg=C["bg3"],
                          troughcolor=C["bg2"], activebackground=C["border"])
        self._lb = tk.Listbox(
            lb_wrap, font=("Consolas", 10),
            bg=C["bg"], fg=C["text"],
            selectbackground=C["sel"], selectforeground=C["text"],
            relief="flat", bd=6, activestyle="none", height=10,
            yscrollcommand=sb.set,
        )
        sb.config(command=self._lb.yview)
        sb.pack(side="right", fill="y")
        self._lb.pack(side="left", fill="both", expand=True)

        tk.Label(self, text="  raw  netstat -ano  (matched lines)",
                 font=("Consolas", 8), bg=C["bg"], fg=C["muted"]).pack(anchor="w", padx=8)
        self._raw = scrolledtext.ScrolledText(
            self, height=8, font=("Consolas", 8),
            bg=C["bg"], fg=C["muted"], relief="flat", bd=6,
            wrap="none", state="disabled",
        )
        self._raw.pack(fill="x", padx=6, pady=(0, 8))

    def refresh(self):
        self._lb.delete(0, "end")
        self._rows.clear()
        try:
            raw_out = subprocess.check_output(
                ["netstat", "-ano"], text=True, timeout=10, creationflags=_cflags(),
            )
        except Exception as exc:
            self._lb.insert("end", f"  netstat error: {exc}")
            return

        matched_lines: list[str] = []
        seen: set = set()

        for line in raw_out.splitlines():
            for port in PROJECT_PORTS:
                if f":{port} " in line or f":{port}\t" in line:
                    matched_lines.append(line.rstrip())
                    parts = line.split()
                    if len(parts) < 4:
                        break
                    pid_str = parts[-1]
                    state   = parts[3] if len(parts) >= 5 else parts[2]
                    local   = parts[1]
                    key     = (pid_str, port)
                    if key not in seen:
                        seen.add(key)
                        self._rows.append({"pid": pid_str, "port": port,
                                           "state": state, "local": local})
                    break

        if not self._rows:
            self._lb.insert("end", "  No project ports in use")
            self._lb.itemconfig(0, fg=C["muted"])
        else:
            for r in self._rows:
                pname = process_name(int(r["pid"])) if r["pid"].isdigit() else "?"
                color = C["green"] if r["state"] == "LISTENING" else C["yellow"]
                row   = (f"  :{r['port']:<8}PID {r['pid']:<9}"
                         f"{pname:<19}{r['state']:<14}{r['local']}")
                self._lb.insert("end", row)
                self._lb.itemconfig("end", fg=color)

        self._raw.config(state="normal")
        self._raw.delete("1.0", "end")
        self._raw.insert("end", "\n".join(matched_lines) or "(no matches)")
        self._raw.config(state="disabled")

    def _kill_selected(self):
        sel = self._lb.curselection()
        if not sel:
            messagebox.showinfo("Kill", "Select a row first.")
            return
        idx = sel[0]
        if idx >= len(self._rows):
            return
        row = self._rows[idx]
        if not row["pid"].isdigit():
            return
        pid   = int(row["pid"])
        pname = process_name(pid)
        if messagebox.askyesno("Kill Process", f"Kill PID {pid}  ({pname})?",
                               icon="warning"):
            kill_pid_tree(pid)
            self.after(600, self.refresh)

    def _kill_all(self):
        if not messagebox.askyesno("Kill All Project Ports",
                                   f"Kill every process on {PROJECT_PORTS}?",
                                   icon="warning"):
            return
        killed: list[int] = []
        for port in PROJECT_PORTS:
            for pid in pids_on_port(port):
                kill_pid_tree(pid)
                killed.append(pid)
        messagebox.showinfo("Done",
                            f"Killed PIDs: {killed}" if killed else "Nothing found.")
        self.after(600, self.refresh)


# ── Build / Git / Deploy tab ────────────────────────────────────────────────

class BuildTab(tk.Frame):
    """One-shot project commands: venv, frontend build, git, deploy."""

    def __init__(self, parent):
        super().__init__(parent, bg=C["bg"])
        self._build()

    def _build(self):
        bar = tk.Frame(self, bg=C["bg3"])
        bar.pack(fill="x")
        tk.Label(bar, text="Build · Git · Deploy", font=("Consolas", 11, "bold"),
                 bg=C["bg3"], fg=C["text"], padx=12, pady=8).pack(side="left")
        tk.Label(bar, text="  one-shot commands — output below",
                 font=("Consolas", 8), bg=C["bg3"], fg=C["muted"]).pack(side="left")

        body = tk.Frame(self, bg=C["bg"])
        body.pack(fill="x", padx=8, pady=8)

        def group(title):
            lf = tk.LabelFrame(body, text=title, bg=C["bg"], fg=C["muted"],
                               font=("Consolas", 9), bd=1, relief="solid",
                               labelanchor="nw", padx=6, pady=6)
            lf.pack(side="left", fill="both", expand=True, padx=4)
            return lf

        g1 = group(" Build ")
        _flat_btn(g1, "Build Frontend (prod)", C["green"],
                  lambda: self._run("build frontend", "npm run build", FRONTEND_DIR)).pack(fill="x", pady=3)
        _flat_btn(g1, "Open data folder", C["text"], self._open_data).pack(fill="x", pady=3)
        tk.Label(g1, text="deps install globally — no venv",
                 font=("Consolas", 7), bg=C["bg"], fg=C["dim"]).pack(anchor="w", pady=(4, 0))

        g2 = group(" Git ")
        for label, cmd in [("status", "git status"), ("pull", "git pull"), ("push", "git push")]:
            _flat_btn(g2, f"git {label}", C["text"],
                      lambda c=cmd, l=label: self._run(f"git {l}", c, ROOT_DIR)).pack(fill="x", pady=3)

        g3 = group(" Deploy ")
        _flat_btn(g3, "Deploy to VPS", C["yellow"], self._deploy).pack(fill="x", pady=3)
        tk.Label(g3, text="runs vps-deployment/deploy.py", font=("Consolas", 7),
                 bg=C["bg"], fg=C["dim"]).pack(anchor="w", pady=(4, 0))

        g4 = group(" Data ")
        _flat_btn(g4, "Pull Futures (Databento)", C["blue"],
                  lambda: self._run("pull databento",
                                    f'"{sys.executable}" "{ROOT_DIR / "scripts" / "pull_databento.py"}"',
                                    ROOT_DIR)).pack(fill="x", pady=3)
        tk.Label(g4, text="ES/NQ/CL/GC 1h — needs DATABENTO_API_KEY in .env",
                 font=("Consolas", 7), bg=C["bg"], fg=C["dim"]).pack(anchor="w", pady=(4, 0))

        tk.Label(self, text="  output", font=("Consolas", 8),
                 bg=C["bg"], fg=C["muted"]).pack(anchor="w", padx=8)
        self.log = LogPane(self, height=16)
        self.log.pack(fill="both", expand=True, padx=6, pady=(0, 8))

    def _run(self, label, cmd, cwd):
        self.log.write(f"$ {cmd}", "info")

        def worker():
            try:
                proc = subprocess.Popen(
                    cmd, cwd=str(cwd), shell=True,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    bufsize=1, universal_newlines=True, creationflags=_cflags(),
                )
                for line in proc.stdout:
                    s = line.rstrip()
                    if s:
                        self.log.write(s)
                code = proc.wait()
                self.log.write(f"{label} finished (exit {code})",
                               "info" if code == 0 else "err")
            except Exception as exc:  # noqa: BLE001
                self.log.write(f"{label} error: {exc}", "err")

        threading.Thread(target=worker, daemon=True).start()

    def _deploy(self):
        script = VPS_DIR / "deploy.py"
        if not script.exists():
            self.log.write(f"deploy.py not found at {script}", "err")
            return
        self._run("deploy", f'"{sys.executable}" deploy.py', VPS_DIR)

    def _open_data(self):
        d = BACKEND_DIR / "data"
        d.mkdir(exist_ok=True)
        try:
            if sys.platform == "win32":
                os.startfile(str(d))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.run(["open", str(d)])
            else:
                subprocess.run(["xdg-open", str(d)])
        except Exception as exc:  # noqa: BLE001
            self.log.write(f"open data error: {exc}", "err")


# ── Custom title bar ───────────────────────────────────────────────────────

class TitleBar(tk.Frame):
    """Draggable borderless title bar."""

    def __init__(self, parent, app: "App"):
        super().__init__(parent, bg=C["title"], height=36)
        self.pack_propagate(False)
        self._app  = app
        self._drag_x = 0
        self._drag_y = 0

        left = tk.Frame(self, bg=C["title"])
        left.pack(side="left", padx=12, fill="y")
        tk.Label(left, text="◈", font=("Consolas", 11),
                 bg=C["title"], fg=C["blue"]).pack(side="left", pady=8)
        tk.Label(left, text="  QuantLab", font=("Consolas", 11, "bold"),
                 bg=C["title"], fg=C["text"]).pack(side="left")
        tk.Label(left, text="  Launcher", font=("Consolas", 11),
                 bg=C["title"], fg=C["muted"]).pack(side="left")

        right = tk.Frame(self, bg=C["title"])
        right.pack(side="right", padx=6, fill="y")
        tk.Label(right,
                 text=f"backend :{BACKEND_PORT}   frontend :{FRONTEND_PORT}",
                 font=("Consolas", 8), bg=C["title"], fg=C["dim"],
                 padx=12).pack(side="left", pady=10)

        # close button
        self._close_btn = tk.Label(
            right, text=" ✕ ", font=("Consolas", 11, "bold"),
            bg=C["title"], fg=C["muted"], cursor="hand2", padx=4,
        )
        self._close_btn.pack(side="right", fill="y")
        self._close_btn.bind("<Enter>",    lambda e: self._close_btn.config(bg="#5a1a1a", fg=C["red"]))
        self._close_btn.bind("<Leave>",    lambda e: self._close_btn.config(bg=C["title"], fg=C["muted"]))
        self._close_btn.bind("<Button-1>", lambda e: app._on_close())

        # minimize button
        self._min_btn = tk.Label(
            right, text=" ─ ", font=("Consolas", 11),
            bg=C["title"], fg=C["muted"], cursor="hand2", padx=4,
        )
        self._min_btn.pack(side="right", fill="y")
        self._min_btn.bind("<Enter>",    lambda e: self._min_btn.config(bg=C["bg4"], fg=C["text"]))
        self._min_btn.bind("<Leave>",    lambda e: self._min_btn.config(bg=C["title"], fg=C["muted"]))
        self._min_btn.bind("<Button-1>", lambda e: app._minimize())

        # drag bindings
        for w in (self, left):
            w.bind("<ButtonPress-1>", self._on_press)
            w.bind("<B1-Motion>",     self._on_drag)
        for child in left.winfo_children():
            child.bind("<ButtonPress-1>", self._on_press)
            child.bind("<B1-Motion>",     self._on_drag)

    def _on_press(self, e):
        self._drag_x = e.x_root - self._app.winfo_x()
        self._drag_y = e.y_root - self._app.winfo_y()

    def _on_drag(self, e):
        x = e.x_root - self._drag_x
        y = e.y_root - self._drag_y
        self._app.geometry(f"+{x}+{y}")


# ── Main window ────────────────────────────────────────────────────────────

class App(tk.Tk):

    def __init__(self):
        super().__init__()
        self.overrideredirect(True)
        self.geometry("980x860")
        self.minsize(780, 560)
        self.configure(bg=C["border"])
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._center()
        self._build()
        # borderless windows drop off the taskbar — force the button back
        self.after(10, lambda: show_in_taskbar(self))

    def _center(self):
        self.update_idletasks()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        w, h   = 980, 860
        self.geometry(f"{w}x{h}+{(sw-w)//2}+{(sh-h)//2}")

    def _minimize(self):
        """Minimize the borderless window.

        overrideredirect(True) strips the native minimize path, so the old
        approach toggled it off, iconify()'d, then rebound <Map> to flip it
        back. But overrideredirect(False) itself queues a spurious <Map> that
        fires the instant we return to the event loop — restoring the window
        immediately. That race is why minimize "bounced" straight back.

        On Windows, minimize the real top-level HWND via Win32 instead and
        leave overrideredirect intact: restoring from the taskbar button just
        un-minimizes (no title bar, no rebind, no bounce)."""
        if sys.platform == "win32":
            try:
                hwnd = ctypes.windll.user32.GetParent(self.winfo_id())
                ctypes.windll.user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
                return
            except Exception:
                pass
        # Non-Windows fallback: temporarily restore decorations to iconify.
        self.overrideredirect(False)
        self.iconify()
        self.bind("<Map>", self._on_restore)

    def _on_restore(self, _event):
        self.unbind("<Map>")
        self.overrideredirect(True)
        self.after(10, lambda: show_in_taskbar(self))

    def _build(self):
        outer = tk.Frame(self, bg=C["bg"], padx=1, pady=1)
        outer.pack(fill="both", expand=True)

        self._title_bar = TitleBar(outer, self)
        self._title_bar.pack(fill="x")
        tk.Frame(outer, bg=C["blue"], height=1).pack(fill="x")

        # action bar
        bar = tk.Frame(outer, bg=C["bg1"])
        bar.pack(fill="x")
        for label, fg, cmd in [
            ("▶  Start All",   C["green"],  self._start_all),
            ("■  Stop All",    C["red"],    self._stop_all),
            ("↺  Restart All", C["yellow"], self._restart_all),
        ]:
            tk.Button(
                bar, text=label, font=("Consolas", 10, "bold"),
                bg=C["bg3"], fg=fg,
                activebackground=C["bg4"], activeforeground=fg,
                relief="flat", bd=0, padx=16, pady=7, cursor="hand2",
                command=cmd,
            ).pack(side="left", padx=4, pady=6)

        tk.Frame(bar, bg=C["border"], width=1, height=28).pack(
            side="left", padx=8, fill="y", pady=4)

        tk.Button(
            bar, text="⚡  Netstat", font=("Consolas", 10, "bold"),
            bg=C["bg3"], fg=C["blue"],
            activebackground=C["bg4"], activeforeground=C["blue"],
            relief="flat", bd=0, padx=16, pady=7, cursor="hand2",
            command=self._open_netstat,
        ).pack(side="left", padx=4, pady=6)

        tk.Button(
            bar, text="⬡  Open App", font=("Consolas", 10, "bold"),
            bg=C["bg3"], fg=C["green"],
            activebackground=C["bg4"], activeforeground=C["green"],
            relief="flat", bd=0, padx=16, pady=7, cursor="hand2",
            command=self._open_browser,
        ).pack(side="left", padx=4, pady=6)

        # notebook
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Q.TNotebook",
                        background=C["bg"], borderwidth=0, tabmargins=[0, 0, 0, 0])
        style.configure("Q.TNotebook.Tab",
                        background=C["bg2"], foreground=C["muted"],
                        padding=[14, 6], font=("Consolas", 9), borderwidth=0)
        style.map("Q.TNotebook.Tab",
                  background=[("selected", C["bg3"])],
                  foreground=[("selected", C["text"])])
        style.layout("Q.TNotebook.Tab", [
            ("Notebook.tab", {"children": [
                ("Notebook.padding", {"children": [
                    ("Notebook.label", {"side": "top", "sticky": ""})
                ], "side": "top", "sticky": ""})
            ], "side": "top", "sticky": "nswe"})
        ])

        nb = ttk.Notebook(outer, style="Q.TNotebook")
        nb.pack(fill="both", expand=True, padx=0, pady=(2, 0))
        self._nb = nb

        # tab 0 — Services
        svc = tk.Frame(nb, bg=C["bg"])
        nb.add(svc, text="  Services  ")
        self.backend  = ServiceCard(svc, "Backend",  BACKEND_PORT,
                                    "python app.py", BACKEND_DIR)
        self.frontend = ServiceCard(svc, "Frontend", FRONTEND_PORT,
                                    "npm run dev",   FRONTEND_DIR)
        self.backend.pack(fill="both", expand=True, padx=6, pady=(6, 3))
        self.frontend.pack(fill="both", expand=True, padx=6, pady=(3, 6))

        # tab 1 — Dependencies
        self._deps = DepsTab(nb)
        self._deps._wire_buttons()
        nb.add(self._deps, text="  Dependencies  ")

        # tab 2 — Netstat
        self._netstat = NetstatTab(nb)
        nb.add(self._netstat, text="  Netstat  ")

        # tab 3 — Build / Git / Deploy
        self._build_tab = BuildTab(nb)
        nb.add(self._build_tab, text="  Build · Git · Deploy  ")

    # ── global commands ───────────────────────────────────────────────

    def _start_all(self):
        self.backend.start()
        self.after(300, self.frontend.start)

    def _stop_all(self):
        self.backend.stop()
        self.frontend.stop()

    def _restart_all(self):
        self.backend.restart()
        self.after(400, self.frontend.restart)

    def _open_netstat(self):
        self._nb.select(2)          # tab index shifted by deps tab
        self._netstat.refresh()

    def _open_browser(self):
        webbrowser.open(f"http://localhost:{FRONTEND_PORT}")

    def _on_close(self):
        alive = [c.name for c in (self.backend, self.frontend) if c.running]
        if alive:
            names = " & ".join(alive)
            if not messagebox.askyesno(
                "Exit",
                f"{names} {'is' if len(alive) == 1 else 'are'} still running.\n\n"
                "Kill all services and exit?",
                icon="warning",
            ):
                return
        self.backend.force_kill()
        self.frontend.force_kill()
        for port in PROJECT_PORTS:
            for pid in pids_on_port(port):
                kill_pid_tree(pid)
        self.destroy()


# ──────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    App().mainloop()
