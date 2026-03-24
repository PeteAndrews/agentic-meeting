from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    _ensure_parent(path)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


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

