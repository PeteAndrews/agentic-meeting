from unittest.mock import patch

from app.domain.models import AgentProfile
from app.services.agent_llm import format_proxy_reply_speech


def _profile() -> AgentProfile:
    return AgentProfile(
        roomName="am-demo-ha-trip",
        participantId="p-demo-C2-trip-male",
        voiceOutputMode="generic_tts",
        voiceSampleStored=False,
        scenario="weekend_trip",
        droppedQuestionIndex=2,
        calibrationAnswers={"q1": "The meridian at Leicester square"},
        calibrationCompletedAt="2026-07-02T19:20:16.776147+00:00",
    )


@patch("app.services.agent_llm.call_agent_llm_text")
def test_proxy_reply_polished_for_meeting(mock_llm):
    mock_llm.return_value = (
        "My user would prefer the Meridian near Leicester Square for the team dinner."
    )
    spoken = format_proxy_reply_speech(
        _profile(),
        trigger_text="Echo where should we eat tonight",
        proxy_reply="meridian leicester square",
        segments=[],
    )
    assert "Meridian" in spoken
    assert spoken != "meridian leicester square"
    mock_llm.assert_called_once()


@patch("app.services.agent_llm.call_agent_llm_text")
def test_proxy_reply_falls_back_to_raw_on_llm_error(mock_llm):
    from app.services.agent_llm import AgentLlmError

    mock_llm.side_effect = AgentLlmError("api down")
    raw = "We should book the flight simulator for tomorrow."
    spoken = format_proxy_reply_speech(
        _profile(),
        trigger_text="Echo what about tomorrow",
        proxy_reply=raw,
        segments=[],
    )
    assert spoken == raw
