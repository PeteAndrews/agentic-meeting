from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class Condition(str, Enum):
    HH = "HH"
    HA = "HA"


class Role(str, Enum):
    MODERATOR = "moderator"  # Person A
    ACTIVE = "active"  # Person B
    SILENT = "silent"  # Person C (HH only; muted)
    AGENT = "agent"  # embodied proxy participant (HA)


class ResolveTokenRequest(BaseModel):
    studyToken: str = Field(min_length=4, max_length=128)


class ResolveTokenResponse(BaseModel):
    participantId: str
    role: Role
    condition: Condition
    roomName: str
    displayName: str


class SessionConfig(BaseModel):
    roomName: str
    condition: Condition
    agenda: list[str] = []
    sttEnabled: bool = True
    sttRoles: list[Role] = [Role.MODERATOR, Role.ACTIVE]
    sttLanguage: str = Field(default="en-US", min_length=2, max_length=32)
    sttSendInterim: bool = False
    # Consent-friendly default: require explicit user action to enable mic/STT.
    sttRequireUserClick: bool = True
    # In HH, C is present but should be muted and silent.
    hhSilentRole: Role = Role.SILENT
    # Audio-first agent actions: speak/ask_clarification/wait (no chat UI).
    agentActions: list[Literal["speak", "ask_clarification", "wait"]] = [
        "speak",
        "ask_clarification",
        "wait",
    ]
    metadata: dict[str, Any] = {}


class LogEventRequest(BaseModel):
    roomName: str
    participantId: str
    role: Role
    condition: Condition
    tsMs: int = Field(ge=0)
    eventType: str = Field(min_length=1, max_length=128)
    payload: dict[str, Any] = {}


class TranscriptSegmentRequest(BaseModel):
    roomName: str
    participantId: str
    role: Role
    condition: Condition
    startMs: int = Field(ge=0)
    endMs: int = Field(ge=0)
    isFinal: bool = True
    text: str = Field(min_length=1, max_length=5000)
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)

