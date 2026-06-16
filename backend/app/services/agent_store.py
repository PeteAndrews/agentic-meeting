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
    for path in profiles_dir.glob(f"{slug}__*.json"):
        try:
            profile = AgentProfile.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            continue
        if profile.calibrationCompletedAt:
            return profile
    return None


def _prompts_path(room_name: str) -> Path:
    return data_dir() / "agent_prompts" / f"{safe_room_slug(room_name)}.prompts.jsonl"


def load_prompts(room_name: str) -> list[AgentPrompt]:
    try:
        rows = read_jsonl(_prompts_path(room_name))
    except FileNotFoundError:
        return []
    prompts: list[AgentPrompt] = []
    for row in rows:
        try:
            prompts.append(AgentPrompt.model_validate(row))
        except Exception:  # noqa: BLE001
            continue
    return prompts


def save_prompt(room_name: str, prompt: AgentPrompt) -> AgentPrompt:
    path = _prompts_path(room_name)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(prompt.model_dump_json() + "\n")
    return prompt


def update_prompt(room_name: str, prompt_id: str, **updates: Any) -> AgentPrompt | None:
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
    return updated


def has_open_prompt(room_name: str) -> bool:
    for prompt in load_prompts(room_name):
        if prompt.status in (AgentPromptStatus.PENDING_PROXY, AgentPromptStatus.PENDING_APPROVAL):
            return True
    return False


def new_prompt_id() -> str:
    return f"prompt-{secrets.token_hex(6)}"
