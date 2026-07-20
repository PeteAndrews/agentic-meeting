from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_read_cache: dict[str, tuple[float, int, list[dict[str, Any]]]] = {}
_read_cache_lock = threading.Lock()


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    _ensure_parent(path)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    invalidate_jsonl_cache(path)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    key = str(path.resolve())
    try:
        stat = path.stat()
        mtime = stat.st_mtime
        size = stat.st_size
    except OSError:
        return []

    with _read_cache_lock:
        cached = _read_cache.get(key)
        if cached is not None and cached[0] == mtime and cached[1] == size:
            return cached[2]

    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))

    with _read_cache_lock:
        _read_cache[key] = (mtime, size, records)
    return records


def invalidate_jsonl_cache(path: Path) -> None:
    try:
        key = str(path.resolve())
    except OSError:
        return
    with _read_cache_lock:
        _read_cache.pop(key, None)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def data_dir() -> Path:
    # Default to backend/data, override via BACKEND_DATA_DIR.
    env = os.environ.get("BACKEND_DATA_DIR")
    if env:
        return Path(env).resolve()
    return (Path(__file__).resolve().parents[2] / "data").resolve()


def safe_room_slug(room_name: str) -> str:
    # Minimal sanitization for filenames.
    return "".join(ch for ch in room_name if ch.isalnum() or ch in ("-", "_")).strip("_-") or "room"
