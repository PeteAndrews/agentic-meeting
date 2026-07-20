from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class Condition(str, Enum):
    HH = "HH"
    HA = "HA"


class Role(str, Enum):
    MODERATOR = "moderator"  # User C
    ACTIVE = "active"  # User B
    SILENT = "silent"  # User A (HH only; muted)
    PROXY = "proxy"  # User A (HA only; Agent Console, no Jitsi)
    AGENT = "agent"  # embodied proxy participant (HA)


class ResolveTokenRequest(BaseModel):
    studyToken: str = Field(min_length=4, max_length=128)


TtsVoiceGender = Literal["male", "female"]


class ResolveTokenResponse(BaseModel):
    participantId: str
    role: Role
    condition: Condition
    roomName: str
    displayName: str
    voiceOutputMode: Optional[VoiceMode] = None
    scenario: Optional[str] = None
    calibrationDropQuestionIndex: Optional[int] = Field(default=None, ge=0, le=20)
    maxInterventions: int = Field(default=999, ge=1, le=9999)
    agentTriggerPhrases: list[str] = Field(default_factory=lambda: ["echo"])
    agentDisplayName: str = "Echo"
    ttsVoiceGender: Optional[TtsVoiceGender] = None


class SessionConfig(BaseModel):
    roomName: str
    condition: Condition
    agenda: list[str] = []
    sttEnabled: bool = True
    sttMode: Literal["browser", "server_per_client"] = "browser"
    sttRoles: list[Role] = [Role.MODERATOR, Role.ACTIVE]
    sttLanguage: str = Field(default="en-US", min_length=2, max_length=32)
    sttSendInterim: bool = False
    # Consent-friendly default: require explicit user action to enable mic/STT.
    sttRequireUserClick: bool = True
    # In HH, User A is present but should be muted and silent.
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
    source: Optional[Literal["browser", "server"]] = None


class AgentJoinRequest(BaseModel):
    roomName: str = Field(min_length=3, max_length=128)
    displayName: Optional[str] = Field(default=None, min_length=1, max_length=64)


class AgentLeaveRequest(BaseModel):
    roomName: Optional[str] = Field(default=None, min_length=3, max_length=128)


class AgentSpeakTestRequest(BaseModel):
    roomName: str = Field(min_length=3, max_length=128)


VoiceMode = Literal["generic_tts", "cloned_voice_tts", "manual_test_audio"]


class AgentSpeakRequest(BaseModel):
    roomName: str = Field(min_length=3, max_length=128)
    text: str = Field(min_length=1, max_length=4096)
    voiceMode: VoiceMode = "generic_tts"


class AgentStatusResponse(BaseModel):
    connected: bool
    roomName: Optional[str] = None
    displayName: Optional[str] = None
    phase: str = "phase_5c"
    mode: str = "unknown"


class AgentProfile(BaseModel):
    roomName: str
    participantId: str
    voiceOutputMode: VoiceMode = "generic_tts"
    voiceSampleStored: bool = False
    voiceSamplePath: Optional[str] = None
    voiceSampleRefText: Optional[str] = None
    scenario: Optional[str] = None
    droppedQuestionIndex: Optional[int] = Field(default=None, ge=0, le=20)
    calibrationAnswers: dict[str, str] = {}
    calibrationCompletedAt: Optional[str] = None
    interventionsUsed: int = Field(default=0, ge=0)
    maxInterventions: int = Field(default=999, ge=1, le=9999)
    agentTriggerPhrases: list[str] = Field(default_factory=lambda: ["echo"])
    agentDisplayName: str = "Echo"
    ttsVoiceGender: Optional[TtsVoiceGender] = None
    updatedAt: Optional[str] = None


class AgentProfileKey(BaseModel):
    roomName: str = Field(min_length=1, max_length=256)
    participantId: str = Field(min_length=1, max_length=128)


class AgentProfileUpdate(AgentProfileKey):
    voiceOutputMode: Optional[VoiceMode] = None
    scenario: Optional[str] = None
    droppedQuestionIndex: Optional[int] = Field(default=None, ge=0, le=20)
    maxInterventions: Optional[int] = Field(default=None, ge=1, le=9999)
    agentTriggerPhrases: Optional[list[str]] = None
    agentDisplayName: Optional[str] = None
    ttsVoiceGender: Optional[TtsVoiceGender] = None


class CalibrationQuestionView(BaseModel):
    id: str
    text: str
    index: int


class CalibrationPlanResponse(BaseModel):
    scenario: str
    displayName: str
    droppedQuestionIndex: Optional[int] = None
    questions: list[CalibrationQuestionView]
    answeredQuestionIds: list[str]
    complete: bool


class CalibrationAnswerRequest(AgentProfileKey):
    questionId: str = Field(min_length=1, max_length=32)
    answer: str = Field(min_length=1, max_length=2000)


class AgentPromptStatus(str, Enum):
    PENDING_PROXY = "pending_proxy"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    SPOKEN = "spoken"


class AgentPrompt(BaseModel):
    id: str
    roomName: str
    participantId: str
    kind: Literal["proxy_question", "public_draft"]
    text: str
    status: AgentPromptStatus
    interventionNumber: int = Field(ge=0)
    source: Literal["missing_calibration", "novel_topic", "moderator_disagreement", "known_calibration", "meeting_meta", "meeting_recap"]
    createdAt: str
    updatedAt: str
    triggerSegmentText: Optional[str] = None


class AgentPromptRespondRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)


class AgentPromptEditRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)


class AgentProfileCompleteResponse(BaseModel):
    profile: AgentProfile
    agentJoinOk: bool
    agentJoinError: Optional[str] = None
    agentJoin: Optional[dict[str, Any]] = None


class AgentProfileVoiceSampleRequest(AgentProfileKey):
    voiceOutputMode: Optional[VoiceMode] = None
    audioBase64: str = Field(min_length=16, max_length=8_000_000)
    mimeType: str = Field(default="audio/webm", min_length=3, max_length=64)

