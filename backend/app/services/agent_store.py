from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import Any

from app.domain.models import AgentProfile, AgentPrompt, AgentPromptStatus
from app.storage.jsonl import data_dir, now_iso, read_jsonl, safe_room_slug


def _participant_slug(participant_id: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", participant_id).strip("_-")
    return slug or "participant"


def profile_path(room_name: str, participant_id: str) -> Path:
    return (
        data_dir()
        / "agent_profiles"
        / f"{safe_room_slug(room_name)}__{_participant_slug(participant_id)}.json"
    )


def load_profile(room_name: str, participant_id: str) -> AgentProfile | None:
    path = profile_path(room_name, participant_id)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return AgentProfile.model_validate(data)


def save_profile(profile: AgentProfile) -> AgentProfile:
    path = profile_path(profile.roomName, profile.participantId)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(profile.model_dump_json(indent=2), encoding="utf-8")
    return profile


def find_proxy_profile_for_room(room_name: str) -> AgentProfile | None:
    profiles_dir = data_dir() / "agent_profiles"
    if not profiles_dir.exists():
        return None
    slug = safe_room_slug(room_name)
    candidates: list[AgentProfile] = []
    for path in profiles_dir.glob(f"{slug}__*.json"):
        try:
            profile = AgentProfile.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            continue
        if profile.calibrationCompletedAt:
            candidates.append(profile)
    if not candidates:
        return None
    # Same room can have multiple proxy tokens (e.g. male/female arms). Use the
    # most recently active profile so prompts match the console session in use.
    candidates.sort(
        key=lambda p: (
            p.updatedAt or "",
            p.calibrationCompletedAt or "",
        ),
        reverse=True,
    )
    best = candidates[0]
    return best


def _prompts_path(room_name: str) -> Path:
    return data_dir() / "agent_prompts" / f"{safe_room_slug(room_name)}.prompts.jsonl"


def load_prompts(room_name: str) -> list[AgentPrompt]:
    rows = read_jsonl(_prompts_path(room_name))
    prompts: list[AgentPrompt] = []
    for row in rows:
        try:
            prompts.append(AgentPrompt.model_validate(row))
        except Exception:  # noqa: BLE001
            continue
    return prompts


def save_prompt(room_name: str, prompt: AgentPrompt) -> AgentPrompt:
    from app.storage.jsonl import append_jsonl

    append_jsonl(_prompts_path(room_name), prompt.model_dump(mode="json"))
    return prompt


def update_prompt(room_name: str, prompt_id: str, **updates: Any) -> AgentPrompt | None:
    from app.storage.jsonl import invalidate_jsonl_cache

    prompts = load_prompts(room_name)
    updated: AgentPrompt | None = None
    rebuilt: list[AgentPrompt] = []
    for prompt in prompts:
        if prompt.id == prompt_id:
            updated = prompt.model_copy(update={**updates, "updatedAt": now_iso()})
            rebuilt.append(updated)
        else:
            rebuilt.append(prompt)
    if updated is None:
        return None
    path = _prompts_path(room_name)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for prompt in rebuilt:
            fh.write(prompt.model_dump_json() + "\n")
    invalidate_jsonl_cache(path)
    return updated


def find_last_spoken_text(room_name: str, participant_id: str | None = None) -> str | None:
    """Most recent text Echo actually spoke in the meeting (excluding recap replies)."""
    best: AgentPrompt | None = None
    for prompt in load_prompts(room_name):
        if prompt.kind != "public_draft" or prompt.status != AgentPromptStatus.SPOKEN:
            continue
        if prompt.source == "meeting_recap":
            continue
        if participant_id and prompt.participantId != participant_id:
            continue
        if best is None or prompt.updatedAt >= best.updatedAt:
            best = prompt
    return best.text if best else None


def has_open_prompt(room_name: str) -> bool:
    for prompt in load_prompts(room_name):
        if prompt.status in (AgentPromptStatus.PENDING_PROXY, AgentPromptStatus.PENDING_APPROVAL):
            return True
    return False


def new_prompt_id() -> str:
    return f"prompt-{secrets.token_hex(6)}"
