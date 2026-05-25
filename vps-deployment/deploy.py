"""
deploy.py — push quant-laptop to the Windows VPS.

Steps:
  1. Build React frontend locally  (npm run build)
  2. Upload project files via SFTP  (skips data/, node_modules/, .git/, etc.)
  3. pip install -r requirements.txt  on the VPS
  4. Deploy nginx.conf -> C:/nginx-1.30.2/conf/nginx.conf  and reload
  5. Kill any running app.py, drop start_backend.bat, launch Flask

Usage:
  python vps-deployment/deploy.py            # full deploy
  python vps-deployment/deploy.py --skip-build  # skip npm build (reuse last dist/)
  python vps-deployment/deploy.py --backend-only  # only restart Flask
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import posixpath
import stat
import subprocess
import sys
import time

import paramiko

# ---------------------------------------------------------------------------
# Config — read from .env (commented block) or fall back to env vars
# ---------------------------------------------------------------------------

def _read_env_file(path: str) -> dict:
    vals = {}
    if not os.path.exists(path):
        return vals
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, _, v = line.partition("=")
                vals[k.strip()] = v.strip()
    return vals

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_env = _read_env_file(os.path.join(_ROOT, ".env"))

HOST        = _env.get("VPS_HOST", "66.94.111.129")
USER        = _env.get("VPS_USER", "Administrator")
PASS        = _env.get("VPS_PASS", "mn7l0Yrl481roatEIh5")
DEPLOY_PATH = _env.get("VPS_DEPLOY_PATH", "C:/quantlab")

NGINX_CONF_SRC  = os.path.join(_HERE, "nginx.conf")
NGINX_CONF_DST  = _env.get("VPS_NGINX_CONF", "C:/nginx-1.29.3/conf/nginx.conf")
NGINX_EXE       = _env.get("VPS_NGINX_EXE",  "C:/nginx-1.29.3/nginx.exe")

# Directories/patterns to skip when uploading
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist",          # will upload the freshly built one explicitly
    "external-data", # large raw CSVs — keep local only
}
SKIP_DATA_DIR = True   # don't overwrite backend/data/ on VPS (preserves downloaded parquets)

SKIP_PATTERNS = ["*.pyc", "*.pyo", "*.log", "*.tmp", ".DS_Store"]


def _connect() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"  Connecting to {USER}@{HOST}…", flush=True)
    client.connect(HOST, username=USER, password=PASS, timeout=30,
                   look_for_keys=False, allow_agent=False)
    print("  Connected.", flush=True)
    return client


def _run(client: paramiko.SSHClient, cmd: str, check=True, timeout=300) -> str:
    print(f"  > {cmd}", flush=True)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace").strip()
    err = stderr.read().decode(errors="replace").strip()
    if out:
        print(f"    {out}", flush=True)
    if err:
        print(f"    [stderr] {err}", flush=True)
    return out


def _should_skip(rel: str) -> bool:
    parts = rel.replace("\\", "/").split("/")
    # skip entire data dir
    if SKIP_DATA_DIR and len(parts) >= 2 and parts[0] == "backend" and parts[1] == "data":
        return True
    # skip named dirs
    for p in parts[:-1]:
        if p in SKIP_DIRS:
            return True
    # skip patterns on filename
    fname = parts[-1]
    for pat in SKIP_PATTERNS:
        if fnmatch.fnmatch(fname, pat):
            return True
    return False


def _sftp_mkdir(sftp: paramiko.SFTPClient, remote_dir: str):
    parts = remote_dir.replace("\\", "/").split("/")
    current = ""
    for part in parts:
        if not part:
            continue
        current = current + "/" + part if current else part
        try:
            sftp.stat(current)
        except FileNotFoundError:
            try:
                sftp.mkdir(current)
            except Exception:
                pass


def upload_tree(sftp: paramiko.SFTPClient, local_root: str, remote_root: str):
    uploaded = 0
    skipped  = 0
    for dirpath, dirnames, filenames in os.walk(local_root):
        # Prune skip dirs in-place so os.walk doesn't descend into them
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

        for fname in filenames:
            local_path = os.path.join(dirpath, fname)
            rel = os.path.relpath(local_path, local_root)

            if _should_skip(rel):
                skipped += 1
                continue

            remote_path = posixpath.join(remote_root, rel.replace("\\", "/"))
            remote_dir  = posixpath.dirname(remote_path)
            _sftp_mkdir(sftp, remote_dir)

            try:
                sftp.put(local_path, remote_path)
                uploaded += 1
                if uploaded % 50 == 0:
                    print(f"    … {uploaded} files uploaded", flush=True)
            except Exception as e:
                print(f"    [WARN] could not upload {rel}: {e}", flush=True)

    print(f"  Upload done: {uploaded} files uploaded, {skipped} skipped.", flush=True)


def upload_dist(sftp: paramiko.SFTPClient):
    dist_local  = os.path.join(_ROOT, "frontend", "dist")
    dist_remote = posixpath.join(DEPLOY_PATH, "frontend/dist")
    if not os.path.isdir(dist_local):
        print("  [ERROR] frontend/dist not found — run with npm build first.", flush=True)
        sys.exit(1)
    print(f"  Uploading frontend/dist -> {dist_remote}", flush=True)
    upload_tree(sftp, dist_local, dist_remote)


def step_build(args):
    if args.skip_build:
        print("[1/5] Skipping npm build (--skip-build).", flush=True)
        return
    print("[1/5] Building React frontend…", flush=True)
    frontend_dir = os.path.join(_ROOT, "frontend")
    result = subprocess.run(
        ["npm", "run", "build"],
        cwd=frontend_dir, shell=True,
        capture_output=False,
    )
    if result.returncode != 0:
        print("  [ERROR] npm build failed.", flush=True)
        sys.exit(1)
    print("  Build complete.", flush=True)


def step_upload(client, sftp, args):
    if args.backend_only:
        print("[2/5] Skipping file upload (--backend-only).", flush=True)
        return
    print(f"[2/5] Uploading project -> {DEPLOY_PATH}", flush=True)
    # Upload everything except data/ and dist/ (dist uploaded separately)
    upload_tree(sftp, _ROOT, DEPLOY_PATH)
    # Now upload the freshly built dist/
    upload_dist(sftp)


def step_pip(client, args):
    print("[3/5] Installing Python dependencies on VPS…", flush=True)
    _run(client, f"python -m pip install -r {DEPLOY_PATH}/backend/requirements.txt --quiet",
         timeout=900)  # 15 min — ccxt + pandas + scikit-learn are large


def step_nginx(client, sftp, args):
    if getattr(args, "skip_nginx", False):
        print("[4/5] Skipping nginx config upload (--skip-nginx).", flush=True)
        # Still reload so any manual conf edits take effect
        _run(client, f'"{NGINX_EXE}" -s reload', check=False)
        return
    print("[4/5] Deploying nginx config…", flush=True)
    sftp.put(NGINX_CONF_SRC, NGINX_CONF_DST)
    print(f"  Uploaded {NGINX_CONF_SRC} -> {NGINX_CONF_DST}", flush=True)
    # Try reload first; if nginx isn't running, start it
    out = _run(client, f'"{NGINX_EXE}" -s reload 2>&1 || "{NGINX_EXE}"', check=False)
    if "error" in out.lower() and "reload" in out.lower():
        print("  nginx reload failed — attempting fresh start…", flush=True)
        _run(client, f'"{NGINX_EXE}"', check=False)
    print("  nginx ready.", flush=True)


def step_backend(client, sftp):
    print("[5/5] (Re)starting Flask backend…", flush=True)
    # Kill any existing python app.py process
    _run(client, 'taskkill /F /FI "WINDOWTITLE eq app.py" /T 2>nul || '
                 'wmic process where "commandline like \'%app.py%\'" delete 2>nul || echo no-prior-process',
         check=False)
    time.sleep(1)

    # Upload the bat launcher
    bat_src = os.path.join(_HERE, "start_backend.bat")
    bat_dst = posixpath.join(DEPLOY_PATH, "start_backend.bat")
    sftp.put(bat_src, bat_dst)

    # Launch it detached via cmd /c start
    _run(client, f'cmd /c start "" /B "{DEPLOY_PATH.replace("/", chr(92))}\\start_backend.bat"')
    time.sleep(2)
    print("  Flask backend started. Log -> C:/quant-laptop/backend.log", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build",   action="store_true", help="Skip npm run build")
    parser.add_argument("--backend-only", action="store_true", help="Only restart Flask (no upload)")
    parser.add_argument("--skip-nginx",   action="store_true", help="Don't overwrite nginx.conf (reload only)")
    args = parser.parse_args()

    step_build(args)

    print("Connecting to VPS…", flush=True)
    client = _connect()
    sftp   = client.open_sftp()

    try:
        step_upload(client, sftp, args)
        step_pip(client, args)
        step_nginx(client, sftp, args)
        step_backend(client, sftp)
    finally:
        sftp.close()
        client.close()

    print("\nDeploy complete.", flush=True)
    print(f"  App -> http://{HOST}/", flush=True)
    print(f"  Log -> {DEPLOY_PATH}/backend.log", flush=True)


if __name__ == "__main__":
    main()
