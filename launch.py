"""QuantLab launcher — no venv needed.

Run with:  python launch.py        (or double-click launch.bat)
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"

# ---------- pretty printing ----------
RESET = "\033[0m"
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
DIM = "\033[2m"
BOLD = "\033[1m"

BANNER = r"""
   ____                    _   _          _
  / __ \                  | | | |        | |
 | |  | |_   _  __ _ _ __ | |_| |    __ _| |__
 | |  | | | | |/ _` | '_ \| __| |   / _` | '_ \
 | |__| | |_| | (_| | | | | |_| |__| (_| | |_) |
  \___\_\\__,_|\__,_|_| |_|\__|_____\__,_|_.__/

         backtest + live trading lab
"""


def banner():
    os.system("cls" if os.name == "nt" else "clear")
    print(CYAN + BANNER + RESET)
    print(DIM + f"  root: {ROOT}" + RESET)
    print()


def ok(msg):    print(GREEN + "  [OK] " + RESET + msg)
def info(msg):  print(CYAN  + "  [..] " + RESET + msg)
def warn(msg):  print(YELLOW+ "  [!!] " + RESET + msg)
def fail(msg):  print(RED   + "  [XX] " + RESET + msg)


def ask_yes_no(prompt, default=True):
    suffix = " [Y/n] " if default else " [y/N] "
    while True:
        ans = input(BOLD + "  ?> " + RESET + prompt + suffix).strip().lower()
        if not ans:
            return default
        if ans in ("y", "yes"):  return True
        if ans in ("n", "no"):   return False
        warn("please answer y or n")


def run(cmd, cwd=None, check=True):
    """Run a command, stream output, return exit code."""
    info(f"$ {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    try:
        result = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str))
    except FileNotFoundError as e:
        fail(f"command not found: {e}")
        return 127
    if check and result.returncode != 0:
        fail(f"command exited with code {result.returncode}")
    return result.returncode


# ---------- checks ----------
def check_python():
    info(f"python {sys.version.split()[0]} at {sys.executable}")
    if sys.version_info < (3, 10):
        warn("python 3.10+ recommended")


def check_node():
    npm = shutil.which("npm")
    node = shutil.which("node")
    if not node or not npm:
        fail("node/npm not found in PATH — install from https://nodejs.org")
        return False
    ok(f"node found at {node}")
    return True


# ---------- actions ----------
def install_backend():
    info("installing backend python dependencies (global, no venv)")
    code = run([sys.executable, "-m", "pip", "install", "-r",
                str(BACKEND / "requirements.txt")])
    if code == 0:
        ok("backend dependencies installed")
    else:
        fail("backend install failed — see error above")


def install_frontend():
    if not check_node():
        return
    info("installing frontend node dependencies")
    code = run(["npm", "install"], cwd=str(FRONTEND))
    if code == 0:
        ok("frontend dependencies installed")
    else:
        fail("npm install failed — see error above")


def run_backend():
    info("starting backend on http://localhost:5000  (ctrl+c to stop)")
    try:
        run([sys.executable, "app.py"], cwd=str(BACKEND), check=False)
    except KeyboardInterrupt:
        print()
        ok("backend stopped")


def run_frontend():
    if not check_node():
        return
    info("starting vite dev server  (ctrl+c to stop)")
    try:
        run(["npm", "run", "dev"], cwd=str(FRONTEND), check=False)
    except KeyboardInterrupt:
        print()
        ok("frontend stopped")


def run_both():
    if not check_node():
        return
    info("starting backend in a new window, then frontend here")
    if os.name == "nt":
        subprocess.Popen(
            ["cmd", "/c", "start", "cmd", "/k",
             f"{sys.executable} app.py"],
            cwd=str(BACKEND),
        )
    else:
        subprocess.Popen([sys.executable, "app.py"], cwd=str(BACKEND))
    ok("backend launched")
    run_frontend()


def fresh_setup():
    print()
    warn("this will install ALL backend + frontend dependencies")
    if not ask_yes_no("continue?", default=True):
        info("cancelled")
        return
    install_backend()
    print()
    install_frontend()
    print()
    ok("setup complete — pick option 3 or 4 to run")


# ---------- menu ----------
MENU = [
    ("Fresh setup (install everything)", fresh_setup),
    ("Install backend deps only",        install_backend),
    ("Install frontend deps only",       install_frontend),
    ("Run backend",                      run_backend),
    ("Run frontend",                     run_frontend),
    ("Run both (backend in new window)", run_both),
]


def menu():
    while True:
        banner()
        check_python()
        print()
        for i, (label, _) in enumerate(MENU, 1):
            print(f"   {BOLD}{i}{RESET}.  {label}")
        print(f"   {BOLD}0{RESET}.  Exit")
        print()
        choice = input(BOLD + "  >> " + RESET + "choose: ").strip()
        if choice == "0" or choice.lower() in ("q", "quit", "exit"):
            print()
            ok("bye")
            return
        if not choice.isdigit() or not (1 <= int(choice) <= len(MENU)):
            warn("invalid choice")
            input(DIM + "  press enter to continue..." + RESET)
            continue
        print()
        try:
            MENU[int(choice) - 1][1]()
        except Exception as e:
            fail(f"unhandled error: {type(e).__name__}: {e}")
        print()
        input(DIM + "  press enter to return to menu..." + RESET)


if __name__ == "__main__":
    if os.name == "nt":
        os.system("")  # enable ANSI colors on Windows
    try:
        menu()
    except KeyboardInterrupt:
        print()
        ok("bye")
