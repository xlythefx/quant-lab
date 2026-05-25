"""
TradeStation OAuth 2.0 Authorization Code Grant.

One-time bootstrap (needs a browser):
    python -m backend.services.brokers.tradestation.auth bootstrap

Headless refresh (any time after bootstrap):
    python -m backend.services.brokers.tradestation.auth refresh

The refresh token is non-expiring by default. One bootstrap should last
indefinitely unless the TS password changes or the key is revoked.
"""
from __future__ import annotations

import logging
import os
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional

import httpx
from dotenv import find_dotenv, load_dotenv, set_key

load_dotenv(find_dotenv(), override=False)

log = logging.getLogger(__name__)

_AUTHORIZE_URL = "https://signin.tradestation.com/authorize"
_TOKEN_URL     = "https://signin.tradestation.com/oauth/token"
_AUDIENCE      = "https://api.tradestation.com"
_SCOPES        = "openid offline_access MarketData"

# In-memory token cache: (access_token, expires_at_unix_seconds)
_cache: tuple[str, float] | None = None
_cache_lock = threading.Lock()


def _require(key: str) -> str:
    v = os.getenv(key, "").strip()
    if not v:
        raise EnvironmentError(
            f"{key} is not set. Add it to .env before running."
        )
    return v


def bootstrap() -> str:
    """One-time OAuth bootstrap. Opens a browser for user consent.

    Saves the refresh token back into .env and returns the access token.
    Must be run on a machine with a browser (your dev laptop, not a server).
    """
    client_id     = _require("TRADESTATION_CLIENT_ID")
    client_secret = _require("TRADESTATION_CLIENT_SECRET")
    redirect_uri  = os.getenv("TRADESTATION_REDIRECT_URI", "http://localhost:8080")

    state = secrets.token_urlsafe(16)

    params = {
        "response_type": "code",
        "client_id":     client_id,
        "audience":      _AUDIENCE,
        "redirect_uri":  redirect_uri,
        "scope":         _SCOPES,
        "state":         state,
    }
    auth_url = f"{_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"

    print(f"\nOpen this URL in your browser:\n\n  {auth_url}\n")
    try:
        import webbrowser
        webbrowser.open(auth_url)
    except Exception:
        pass

    # Catch the redirect on a local HTTP listener.
    result: dict = {}

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            returned_state = qs.get("state", [""])[0]
            code  = qs.get("code",  [""])[0]
            error = qs.get("error", [""])[0]

            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()

            if error:
                self.wfile.write(f"<h1>Error: {error}</h1>".encode())
                result["error"] = error
            elif returned_state != state:
                self.wfile.write(b"<h1>State mismatch - possible CSRF</h1>")
                result["error"] = "state_mismatch"
            else:
                self.wfile.write(b"<h1>Authorized! You can close this tab.</h1>")
                result["code"] = code

        def log_message(self, *_args):
            pass

    port = int(urllib.parse.urlparse(redirect_uri).port or 8080)
    server = HTTPServer(("localhost", port), _Handler)
    server.timeout = 120

    print("Waiting for TradeStation redirect (timeout 120s)...")
    while "code" not in result and "error" not in result:
        server.handle_request()
    server.server_close()

    if "error" in result:
        raise RuntimeError(f"OAuth error: {result['error']}")

    # Exchange authorization code for tokens.
    resp = httpx.post(_TOKEN_URL, data={
        "grant_type":    "authorization_code",
        "client_id":     client_id,
        "client_secret": client_secret,
        "code":          result["code"],
        "redirect_uri":  redirect_uri,
    })
    resp.raise_for_status()
    tokens = resp.json()

    refresh_token = tokens["refresh_token"]
    access_token  = tokens["access_token"]
    expires_in    = int(tokens.get("expires_in", 1200))

    env_path = find_dotenv()
    set_key(env_path, "TRADESTATION_REFRESH_TOKEN", refresh_token)
    log.info("refresh token saved to %s", env_path)
    print(f"\nRefresh token saved. Access token valid for {expires_in}s.")

    _store(access_token, expires_in)
    return access_token


def refresh() -> str:
    """Exchange the stored refresh token for a new access token (headless)."""
    client_id     = _require("TRADESTATION_CLIENT_ID")
    client_secret = _require("TRADESTATION_CLIENT_SECRET")
    refresh_token = _require("TRADESTATION_REFRESH_TOKEN")

    resp = httpx.post(_TOKEN_URL, data={
        "grant_type":    "refresh_token",
        "client_id":     client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
    })

    if resp.status_code == 401:
        raise RuntimeError(
            "Refresh token rejected (401) — it may have been revoked.\n"
            "Re-run: python -m backend.services.brokers.tradestation.auth bootstrap"
        )
    resp.raise_for_status()
    tokens = resp.json()

    access_token = tokens["access_token"]
    expires_in   = int(tokens.get("expires_in", 1200))
    _store(access_token, expires_in)
    return access_token


def get_access_token() -> str:
    """Return a valid access token, refreshing automatically when near expiry."""
    with _cache_lock:
        if _cache is not None:
            token, expires_at = _cache
            if time.time() < expires_at:
                return token
    return refresh()


def _store(token: str, expires_in: int) -> None:
    # Refresh 2 minutes before actual expiry to avoid mid-stream drops.
    with _cache_lock:
        global _cache
        _cache = (token, time.time() + expires_in - 120)


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "refresh"
    if cmd == "bootstrap":
        token = bootstrap()
        print(f"\nAccess token: {token}")
    elif cmd == "refresh":
        token = refresh()
        print(f"Access token: {token}")
    else:
        print("Usage: python -m backend.services.brokers.tradestation.auth [bootstrap|refresh]")
        sys.exit(1)
