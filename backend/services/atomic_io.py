"""Atomic JSON writes that tolerate Windows file-lock races.

On Windows, antivirus / Search-indexer real-time hooks briefly open a file
right after it is written or created. If `os.replace(tmp, dst)` (or an
in-place `open(dst, "w")`) runs inside that window it fails with
``PermissionError: [WinError 5] Access is denied`` — even though nothing
holds the file persistently. A busy long-running server hits this race far
more often than a one-shot script. Retrying for ~1s rides the lock out.
"""
from __future__ import annotations

import json
import os
import time


def atomic_write_json(path: str, data, *, indent: int = 2,
                      attempts: int = 20, delay: float = 0.05) -> None:
    """Write ``data`` as JSON to ``path`` atomically, retrying the final
    rename when Windows transiently denies it (WinError 5)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=indent)
    for i in range(attempts):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(delay)
